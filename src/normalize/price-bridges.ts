import type Decimal from "decimal.js";
import type { Address } from "viem";
import { getAddress, type PublicClient } from "viem";
import type { PoolQuote } from "../adapters/pool-price-reader.ts";
import { readV4Slot0s } from "../adapters/venues/elysium/uniswap-v4.ts";
import type { StoredEvmPool as StoredPool } from "../store/types.ts";
import { buildUsdPrices, type PricedPool, type UsdPricePolicy } from "./prices.ts";

export function buildPriceBridgeIndex(
	pools: readonly StoredPool[],
): ReadonlyMap<string, readonly StoredPool[]> {
	const edges = new Map<string, StoredPool[]>();
	for (const pool of pools) {
		for (const token of [pool.token0, pool.token1]) {
			const key = token.toLowerCase();
			const adjacent = edges.get(key) ?? [];
			adjacent.push(pool);
			edges.set(key, adjacent);
		}
	}
	return edges;
}

/** Only inspect catalog paths needed by unpriced tokens, at the original end block. */
export function missingPriceBridges(input: {
	pools: readonly StoredPool[];
	index?: ReturnType<typeof buildPriceBridgeIndex>;
	excluded?: ReadonlySet<string>;
	blockNumber: bigint;
	pricedTokens: Iterable<string>;
	neededTokens: Iterable<string>;
}): StoredPool[] {
	const edges = input.index ?? buildPriceBridgeIndex(input.pools);
	const usable = (pool: StoredPool) =>
		BigInt(pool.createdBlock) <= input.blockNumber && !input.excluded?.has(pool.poolId);
	const distance = new Map([...input.pricedTokens].map((token) => [token.toLowerCase(), 0]));
	const queue = [...distance.keys()];
	for (let i = 0; i < queue.length; i++) {
		const token = queue[i] as string;
		const depth = distance.get(token) as number;
		if (depth >= 32) continue;
		for (const pool of edges.get(token) ?? []) {
			if (!usable(pool)) continue;
			const other = (pool.token0.toLowerCase() === token ? pool.token1 : pool.token0).toLowerCase();
			if (distance.has(other)) continue;
			distance.set(other, depth + 1);
			queue.push(other);
		}
	}
	const selected = new Map<string, StoredPool>();
	const visited = new Set<string>();
	const needed = [...input.neededTokens].map((token) => token.toLowerCase());
	for (let i = 0; i < needed.length; i++) {
		const token = needed[i] as string;
		const depth = distance.get(token);
		if (depth === undefined || depth === 0 || visited.has(token)) continue;
		visited.add(token);
		for (const pool of edges.get(token) ?? []) {
			if (!usable(pool)) continue;
			const other = (pool.token0.toLowerCase() === token ? pool.token1 : pool.token0).toLowerCase();
			if (distance.get(other) !== depth - 1) continue;
			selected.set(pool.poolId, pool);
			needed.push(other);
		}
	}
	return [...selected.values()];
}

export async function supplementUsdPrices(input: {
	client: PublicClient;
	readSlots?: typeof readV4Slot0s;
	readV3States?: (
		client: PublicClient,
		pools: Array<{ poolAddress: Address; token0: Address; token1: Address }>,
		block: bigint,
	) => Promise<ReadonlyMap<string, PoolQuote>>;
	readV4Quotes?: (
		client: PublicClient,
		ids: string[],
		block: bigint,
	) => Promise<ReadonlyMap<string, PoolQuote>>;
	pricePolicy?: UsdPricePolicy;
	pools: readonly StoredPool[];
	index?: ReturnType<typeof buildPriceBridgeIndex>;
	blockNumber: bigint;
	prices: Map<string, Decimal>;
	pricedPools: readonly PricedPool[];
	loadedPoolIds: ReadonlySet<string>;
	neededTokens: Iterable<string>;
	decimals: Map<string, number>;
	loadDecimals: (addresses: string[]) => Promise<Map<string, number>>;
}): Promise<{ prices: Map<string, Decimal>; complete: boolean }> {
	const needed = [...new Set(input.neededTokens)].map((token) => token.toLowerCase());
	let prices = input.prices;
	let complete = true;
	const excluded = new Set<string>(
		input.pricePolicy?.requireLiquidity
			? input.pricedPools.flatMap((pool) =>
					pool.poolId && (pool.liquidity <= 0n || pool.sqrtPriceX96 === 0n) ? [pool.poolId] : [],
				)
			: [],
	);
	const pricedPools = [...input.pricedPools];
	while (needed.some((token) => !prices.has(token))) {
		const paths = missingPriceBridges({
			...input,
			excluded,
			pricedTokens: prices.keys(),
			neededTokens: needed.filter((token) => !prices.has(token)),
		});
		const unread = paths.filter((pool) => !input.loadedPoolIds.has(pool.poolId));
		const v3Bridges = unread.filter((pool) => pool.protocol === "uniswap_v3");
		if (v3Bridges.length > 0 && !input.readV3States) complete = false;
		if (v3Bridges.length > 0 && input.readV3States) {
			const states = await input.readV3States(
				input.client,
				v3Bridges.map((pool) => ({
					poolAddress: getAddress(pool.poolAddress ?? pool.poolId),
					token0: getAddress(pool.token0),
					token1: getAddress(pool.token1),
				})),
				input.blockNumber,
			);
			const decimals = await input.loadDecimals([
				...new Set(v3Bridges.flatMap((pool) => [pool.token0, pool.token1])),
			]);
			for (const [token, value] of decimals) input.decimals.set(token.toLowerCase(), value);
			for (const pool of v3Bridges) {
				excluded.add(pool.poolId);
				const state = states.get((pool.poolAddress ?? pool.poolId).toLowerCase());
				if (
					!state ||
					![pool.token0, pool.token1].every((token) => input.decimals.has(token.toLowerCase()))
				) {
					complete = false;
					continue;
				}
				if (state.liquidity > 0n) pricedPools.push({ ...pool, ...state });
			}
			prices = buildUsdPrices(pricedPools, input.decimals, prices, input.pricePolicy);
		}
		const bridges = unread.filter((pool) => pool.protocol === "uniswap_v4");
		if (bridges.length === 0) {
			if (v3Bridges.length > 0 && input.readV3States) continue;
			break;
		}
		const states = await (input.readV4Quotes ?? input.readSlots ?? readV4Slot0s)(
			input.client,
			bridges.map((pool) => pool.poolId),
			input.blockNumber,
		);
		const decimals = await input.loadDecimals([
			...new Set(bridges.flatMap((pool) => [pool.token0, pool.token1])),
		]);
		for (const [token, value] of decimals) input.decimals.set(token.toLowerCase(), value);
		for (const pool of bridges) {
			excluded.add(pool.poolId);
			const state = states.get(pool.poolId);
			if (
				!state ||
				![pool.token0, pool.token1].every((token) => input.decimals.has(token.toLowerCase()))
			) {
				complete = false;
				continue;
			}
			if (state.liquidity > 0n) pricedPools.push({ ...pool, ...state });
		}
		prices = buildUsdPrices(pricedPools, input.decimals, prices, input.pricePolicy);
	}
	return { prices, complete };
}
