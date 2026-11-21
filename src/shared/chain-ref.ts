import { CHAIN_CATALOG } from "./catalog.ts";

export type ChainRef = { chain: string; evmChainId: number | null };
export type ChainSelector = number | string | ChainRef;

/** No fabricated numeric IDs. Reject unknown and inconsistent identities. */
export function chainRef(value: ChainSelector): ChainRef {
	const entry = CHAIN_CATALOG.find((item) =>
		typeof value === "number"
			? item.evmChainId === value
			: item.id === (typeof value === "string" ? value : value.chain),
	);
	if (!entry || (typeof value === "object" && value.evmChainId !== entry.evmChainId)) {
		throw new Error("Unknown or inconsistent chain identity");
	}
	return { chain: entry.id, evmChainId: entry.evmChainId };
}

export function storedChain(value: {
	chainId: number | null;
	chain?: string;
	evmChainId?: number | null;
}): ChainRef {
	if (value.chainId === null) {
		if (!value.chain) throw new Error("Non-EVM identity requires chain");
		const ref = chainRef({ chain: value.chain, evmChainId: value.evmChainId ?? null });
		if (ref.evmChainId !== null)
			throw new Error("Null legacy chain ID cannot identify an EVM chain");
		return ref;
	}
	const ref = chainRef(value.chainId);
	if (
		(value.chain !== undefined && value.chain !== ref.chain) ||
		(value.evmChainId !== undefined && value.evmChainId !== ref.evmChainId)
	) {
		throw new Error("Inconsistent stored chain identity");
	}
	return ref;
}
