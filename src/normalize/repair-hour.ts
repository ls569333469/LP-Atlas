import { getAddress, type PublicClient } from "viem";
import { errorText } from "../adapters/errors.ts";
import type { createPoolPriceReader, PoolQuote } from "../adapters/pool-price-reader.ts";
import type { V3PoolState, V4PoolState } from "../adapters/types.ts";
import { readV3PoolStates } from "../adapters/venues/elysium/uniswap-v3.ts";
import {
	readV4Reserves,
	readV4Slot0s,
	toV4PoolState,
} from "../adapters/venues/elysium/uniswap-v4.ts";
import { feeDataUsable } from "../shared/fee-quality.ts";
import type {
	StoredEvmPool as StoredPool,
	StoredEvmScannedHour as StoredScannedHour,
	StoredNativeWindow as StoredWindow,
} from "../store/types.ts";
import { buildPriceBridgeIndex, supplementUsdPrices } from "./price-bridges.ts";
import { buildUsdPrices, sumUsd, type UsdPricePolicy, valueRawUsd } from "./prices.ts";

/** Repair immutable ended hours without replaying their already valid swaps and fees. */
export async function repairClosedHour(input: {
	client: PublicClient;
	readers?: {
		readV3PoolStates: typeof readV3PoolStates;
		readV4Slot0s: typeof readV4Slot0s;
		readV4Reserves: typeof readV4Reserves;
		toV4PoolState: typeof toV4PoolState;
	};
	priceReaders?: {
		v3: ReturnType<typeof createPoolPriceReader>;
		v4: ReturnType<typeof createPoolPriceReader>;
	};
	pricePolicy?: UsdPricePolicy;
	pools: StoredPool[];
	poolById?: ReadonlyMap<string, StoredPool>;
	priceIndex?: ReturnType<typeof buildPriceBridgeIndex>;
	pricingPools?: StoredPool[];
	windows: StoredWindow[];
	deferredUsdPoolIds?: ReadonlySet<string>;
	completeCatalog?: boolean;
	hours: StoredScannedHour[];
	pricingAnchor: (token0: string, token1: string) => boolean;
	loadDecimals: (addresses: string[]) => Promise<Map<string, number>>;
}): Promise<{
	windows: StoredWindow[];
	hours: StoredScannedHour[];
	gaps: string[];
	deferrals?: Array<{ window: StoredWindow; reason: "zero_end_liquidity" | "no_historical_path" }>;
}> {
	const { client, pools, windows, hours, priceReaders } = input;
	const readers = input.readers ?? {
		readV3PoolStates,
		readV4Slot0s,
		readV4Reserves,
		toV4PoolState,
	};
	const gaps: string[] = [];
	const poolById = input.poolById ?? new Map(pools.map((pool) => [pool.poolId, pool]));
	const windowsByPool = new Map(windows.map((row) => [row.poolId, row]));
	const revalue =
		input.pricePolicy?.valuationVersion === 2 &&
		windows.some(
			(row) => row.usdValuationVersion !== 2 && !input.deferredUsdPoolIds?.has(row.poolId),
		);
	const tvlIds = new Set(
		windows
			.filter(
				(row) =>
					!input.deferredUsdPoolIds?.has(row.poolId) &&
					((revalue && row.usdValuationVersion !== 2) ||
						(row.tvlUsd === null && row.volumeUsd !== null)),
			)
			.map((row) => row.poolId),
	);
	const missingUsdIds = new Set(
		windows
			.filter(
				(row) =>
					!input.deferredUsdPoolIds?.has(row.poolId) &&
					((revalue && row.usdValuationVersion !== 2) ||
						row.volumeUsd === null ||
						row.lpFeesUsd === null),
			)
			.map((row) => row.poolId),
	);
	const repairUsd =
		revalue || (missingUsdIds.size > 0 && hours.some((hour) => hour.usdBridgeVersion !== 1));
	if (repairUsd)
		for (const row of windows) {
			if (missingUsdIds.has(row.poolId) && row.tvlUsd === null) tvlIds.add(row.poolId);
		}
	const firstHour = hours[0];
	if (!firstHour) return { windows: [], hours: [], gaps: [] };
	const endBlock = BigInt(firstHour.toBlock);
	const boundaryBlock = BigInt(firstHour.fromBlock) - 1n;
	const asV3Input = (pool: StoredPool) => ({
		poolAddress: getAddress(pool.poolAddress ?? pool.poolId),
		token0: getAddress(pool.token0),
		token1: getAddress(pool.token1),
	});
	let v3States = new Map<string, V3PoolState>();
	let v3Quotes = new Map<string, PoolQuote>();
	const v4States = new Map<string, V4PoolState>();
	let prices = new Map<string, import("decimal.js").default>();
	let decimals = new Map<string, number>();
	let usdBridgeComplete = false;
	if (tvlIds.size > 0 || repairUsd) {
		// Elysium retains its graph; Robinhood reads active pools and needed bridges.
		const activeIds = new Set(
			windows.filter((row) => !input.deferredUsdPoolIds?.has(row.poolId)).map((row) => row.poolId),
		);
		const candidatePools = input.pricingPools ?? pools;
		const v3 = candidatePools.filter(
			(pool) =>
				pool.protocol === "uniswap_v3" &&
				BigInt(pool.createdBlock) <= endBlock &&
				(!input.pricePolicy?.requireLiquidity ||
					activeIds.has(pool.poolId) ||
					input.pricingAnchor(pool.token0, pool.token1)),
		);
		const v4 = candidatePools.filter(
			(pool) =>
				pool.protocol === "uniswap_v4" &&
				BigInt(pool.createdBlock) <= endBlock &&
				(activeIds.has(pool.poolId) || input.pricingAnchor(pool.token0, pool.token1)),
		);
		try {
			v3States = await readers.readV3PoolStates(
				client,
				v3.filter((pool) => !priceReaders || tvlIds.has(pool.poolId)).map(asV3Input),
				endBlock,
			);
			if (priceReaders) {
				priceReaders.v3.seed(endBlock, v3States);
				v3Quotes = await priceReaders.v3.readQuotes(
					client,
					v3
						.filter((pool) => !tvlIds.has(pool.poolId))
						.map((pool) => pool.poolAddress ?? pool.poolId),
					endBlock,
				);
			}
			const slots = await readers.readV4Slot0s(
				client,
				v4.map((pool) => pool.poolId),
				endBlock,
			);
			priceReaders?.v4.seed(endBlock, slots);
			const reserves = await readers.readV4Reserves(
				client,
				v4
					.filter((pool) => tvlIds.has(pool.poolId))
					.map((pool) => ({
						...pool,
						token0: getAddress(pool.token0),
						token1: getAddress(pool.token1),
						hooks: pool.hooks ? getAddress(pool.hooks) : null,
					})),
				undefined,
				endBlock,
			);
			for (const pool of v4) {
				const state = readers.toV4PoolState(
					pool.poolId,
					slots.get(pool.poolId),
					reserves.get(pool.poolId),
				);
				if (state) v4States.set(pool.poolId, state);
				const gap = reserves.get(pool.poolId)?.gap;
				if (gap) gaps.push(`${pool.poolId}: ${gap}`);
			}
			decimals = await input.loadDecimals([
				...new Set(
					[...v3, ...v4].flatMap((pool) => [pool.token0.toLowerCase(), pool.token1.toLowerCase()]),
				),
			]);
			const priced = [...v3, ...v4].flatMap((pool) => {
				const state =
					pool.protocol === "uniswap_v3"
						? (v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase()) ??
							v3Quotes.get((pool.poolAddress ?? pool.poolId).toLowerCase()))
						: v4States.get(pool.poolId);
				const stored = windowsByPool.get(pool.poolId);
				const sqrtPriceX96 =
					state?.sqrtPriceX96 ?? (stored?.sqrtPriceEnd ? BigInt(stored.sqrtPriceEnd) : null);
				return sqrtPriceX96 === null
					? []
					: [
							{
								poolId: pool.poolId,
								token0: pool.token0,
								token1: pool.token1,
								sqrtPriceX96,
								liquidity: state?.liquidity ?? 0n,
							},
						];
			});
			prices = buildUsdPrices(priced, decimals, undefined, input.pricePolicy);
			if (repairUsd && (input.pricePolicy?.stable.length ?? 1) > 0) {
				const supplement = await supplementUsdPrices({
					client,
					readSlots: readers.readV4Slot0s,
					readV3States: priceReaders
						? (client, pools, block) =>
								priceReaders.v3.readQuotes(
									client,
									pools.map((pool) => pool.poolAddress),
									block,
								)
						: input.pricePolicy?.requireLiquidity
							? readers.readV3PoolStates
							: undefined,
					readV4Quotes: priceReaders?.v4.readQuotes,
					pricePolicy: input.pricePolicy,
					pools,
					index: input.priceIndex,
					blockNumber: endBlock,
					prices,
					pricedPools: priced,
					loadedPoolIds: new Set([
						...v3
							.filter(
								(pool) =>
									v3States.has((pool.poolAddress ?? pool.poolId).toLowerCase()) ||
									v3Quotes.has((pool.poolAddress ?? pool.poolId).toLowerCase()),
							)
							.map((pool) => pool.poolId),
						...slots.keys(),
					]),
					neededTokens: windows
						.filter((row) => missingUsdIds.has(row.poolId))
						.flatMap((row) => {
							const pool = poolById.get(row.poolId);
							return pool ? [pool.token0, pool.token1] : [];
						}),
					decimals,
					loadDecimals: input.loadDecimals,
				});
				prices = supplement.prices;
				usdBridgeComplete = supplement.complete;
				if (!supplement.complete)
					gaps.push(`小时 ${firstHour.windowStart} 美元报价桥状态或代币资料仍缺失`);
			}
		} catch (error) {
			gaps.push(`小时 ${firstHour.windowStart} 状态或美元价格定向补读失败：${errorText(error)}`);
		}
	}
	const records = windows.flatMap((old) => {
		const pool = poolById.get(old.poolId);
		return pool ? [{ pool, old, row: { ...old } }] : [];
	});
	const repairedHours: StoredScannedHour[] = [];
	for (const hour of hours) {
		const rows = records.filter(({ pool }) => pool.protocol === hour.protocol);
		if (hour.priceBoundaryVersion === 1) continue;
		for (const { pool, row } of rows) {
			if (BigInt(pool.createdBlock) > boundaryBlock) row.sqrtPriceStart = null;
		}
		const needed = rows.filter(
			({ pool, row }) =>
				(hour.priceBoundaryVersion !== 2 || row.sqrtPriceStart === null) &&
				BigInt(pool.createdBlock) <= boundaryBlock,
		);
		try {
			const priceReader = hour.protocol === "uniswap_v3" ? priceReaders?.v3 : priceReaders?.v4;
			const boundary = priceReader
				? await priceReader.readBoundaries(
						client,
						needed.map(({ pool }) =>
							hour.protocol === "uniswap_v3"
								? (pool.poolAddress ?? pool.poolId).toLowerCase()
								: pool.poolId,
						),
						boundaryBlock,
					)
				: hour.protocol === "uniswap_v3"
					? await readers.readV3PoolStates(
							client,
							needed.map(({ pool }) => asV3Input(pool)),
							boundaryBlock,
						)
					: await readers.readV4Slot0s(
							client,
							needed.map(({ pool }) => pool.poolId),
							boundaryBlock,
						);
			for (const { pool, row } of needed) {
				// An old first-Swap price is invalid even when this boundary read fails.
				row.sqrtPriceStart =
					boundary
						.get(
							pool.protocol === "uniswap_v3"
								? (pool.poolAddress ?? pool.poolId).toLowerCase()
								: row.poolId,
						)
						?.sqrtPriceX96.toString() ?? null;
			}
		} catch (error) {
			for (const { row } of needed) row.sqrtPriceStart = null;
			gaps.push(`小时 ${hour.windowStart} ${hour.protocol} 起始价格补读失败：${errorText(error)}`);
		}
		const complete = rows.every(
			({ pool, row }) => BigInt(pool.createdBlock) > boundaryBlock || row.sqrtPriceStart !== null,
		);
		repairedHours.push({ ...hour, priceBoundaryVersion: complete ? 1 : 2 });
		if (!complete) gaps.push(`小时 ${hour.windowStart} ${hour.protocol} 起始价格仍有缺口`);
	}
	for (const { pool, row } of records.filter(({ row }) => tvlIds.has(row.poolId))) {
		const tvl = tvlForPool(pool, v3States, v4States, prices, decimals);
		if (tvl !== null) {
			row.tvlUsd = tvl.toString();
			row.gapReason = null;
		} else gaps.push(`${row.poolId}: 小时 ${row.windowStart} TVL 定向补读后仍缺失`);
	}
	if (repairUsd) {
		for (const { pool, row } of records.filter(({ row }) => missingUsdIds.has(row.poolId))) {
			if (!revalue && row.volumeUsd === null) {
				const volume = sumUsd(
					valueRawUsd(BigInt(row.volume0), pool.token0, prices, decimals),
					valueRawUsd(BigInt(row.volume1), pool.token1, prices, decimals),
				);
				row.volumeUsd = volume?.div(2).toString() ?? (revalue ? row.volumeUsd : null);
			}
			if (
				!revalue &&
				row.lpFeesUsd === null &&
				feeDataUsable(row.feeStatus ?? "legacy_unverified")
			) {
				row.lpFeesUsd =
					sumUsd(
						valueRawUsd(BigInt(row.lpFees0), pool.token0, prices, decimals),
						valueRawUsd(BigInt(row.lpFees1), pool.token1, prices, decimals),
					)?.toString() ?? (revalue ? row.lpFeesUsd : null);
			}
		}

		if (revalue) {
			for (const { pool, old, row } of records.filter(
				({ old }) => old.usdValuationVersion !== 2 && !input.deferredUsdPoolIds?.has(old.poolId),
			)) {
				const volume = sumUsd(
					valueRawUsd(BigInt(row.volume0), pool.token0, prices, decimals),
					valueRawUsd(BigInt(row.volume1), pool.token1, prices, decimals),
				);
				const fees = feeDataUsable(row.feeStatus ?? "legacy_unverified")
					? sumUsd(
							valueRawUsd(BigInt(row.lpFees0), pool.token0, prices, decimals),
							valueRawUsd(BigInt(row.lpFees1), pool.token1, prices, decimals),
						)
					: null;
				const tvl = tvlForPool(pool, v3States, v4States, prices, decimals);
				if (volume !== null && fees !== null && tvl !== null) {
					row.volumeUsd = volume.div(2).toString();
					row.lpFeesUsd = fees.toString();
					row.tvlUsd = tvl.toString();
					row.usdValuationVersion = 2;
				} else {
					row.volumeUsd = old.volumeUsd;
					row.lpFeesUsd = old.lpFeesUsd;
					row.tvlUsd = old.tvlUsd;
					row.gapReason = old.gapReason;
					gaps.push(
						`${row.poolId}: 小时 ${row.windowStart} 美元重估仍缺价格、费用状态或历史储备，保留旧计价版本`,
					);
				}
			}
		}
		if (usdBridgeComplete)
			for (const hour of hours) {
				const repaired = repairedHours.find((row) => row.protocol === hour.protocol);
				if (repaired) repaired.usdBridgeVersion = 1;
				else repairedHours.push({ ...hour, usdBridgeVersion: 1 });
			}
	}
	if (input.pricePolicy?.valuationVersion === 2) {
		for (const hour of hours) {
			let result = repairedHours.find((row) => row.protocol === hour.protocol);
			if (!result) {
				result = { ...hour };
				repairedHours.push(result);
			}
			result.usdValuationVersion = records
				.filter(({ pool }) => pool.protocol === hour.protocol)
				.every(({ row }) => row.usdValuationVersion === 2)
				? 2
				: null;
			result.usdQuote = input.pricePolicy.quote;
		}
	}
	// Missing state, decimals, fee data or a failed quote must remain retryable.
	const deferrals: Array<{
		window: StoredWindow;
		reason: "zero_end_liquidity" | "no_historical_path";
	}> = [];
	if (input.pricePolicy?.quote && usdBridgeComplete) {
		let edges: ReturnType<typeof buildPriceBridgeIndex> | undefined;
		const connectivity = new Map<string, boolean>();
		const hasCatalogPath = (start: string): boolean => {
			if (connectivity.has(start)) return connectivity.get(start) === true;
			edges ??= input.priceIndex ?? buildPriceBridgeIndex(pools);
			const seen = new Set([start]);
			const queue = [start];
			let reachable = false;
			for (let i = 0; i < queue.length; i++) {
				const token = queue[i] as string;
				if (prices.has(token)) {
					reachable = true;
					break;
				}
				for (const pool of edges.get(token) ?? []) {
					if (BigInt(pool.createdBlock) > endBlock) continue;
					const other = (
						pool.token0.toLowerCase() === token ? pool.token1 : pool.token0
					).toLowerCase();
					if (!seen.has(other)) {
						seen.add(other);
						queue.push(other);
					}
				}
			}
			// An exhausted component shares the same disconnected result.
			if (!reachable) for (const token of seen) connectivity.set(token, false);
			else connectivity.set(start, true);
			return reachable;
		};
		for (const { pool, row } of records) {
			const state =
				pool.protocol === "uniswap_v3"
					? v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase())
					: v4States.get(pool.poolId);
			const tokens = [pool.token0.toLowerCase(), pool.token1.toLowerCase()];
			const missing = tokens.filter((token) => !prices.has(token));
			if (
				input.deferredUsdPoolIds?.has(row.poolId) ||
				row.usdValuationVersion === 2 ||
				!feeDataUsable(row.feeStatus ?? "legacy_unverified") ||
				!state ||
				state.amount0 === null ||
				state.amount1 === null ||
				tokens.some((token) => !decimals.has(token)) ||
				missing.length === 0
			)
				continue;
			if (input.pricePolicy.requireLiquidity && state.liquidity === 0n)
				deferrals.push({ window: row, reason: "zero_end_liquidity" });
			else if (input.completeCatalog && missing.some((token) => !hasCatalogPath(token)))
				deferrals.push({ window: row, reason: "no_historical_path" });
		}
	}

	return {
		deferrals,
		windows: records
			.filter(
				({ old, row }) =>
					old.usdValuationVersion !== row.usdValuationVersion ||
					old.tvlUsd !== row.tvlUsd ||
					old.sqrtPriceStart !== row.sqrtPriceStart ||
					old.volumeUsd !== row.volumeUsd ||
					old.lpFeesUsd !== row.lpFeesUsd,
			)
			.map(({ row }) => row),
		hours: repairedHours,
		gaps,
	};
}

export function tvlForPool(
	pool: StoredPool,
	v3States: Map<string, V3PoolState>,
	v4States: Map<string, V4PoolState>,
	prices: Map<string, import("decimal.js").default>,
	decimals: Map<string, number>,
): import("decimal.js").default | null {
	const state =
		pool.protocol === "uniswap_v3"
			? v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase())
			: v4States.get(pool.poolId);
	if (!state || state.amount0 === null || state.amount1 === null) return null;
	return sumUsd(
		valueRawUsd(state.amount0, pool.token0, prices, decimals),
		valueRawUsd(state.amount1, pool.token1, prices, decimals),
	);
}
