import type { PublicClient } from "viem";

/** Owned by one refresh; missing/failed values are never retained as successful state. */
export function cacheBlockStates<Pool, State>(
	key: (pool: Pool) => string,
	load: (client: PublicClient, pools: Pool[], block?: bigint) => Promise<Map<string, State>>,
	usable: (state: State) => boolean = () => true,
) {
	const blocks = new Map<
		bigint,
		{
			values: Map<string, State>;
			pending: Map<string, Promise<State | undefined>>;
		}
	>();
	return async (
		client: PublicClient,
		pools: Pool[],
		block?: bigint,
	): Promise<Map<string, State>> => {
		if (block === undefined) return load(client, pools, block);
		const cache = blocks.get(block) ?? {
			values: new Map<string, State>(),
			pending: new Map<string, Promise<State | undefined>>(),
		};
		blocks.delete(block);
		blocks.set(block, cache);
		const oldest = blocks.keys().next().value;
		if (blocks.size > 3 && oldest !== undefined) blocks.delete(oldest);
		const missing = [...new Map(pools.map((pool) => [key(pool), pool])).values()].filter(
			(pool) => !cache.values.has(key(pool)) && !cache.pending.has(key(pool)),
		);
		if (missing.length) {
			const loaded = Promise.resolve().then(() => load(client, missing, block));
			for (const pool of missing) {
				const id = key(pool);
				cache.pending.set(
					id,
					loaded
						.then((states) => {
							const state = states.get(id);
							if (state !== undefined && usable(state)) cache.values.set(id, state);
							return state;
						})
						.finally(() => {
							cache.pending.delete(id);
						}),
				);
			}
		}
		const results = await Promise.allSettled(
			pools.map(async (pool) => {
				const id = key(pool);
				const value = cache.values.get(id) ?? (await cache.pending.get(id));
				return value === undefined ? [] : [[id, value] as const];
			}),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		return new Map(
			results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
		);
	};
}
