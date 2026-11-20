/** Preserve chain-specific address case; display/RPC poolId stays unchanged. */
export function poolIdentity(pool: { chain: string; protocol: string; poolId: string }): string {
	return JSON.stringify([pool.chain, pool.protocol, pool.poolId]);
}
