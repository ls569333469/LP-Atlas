import {
	CHAIN_ID_ELYSIUM,
	ELYSIUM_USDC_ADDRESS,
	ELYSIUM_WHYPE_ADDRESS,
	ROBINHOOD_USDG_ADDRESS,
	ROBINHOOD_WETH_ADDRESS,
	ZERO_ADDRESS,
} from "../shared/constants.ts";
import type { AppDatabase } from "../store/db.ts";
import { listPoolAdditions } from "../store/repositories.ts";
import type { StoredEvmPool as StoredPool } from "../store/types.ts";

type Catalog = {
	lastRowId: number;
	pools: StoredPool[];
	v3Pools: StoredPool[];
	v4Pools: StoredPool[];
	pricingV3: StoredPool[];
	pricingV4: StoredPool[];
	poolById: Map<string, StoredPool>;
	v3ByAddress: Map<string, StoredPool>;
	catalogOrder: Map<string, number>;
	priceIndex: Map<string, StoredPool[]>;
};

const catalogs = new WeakMap<AppDatabase, Map<string, Catalog>>();

export async function loadCatalog(db: AppDatabase, chainId: number, protocol?: string | null) {
	let scopes = catalogs.get(db);
	if (!scopes) {
		scopes = new Map();
		catalogs.set(db, scopes);
	}
	const key = `${chainId}:${protocol ?? "all"}`;
	let catalog = scopes.get(key);
	if (!catalog) {
		catalog = {
			lastRowId: 0,
			pools: [],
			v3Pools: [],
			v4Pools: [],
			pricingV3: [],
			pricingV4: [],
			poolById: new Map(),
			v3ByAddress: new Map(),
			catalogOrder: new Map(),
			priceIndex: new Map(),
		};
		scopes.set(key, catalog);
	}
	const started = Date.now();
	const additions = await listPoolAdditions(db, chainId, catalog.lastRowId, protocol);
	const loadedMs = Date.now() - started;
	const indexedAt = Date.now();
	const compare = (a: StoredPool, b: StoredPool) =>
		a.protocol.localeCompare(b.protocol) ||
		(catalog.catalogOrder.get(a.poolId) ?? 0) - (catalog.catalogOrder.get(b.poolId) ?? 0);
	for (const [index, pool] of additions.pools.entries()) {
		catalog.catalogOrder.set(pool.poolId, additions.rowIds[index] ?? 0);
		catalog.poolById.set(pool.poolId, pool);
		if (pool.protocol === "uniswap_v3" && pool.poolAddress) {
			catalog.v3Pools.push(pool);
			catalog.v3ByAddress.set(pool.poolAddress.toLowerCase(), pool);
		}
		if (pool.protocol === "uniswap_v4") catalog.v4Pools.push(pool);
		if (isPricingAnchor(pool.token0, pool.token1, chainId === CHAIN_ID_ELYSIUM)) {
			if (pool.protocol === "uniswap_v3" && pool.poolAddress) catalog.pricingV3.push(pool);
			if (pool.protocol === "uniswap_v4") catalog.pricingV4.push(pool);
		}
		for (const token of [pool.token0, pool.token1]) {
			const address = token.toLowerCase();
			let edges = catalog.priceIndex.get(address);
			if (!edges) {
				edges = [];
				catalog.priceIndex.set(address, edges);
			}
			if (!edges.length || compare(edges[edges.length - 1] as StoredPool, pool) <= 0)
				edges.push(pool);
			else {
				let low = 0;
				let high = edges.length;
				while (low < high) {
					const mid = (low + high) >>> 1;
					if (compare(edges[mid] as StoredPool, pool) <= 0) low = mid + 1;
					else high = mid;
				}
				edges.splice(low, 0, pool);
			}
		}
	}
	// Match the existing protocol index order, including V3 discoveries after V4 entries.
	if (additions.pools.length) {
		const incoming = additions.pools.sort(compare);
		const merged: StoredPool[] = [];
		let old = 0;
		let next = 0;
		while (old < catalog.pools.length && next < incoming.length) {
			if (compare(catalog.pools[old] as StoredPool, incoming[next] as StoredPool) <= 0)
				merged.push(catalog.pools[old++] as StoredPool);
			else merged.push(incoming[next++] as StoredPool);
		}
		while (old < catalog.pools.length) merged.push(catalog.pools[old++] as StoredPool);
		while (next < incoming.length) merged.push(incoming[next++] as StoredPool);
		catalog.pools = merged;
	}
	catalog.lastRowId = additions.lastRowId;
	return { ...catalog, added: additions.pools.length, loadedMs, indexedMs: Date.now() - indexedAt };
}

export function isPricingAnchor(token0: string, token1: string, isElysium: boolean): boolean {
	const tokens = [token0.toLowerCase(), token1.toLowerCase()];
	const usdc = (isElysium ? ELYSIUM_USDC_ADDRESS : ROBINHOOD_USDG_ADDRESS).toLowerCase();
	const hypes = new Set([
		ZERO_ADDRESS.toLowerCase(),
		(isElysium ? ELYSIUM_WHYPE_ADDRESS : ROBINHOOD_WETH_ADDRESS).toLowerCase(),
	]);
	return tokens.includes(usdc) && tokens.some((token) => hypes.has(token));
}
