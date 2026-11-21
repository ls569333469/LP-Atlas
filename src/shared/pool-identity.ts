/** Preserve chain-specific address case; display/RPC poolId stays unchanged. */
export function poolIdentity(pool: { chain: string; protocol: string; poolId: string }): string {
	return JSON.stringify([pool.chain, pool.protocol, pool.poolId]);
}

/** Versioned, unambiguous storage surrogate; never use as an RPC/URL pool address. */
export function solanaPoolStorageKey(protocol: string, nativePoolId: string): string {
	return `pool:v1:${JSON.stringify(["solana", protocol, nativePoolId])}`;
}
