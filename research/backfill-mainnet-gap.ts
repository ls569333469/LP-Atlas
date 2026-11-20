import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createPublicClient, getAddress, http } from "viem";
import { findBlockAtOrAfter, readChainHead } from "../src/adapters/blocks.ts";
import { errorText } from "../src/adapters/errors.ts";
import { knownToken, loadTokenMetadata, normalizeTokenAddress } from "../src/adapters/tokens.ts";
import type {
	DiscoveredPool,
	TokenMetadata,
	V3PoolState,
	V4PoolState,
} from "../src/adapters/types.ts";
import {
	discoverV3Pools,
	loadV3Swaps,
	readV3PoolStates,
} from "../src/adapters/venues/elysium/uniswap-v3.ts";
import {
	discoverV4Pools,
	loadV4Swaps,
	readV4Reserves,
	readV4Slot0s,
	toV4PoolState,
} from "../src/adapters/venues/elysium/uniswap-v4.ts";
import { poolFeeStatus } from "../src/normalize/fee-quality.ts";
import { supplementUsdPrices } from "../src/normalize/price-bridges.ts";
import { buildUsdPrices, sumUsd, valueRawUsd } from "../src/normalize/prices.ts";
import { resolveOneHour } from "../src/normalize/refresh-hours.ts";
import { tvlForPool } from "../src/normalize/repair-hour.ts";
import { accumulateSwapWindows, applyV4ProtocolFees } from "../src/normalize/windows-from-swaps.ts";
import { elysiumMainnet } from "../src/shared/chain.ts";
import {
	CHAIN_ID_ELYSIUM,
	ELYSIUM_PUBLIC_RPC_URL,
	ELYSIUM_USDC_ADDRESS,
	ELYSIUM_WHYPE_ADDRESS,
	HOUR_SECONDS as H,
	METRIC_SOURCE_SELF_BUILT,
	RPC_SOURCE_PUBLIC_TEMPORARY,
	ZERO_ADDRESS,
} from "../src/shared/constants.ts";
import { openDatabase, setMeta } from "../src/store/db.ts";
import {
	getToken,
	listPools,
	listTokensForPools,
	listWindowsInRange,
	upsertScannedHour,
	upsertToken,
	upsertWindow,
} from "../src/store/repositories.ts";
import type { StoredPool, StoredScannedHour, StoredWindow } from "../src/store/types.ts";
import { type Dataset, normalizeHour, qualifies } from "./engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "outputs/signal-research/v2026-11-13-mainnet");
const researchDbPath = path.join(outDir, "gap-research.db");
if (!researchDbPath.includes("v2026-11-13-mainnet")) throw new Error("拒绝在研究目录之外打开库");
const progressPath = path.join(outDir, "gap-backfill-progress.json");
const GAP_START = Date.parse("2026-11-08T16:00:00.000Z") / 1000;
const GAP_END = Date.parse("2026-11-09T14:00:00.000Z") / 1000;
const DEADLINE_MS = Date.now() + 28 * 60 * 1000;
const shanghai = (unix: number): string =>
	new Date((unix + 8 * H) * 1000).toISOString().replace("T", " ").slice(0, 16);
const toAddress = (value: string): Address => getAddress(value);
const isPricingAnchor = (token0: string, token1: string): boolean => {
	const tokens = [token0.toLowerCase(), token1.toLowerCase()];
	const hypes = new Set([ZERO_ADDRESS.toLowerCase(), ELYSIUM_WHYPE_ADDRESS.toLowerCase()]);
	return (
		tokens.includes(ELYSIUM_USDC_ADDRESS.toLowerCase()) && tokens.some((token) => hypes.has(token))
	);
};
const uniquePools = (pools: StoredPool[]): StoredPool[] => [
	...new Map(pools.map((p) => [p.poolId, p])).values(),
];

type Progress = {
	startedAt: string;
	updatedAt: string;
	rpcHost: string;
	rpcKind: typeof RPC_SOURCE_PUBLIC_TEMPORARY;
	discover?: { v3: number; v4: number; toBlock: string };
	blocks?: Record<string, string>;
	hours: Record<
		string,
		{
			status: string;
			windows: number;
			swapsV3: number;
			swapsV4: number;
			error?: string;
			ms: number;
		}
	>;
	stoppedReason?: string;
};

async function loadProgress(): Promise<Progress> {
	try {
		return JSON.parse(await fs.readFile(progressPath, "utf8")) as Progress;
	} catch {
		return {
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			rpcHost: new URL(ELYSIUM_PUBLIC_RPC_URL).host,
			rpcKind: RPC_SOURCE_PUBLIC_TEMPORARY,
			hours: {},
		};
	}
}
async function saveProgress(progress: Progress) {
	progress.updatedAt = new Date().toISOString();
	await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));
}

const client = createPublicClient({
	chain: elysiumMainnet,
	transport: http(ELYSIUM_PUBLIC_RPC_URL, {
		timeout: 20_000,
		fetchOptions: { headers: { "user-agent": "lp-atlas-research/mainnet-gap-backfill" } },
		retryCount: 0,
	}),
});
const db = await openDatabase(researchDbPath);
const progress = await loadProgress();
const gaps: string[] = [];
const tokenCache = new Map<string, TokenMetadata>();

async function persistDiscovered(pools: DiscoveredPool[]) {
	const now = new Date().toISOString();
	const sql = `INSERT INTO pools (
		pool_id, chain_id, protocol, token0, token1, fee_pips, tick_spacing,
		hooks, pool_address, created_block, created_at_unix, discovered_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(pool_id) DO UPDATE SET
		created_at_unix = COALESCE(pools.created_at_unix, excluded.created_at_unix)`;
	for (let i = 0; i < pools.length; i += 400) {
		const slice = pools.slice(i, i + 400);
		await db.batch(
			slice.map((pool) => ({
				sql,
				args: [
					pool.poolId,
					CHAIN_ID_ELYSIUM,
					pool.protocol,
					pool.token0.toLowerCase(),
					pool.token1.toLowerCase(),
					pool.feePips,
					pool.tickSpacing,
					pool.hooks,
					pool.poolAddress,
					Number(pool.createdBlock),
					null,
					now,
				],
			})),
			"write",
		);
	}
}

async function loadAndStoreTokens(addresses: string[]): Promise<Map<string, TokenMetadata>> {
	const cached = new Map<string, TokenMetadata>();
	const persisted = new Set<string>();
	for (const raw of new Set(addresses)) {
		const address = raw.toLowerCase();
		const inRun = tokenCache.get(`${CHAIN_ID_ELYSIUM}:${address}`);
		if (inRun) {
			cached.set(address, inRun);
			persisted.add(address);
			continue;
		}
		const known = knownToken(address, CHAIN_ID_ELYSIUM);
		if (known) cached.set(address, known);
		else {
			const row = await getToken(db, CHAIN_ID_ELYSIUM, address);
			if (row) {
				persisted.add(address);
				cached.set(address, {
					address: toAddress(row.address === ZERO_ADDRESS ? ZERO_ADDRESS : row.address),
					symbol: row.symbol,
					decimals: row.decimals,
					name: row.name,
				});
			}
		}
	}
	const loaded = await loadTokenMetadata(client, addresses, cached);
	for (const token of loaded.values()) {
		tokenCache.set(`${CHAIN_ID_ELYSIUM}:${token.address.toLowerCase()}`, token);
		if (persisted.has(token.address.toLowerCase())) continue;
		await upsertToken(db, {
			chainId: CHAIN_ID_ELYSIUM,
			address: token.address.toLowerCase(),
			symbol: token.symbol,
			decimals: token.decimals,
			name: token.name,
		});
	}
	return loaded;
}

try {
	const head = await readChainHead(client);
	const gapEndBlock = await findBlockAtOrAfter(client, GAP_END, head, 1n, Date.now() + 90_000);
	console.log(
		JSON.stringify({
			phase: "head",
			block: head.blockNumber.toString(),
			gapEndBlock: gapEndBlock.toString(),
			label: shanghai(GAP_END),
		}),
	);

	if (!progress.discover) {
		console.log(
			"discovering pools up to gap end (metadata only; pre-mainnet hours are not written)",
		);
		const discoveredV3 = await discoverV3Pools(
			client,
			0n,
			gapEndBlock - 1n,
			Date.now() + 8 * 60_000,
		);
		await persistDiscovered(discoveredV3);
		const discoveredV4 = await discoverV4Pools(
			client,
			0n,
			gapEndBlock - 1n,
			Date.now() + 8 * 60_000,
		);
		await persistDiscovered(discoveredV4);
		await setMeta(db, "v3_discover_block", (gapEndBlock - 1n).toString());
		await setMeta(db, "v4_discover_block", (gapEndBlock - 1n).toString());
		progress.discover = {
			v3: discoveredV3.length,
			v4: discoveredV4.length,
			toBlock: (gapEndBlock - 1n).toString(),
		};
		await saveProgress(progress);
		console.log(JSON.stringify({ phase: "discover", ...progress.discover }));
	}

	const allPools = await listPools(db);
	const v3Pools = allPools.filter((p) => p.protocol === "uniswap_v3" && p.poolAddress);
	const v4Pools = allPools.filter((p) => p.protocol === "uniswap_v4");
	const pricingV4 = v4Pools.filter((p) => isPricingAnchor(p.token0, p.token1));
	const poolById = new Map(allPools.map((p) => [p.poolId, p]));
	const hourStarts: number[] = [];
	for (let t = GAP_START; t < GAP_END; t += H) hourStarts.push(t);
	progress.blocks ??= {};

	const hourBounds = new Map<number, { fromBlock: string; toBlock: string; complete: boolean }>();
	for (const start of hourStarts) {
		const key = String(start);
		if (!progress.blocks[key] || !progress.blocks[String(start + H)]) {
			if (Date.now() > DEADLINE_MS) {
				progress.stoppedReason = "deadline_during_block_align";
				await saveProgress(progress);
				break;
			}
			const fromHint = BigInt(
				progress.blocks[key] ?? progress.blocks[String(start - H)] ?? 2_000_000,
			);
			const startBlock = progress.blocks[key]
				? BigInt(progress.blocks[key] as string)
				: await findBlockAtOrAfter(
						client,
						start,
						head,
						fromHint > 0n ? fromHint : 1n,
						Date.now() + 60_000,
					);
			progress.blocks[key] = startBlock.toString();
			const endBlock = progress.blocks[String(start + H)]
				? BigInt(progress.blocks[String(start + H)] as string)
				: start + H === GAP_END
					? gapEndBlock
					: await findBlockAtOrAfter(client, start + H, head, startBlock, Date.now() + 60_000);
			progress.blocks[String(start + H)] = endBlock.toString();
			await saveProgress(progress);
		}
		hourBounds.set(start, {
			fromBlock: progress.blocks[key] as string,
			toBlock: (BigInt(progress.blocks[String(start + H)] as string) - 1n).toString(),
			complete: true,
		});
	}

	for (const startUnix of hourStarts) {
		if (progress.hours[String(startUnix)]?.status === "ok") continue;
		if (Date.now() > DEADLINE_MS) {
			progress.stoppedReason = "deadline_before_hour " + shanghai(startUnix);
			await saveProgress(progress);
			break;
		}
		const started = Date.now();
		try {
			const window = await resolveOneHour({
				client,
				head,
				startUnix,
				knownBounds: hourBounds.get(startUnix),
				previousBounds: hourBounds.get(startUnix - H),
				nextBounds: hourBounds.get(startUnix + H),
			});
			if (!window) throw new Error("无法对齐小时区块");
			const pendingWindows: StoredWindow[] = [];
			const v3States = await readV3PoolStates(
				client,
				v3Pools
					.filter((pool) => BigInt(pool.createdBlock) <= window.toBlock)
					.map((pool) => ({
						poolAddress: toAddress(pool.poolAddress as string),
						token0: toAddress(pool.token0),
						token1: toAddress(pool.token1),
					})),
				window.toBlock,
			);
			const v3SwapInputs = v3Pools.flatMap((pool) => {
				if (!pool.poolAddress) return [];
				const state = v3States.get(pool.poolAddress.toLowerCase());
				return [
					{
						poolAddress: toAddress(pool.poolAddress),
						feePips: pool.feePips,
						feeProtocol0: state?.feeProtocol0 ?? 0,
						feeProtocol1: state?.feeProtocol1 ?? 0,
					},
				];
			});
			const hourV3 = v3SwapInputs.length
				? await loadV3Swaps(
						client,
						v3SwapInputs,
						window.fromBlock,
						window.toBlock,
						Date.now() + 120_000,
					)
				: [];
			const hourV4 = await loadV4Swaps(
				client,
				window.fromBlock,
				window.toBlock,
				new Map(),
				Date.now() + 180_000,
			);
			const activeV4Ids = new Set(hourV4.map((swap) => swap.poolId));
			const neededV4 = uniquePools([
				...v4Pools.filter((pool) => activeV4Ids.has(pool.poolId)),
				...pricingV4,
			]).filter((pool) => BigInt(pool.createdBlock) <= window.toBlock);
			const v4Slot0s = await readV4Slot0s(
				client,
				neededV4.map((pool) => pool.poolId),
				window.toBlock,
			);
			const reserves = await readV4Reserves(
				client,
				neededV4
					.filter((pool) => activeV4Ids.has(pool.poolId))
					.map((pool) => ({
						poolId: pool.poolId,
						token0: toAddress(pool.token0),
						token1: toAddress(pool.token1),
						feePips: pool.feePips,
						tickSpacing: pool.tickSpacing,
						hooks: pool.hooks ? toAddress(pool.hooks) : null,
					})),
				undefined,
				window.toBlock,
			);
			const v4States = new Map<string, V4PoolState>();
			for (const pool of neededV4) {
				const state = toV4PoolState(
					pool.poolId,
					v4Slot0s.get(pool.poolId),
					reserves.get(pool.poolId),
				);
				if (state) v4States.set(pool.poolId, state);
			}
			const protocolFeeByPool = new Map<string, number>();
			for (const [poolId, slot] of v4Slot0s) protocolFeeByPool.set(poolId, slot.protocolFee);
			applyV4ProtocolFees(hourV4, protocolFeeByPool);

			const tokenAddresses = new Set<string>();
			for (const pool of [...v3Pools, ...neededV4]) {
				tokenAddresses.add(normalizeTokenAddress(pool.token0));
				tokenAddresses.add(normalizeTokenAddress(pool.token1));
			}
			const tokenMap = await loadAndStoreTokens([...tokenAddresses]);
			const decimals = new Map<string, number>();
			for (const [address, token] of tokenMap) decimals.set(address, token.decimals);

			const aggregated = accumulateSwapWindows([...hourV3, ...hourV4], [window]);
			const boundaryBlock = window.fromBlock - 1n;
			const activeIds = new Set([...aggregated.values()].map((acc) => acc.poolId));
			const boundaryV3Pools = v3Pools.filter(
				(pool) => activeIds.has(pool.poolId) && BigInt(pool.createdBlock) <= boundaryBlock,
			);
			const boundaryV4Pools = v4Pools.filter(
				(pool) => activeIds.has(pool.poolId) && BigInt(pool.createdBlock) <= boundaryBlock,
			);
			let boundaryV3 = new Map<string, V3PoolState>();
			let boundaryV4: Awaited<ReturnType<typeof readV4Slot0s>> = new Map();
			try {
				boundaryV3 = await readV3PoolStates(
					client,
					boundaryV3Pools.map((pool) => ({
						poolAddress: toAddress(pool.poolAddress as string),
						token0: toAddress(pool.token0),
						token1: toAddress(pool.token1),
					})),
					boundaryBlock,
				);
			} catch (error) {
				gaps.push(`V3 起始价格读取失败 ${shanghai(startUnix)}：${errorText(error)}`);
			}
			try {
				boundaryV4 = await readV4Slot0s(
					client,
					boundaryV4Pools.map((p) => p.poolId),
					boundaryBlock,
				);
			} catch (error) {
				gaps.push(`V4 起始价格读取失败 ${shanghai(startUnix)}：${errorText(error)}`);
			}

			const pricedPools = [
				...v3Pools.flatMap((pool) => {
					const state = v3States.get((pool.poolAddress ?? pool.poolId).toLowerCase());
					if (!state) return [];
					return [
						{
							token0: pool.token0,
							token1: pool.token1,
							sqrtPriceX96: state.sqrtPriceX96,
							liquidity: state.liquidity,
						},
					];
				}),
				...neededV4.flatMap((pool) => {
					const state = v4States.get(pool.poolId) ?? v4Slot0s.get(pool.poolId);
					if (!state) return [];
					return [
						{
							token0: pool.token0,
							token1: pool.token1,
							sqrtPriceX96: state.sqrtPriceX96,
							liquidity: "liquidity" in state ? state.liquidity : 0n,
						},
					];
				}),
			];
			for (const acc of aggregated.values()) {
				const pool = poolById.get(acc.poolId);
				if (!pool || !acc.sqrtPriceEnd) continue;
				const hasState =
					pool.protocol === "uniswap_v3"
						? v3States.has((pool.poolAddress ?? pool.poolId).toLowerCase())
						: v4States.has(pool.poolId) || v4Slot0s.has(pool.poolId);
				if (hasState) continue;
				pricedPools.push({
					token0: pool.token0,
					token1: pool.token1,
					sqrtPriceX96: acc.sqrtPriceEnd,
					liquidity: 0n,
				});
			}
			let usdPrices = buildUsdPrices(pricedPools, decimals);
			let usdBridgeComplete = false;
			try {
				const supplement = await supplementUsdPrices({
					client,
					pools: allPools,
					blockNumber: window.toBlock,
					prices: usdPrices,
					pricedPools,
					loadedPoolIds: new Set([...v3States.keys(), ...v4Slot0s.keys()]),
					neededTokens: [...activeIds].flatMap((id) => {
						const pool = poolById.get(id);
						return pool ? [pool.token0, pool.token1] : [];
					}),
					decimals,
					loadDecimals: async (addresses) => {
						const tokens = await loadAndStoreTokens(addresses);
						return new Map([...tokens].map(([address, token]) => [address, token.decimals]));
					},
				});
				usdPrices = supplement.prices;
				usdBridgeComplete = supplement.complete;
			} catch (error) {
				gaps.push(`美元桥补读失败 ${shanghai(startUnix)}：${errorText(error)}`);
			}

			const asOf = new Date(head.timestamp * 1000).toISOString();
			for (const acc of aggregated.values()) {
				const pool = poolById.get(acc.poolId);
				if (!pool) continue;
				const tvlUsd = tvlForPool(pool, v3States, v4States, usdPrices, decimals);
				const volumeUsd = sumUsd(
					valueRawUsd(acc.volume0, pool.token0, usdPrices, decimals),
					valueRawUsd(acc.volume1, pool.token1, usdPrices, decimals),
				);
				const volumeUsdHonest = volumeUsd?.gt(0) ? volumeUsd.div(2) : volumeUsd;
				const feesUsd = sumUsd(
					valueRawUsd(acc.lpFees0, pool.token0, usdPrices, decimals),
					valueRawUsd(acc.lpFees1, pool.token1, usdPrices, decimals),
				);
				const feeStatus = poolFeeStatus(pool, {
					feeStatus:
						(pool.protocol === "uniswap_v4" && !v4Slot0s.has(pool.poolId)) ||
						(pool.protocol === "uniswap_v3" && !v3States.has(pool.poolId.toLowerCase()))
							? "protocol_state_missing"
							: "estimated",
					lpFees0: acc.lpFees0.toString(),
					lpFees1: acc.lpFees1.toString(),
				});
				pendingWindows.push({
					poolId: acc.poolId,
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: window.complete,
					volume0: acc.volume0.toString(),
					volume1: acc.volume1.toString(),
					lpFees0: acc.lpFees0.toString(),
					lpFees1: acc.lpFees1.toString(),
					swapCount: acc.swapCount,
					volumeUsd: volumeUsdHonest?.toString() ?? null,
					lpFeesUsd: feesUsd?.toString() ?? null,
					feeStatus,
					tvlUsd: tvlUsd?.toString() ?? null,
					sqrtPriceStart:
						(pool.protocol === "uniswap_v3"
							? boundaryV3.get((pool.poolAddress ?? pool.poolId).toLowerCase())?.sqrtPriceX96
							: boundaryV4.get(pool.poolId)?.sqrtPriceX96
						)?.toString() ?? null,
					sqrtPriceEnd: acc.sqrtPriceEnd?.toString() ?? null,
					source: METRIC_SOURCE_SELF_BUILT,
					asOf,
					gapReason: tvlUsd === null ? "缺少 TVL 或美元价格，相关指标留空" : null,
				});
			}

			const v3BoundaryComplete = boundaryV3Pools.every((pool) =>
				boundaryV3.has((pool.poolAddress as string).toLowerCase()),
			);
			const v4BoundaryComplete = boundaryV4Pools.every((pool) => boundaryV4.has(pool.poolId));
			const hours: StoredScannedHour[] = [
				{
					chainId: CHAIN_ID_ELYSIUM,
					protocol: "uniswap_v3",
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: true,
					fromBlock: window.fromBlock.toString(),
					toBlock: window.toBlock.toString(),
					stateBlockNumber: window.toBlock.toString(),
					priceBoundaryVersion: v3BoundaryComplete ? 1 : 2,
					usdBridgeVersion: usdBridgeComplete ? 1 : null,
					asOf,
					gapReason: null,
				},
				{
					chainId: CHAIN_ID_ELYSIUM,
					protocol: "uniswap_v4",
					windowStart: window.startUnix,
					windowEnd: window.endUnix,
					complete: true,
					fromBlock: window.fromBlock.toString(),
					toBlock: window.toBlock.toString(),
					stateBlockNumber: window.toBlock.toString(),
					priceBoundaryVersion: v4BoundaryComplete ? 1 : 2,
					usdBridgeVersion: usdBridgeComplete ? 1 : null,
					asOf,
					gapReason: null,
				},
			];
			const tx = await db.transaction("write");
			try {
				for (const row of pendingWindows) await upsertWindow(tx, row);
				for (const row of hours) await upsertScannedHour(tx, row);
				await tx.commit();
			} catch (error) {
				await tx.rollback();
				throw error;
			} finally {
				tx.close();
			}
			progress.hours[String(startUnix)] = {
				status: "ok",
				windows: pendingWindows.length,
				swapsV3: hourV3.length,
				swapsV4: hourV4.length,
				ms: Date.now() - started,
			};
			await saveProgress(progress);
			console.log(
				JSON.stringify({ hour: shanghai(startUnix), ...progress.hours[String(startUnix)] }),
			);
		} catch (error) {
			progress.hours[String(startUnix)] = {
				status: "error",
				windows: 0,
				swapsV3: 0,
				swapsV4: 0,
				error: errorText(error).slice(0, 400),
				ms: Date.now() - started,
			};
			await saveProgress(progress);
			console.log(
				JSON.stringify({
					hour: shanghai(startUnix),
					error: errorText(error).slice(0, 400),
				}),
			);
		}
	}

	const done = hourStarts.filter((t) => progress.hours[String(t)]?.status === "ok");
	const failed = hourStarts.filter((t) => progress.hours[String(t)]?.status === "error");
	const pending = hourStarts.filter((t) => !progress.hours[String(t)]);
	if (!progress.stoppedReason && pending.length === 0 && failed.length === 0)
		progress.stoppedReason = "completed";
	await saveProgress(progress);

	const frozen = JSON.parse(
		await fs.readFile(path.join(outDir, "dataset.json"), "utf8"),
	) as Dataset;
	const gapWindows = await listWindowsInRange(db, GAP_START, GAP_END);
	const gapPoolIds = [...new Set(gapWindows.map((h) => h.poolId))];
	const gapPools = (await listPools(db)).filter((p) => gapPoolIds.includes(p.poolId));
	const gapTokens = await listTokensForPools(db, gapPoolIds);
	const poolMap = new Map([...frozen.pools, ...gapPools].map((p) => [p.poolId, p]));
	const tokenMap = new Map(
		[...frozen.tokens, ...gapTokens].map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t]),
	);
	const mergedHours = [...gapWindows, ...frozen.hours.filter((h) => h.windowStart >= GAP_END)];
	const gapCoverage = (
		await db.execute({
			sql: `SELECT chain_id AS chainId, protocol, window_start AS windowStart, window_end AS windowEnd,
				complete, from_block AS fromBlock, to_block AS toBlock, as_of AS asOf, gap_reason AS gapReason,
				state_block_number AS stateBlockNumber, price_boundary_version AS priceBoundaryVersion,
				usd_bridge_version AS usdBridgeVersion
				FROM scanned_hours WHERE window_start >= ? AND window_start < ?`,
			args: [GAP_START, GAP_END],
		})
	).rows.map((row) => ({
		chainId: Number(row.chainId),
		protocol: String(row.protocol),
		windowStart: Number(row.windowStart),
		windowEnd: Number(row.windowEnd),
		complete: Number(row.complete) === 1,
		fromBlock: String(row.fromBlock),
		toBlock: String(row.toBlock),
		stateBlockNumber: row.stateBlockNumber == null ? null : String(row.stateBlockNumber),
		priceBoundaryVersion:
			row.priceBoundaryVersion == null ? null : Number(row.priceBoundaryVersion),
		usdBridgeVersion: row.usdBridgeVersion == null ? null : Number(row.usdBridgeVersion),
		asOf: String(row.asOf),
		gapReason: row.gapReason == null ? null : String(row.gapReason),
	}));
	const merged: Dataset = {
		...frozen,
		exportedAt: new Date().toISOString(),
		start: done.length ? GAP_START : frozen.start,
		pools: [...poolMap.values()],
		tokens: [...tokenMap.values()],
		hours: mergedHours.map((h) => {
			const pool = poolMap.get(h.poolId);
			return pool ? normalizeHour(h, pool) : h;
		}),
		coverage: [...gapCoverage, ...frozen.coverage],
	};
	const qual = merged.hours.filter(
		(h) => h.complete && h.windowStart >= GAP_START && h.windowStart < GAP_END && qualifies(h),
	);
	await fs.writeFile(path.join(outDir, "dataset-with-gap.json"), JSON.stringify(merged));
	const report = `# 上线日缺口有界回补

公共 RPC 类型：\`public_temporary\`，主机：${progress.rpcHost}。只写入研究库 \`gap-research.db\` 与本目录报告，未改生产库、生产采集、4 天保留或定时扫描。池元数据发现上界为 11 月 9 日 22:00 之前的区块，可能包含上线前已创建的池，但小时汇总只写 ${shanghai(GAP_START)} 至 ${shanghai(GAP_END - H)}，未把 10 月 19 日至 11 月 8 日小时档混进发现集。

- 发现池：V3 ${progress.discover?.v3 ?? "?"}，V4 ${progress.discover?.v4 ?? "?"}。
- 已完成小时：${done.length} / 22。失败：${failed.length}。未跑到：${pending.length}。停止原因：${progress.stoppedReason ?? "未记录"}。
- 已完成小时标签：${done.map(shanghai).join("、") || "无"}。
- 失败小时：${failed.map((t) => `${shanghai(t)} (${progress.hours[String(t)]?.error ?? ""})`).join("、") || "无"}。
- 回补窗内合格观察：${qual.length} 条，${new Set(qual.map((h) => h.poolId)).size} 个池（统一 1H 准入，未剔除异常计价前）。
- 合并样本：\`dataset-with-gap.json\`，起点 ${shanghai(merged.start)}，终点仍为本地已完成小时（见原冻结 manifest）。原 \`dataset.json\` 未覆盖。

若 22 小时未全部完成，发现集验收仍以已完成回补小时 + 11 月 9 日 22:00 起本地冻结为准，不编造缺档。
`;
	await fs.writeFile(path.join(outDir, "gap-backfill-report.md"), report, "utf8");
	console.log(
		JSON.stringify(
			{
				done: done.length,
				failed: failed.length,
				pending: pending.length,
				qualGapHours: qual.length,
				stoppedReason: progress.stoppedReason,
			},
			null,
			2,
		),
	);
} finally {
	db.close();
}
