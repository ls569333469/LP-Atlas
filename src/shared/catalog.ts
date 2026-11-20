import {
	CHAIN_ID_BASE,
	CHAIN_ID_BSC,
	CHAIN_ID_ELYSIUM,
	CHAIN_ID_ETHEREUM,
	CHAIN_ID_ROBINHOOD,
} from "./constants.ts";

export const VENUE_STATUS_ENABLED = "enabled";
export const VENUE_STATUS_LISTED = "listed_not_implemented";

export type VenueStatus = typeof VENUE_STATUS_ENABLED | typeof VENUE_STATUS_LISTED;

export type CatalogChain = {
	id: string;
	evmChainId: number | null;
	label: string;
	nativeSymbol: string;
};

export type CatalogProtocol = {
	id: string;
	label: string;
};

export type CatalogVenue = {
	chain: string;
	evmChainId: number | null;
	protocol: string;
	status: VenueStatus;
	label: string;
};

export type ProductCatalog = {
	chains: readonly CatalogChain[];
	protocols: readonly CatalogProtocol[];
	venues: readonly CatalogVenue[];
};

export type VenuePoolCount = {
	chain: string;
	evmChainId: number | null;
	protocol: string;
	count: number;
};

/** Formal product chains. Arbitrum is intentionally absent. */
export const CHAIN_CATALOG: readonly CatalogChain[] = [
	{ id: "elysium", evmChainId: CHAIN_ID_ELYSIUM, label: "Elysium", nativeSymbol: "HYPE" },
	{ id: "bsc", evmChainId: CHAIN_ID_BSC, label: "BNB Smart Chain", nativeSymbol: "BNB" },
	{ id: "ethereum", evmChainId: CHAIN_ID_ETHEREUM, label: "Ethereum", nativeSymbol: "ETH" },
	{ id: "base", evmChainId: CHAIN_ID_BASE, label: "Base", nativeSymbol: "ETH" },
	{
		id: "robinhood",
		evmChainId: CHAIN_ID_ROBINHOOD,
		label: "Robinhood Chain",
		nativeSymbol: "ETH",
	},
	{ id: "solana", evmChainId: null, label: "Solana", nativeSymbol: "SOL" },
];

const CHAIN_ALIASES: Readonly<Record<string, string>> = {
	robin: "robinhood",
	"robinhood chain": "robinhood",
	eth: "ethereum",
	"ethereum mainnet": "ethereum",
	mainnet: "ethereum",
	bnb: "bsc",
	"bnb chain": "bsc",
	"bnb smart chain": "bsc",
};

export const PROTOCOL_CATALOG: readonly CatalogProtocol[] = [
	{ id: "uniswap_v3", label: "Uniswap V3" },
	{ id: "uniswap_v4", label: "Uniswap V4" },
	{ id: "pancake_v3", label: "PancakeSwap V3" },
	{ id: "pancake_infinity", label: "PancakeSwap Infinity" },
	{ id: "meteora_dlmm", label: "Meteora DLMM" },
	{ id: "meteora_damm_v2", label: "Meteora DAMM V2" },
	{ id: "raydium_clmm", label: "Raydium CLMM" },
];

const VENUE_SPECS: ReadonlyArray<{ chain: string; protocol: string; status: VenueStatus }> = [
	{ chain: "elysium", protocol: "uniswap_v3", status: VENUE_STATUS_ENABLED },
	{ chain: "elysium", protocol: "uniswap_v4", status: VENUE_STATUS_ENABLED },
	{ chain: "bsc", protocol: "pancake_v3", status: VENUE_STATUS_LISTED },
	{ chain: "bsc", protocol: "uniswap_v3", status: VENUE_STATUS_LISTED },
	{ chain: "bsc", protocol: "pancake_infinity", status: VENUE_STATUS_LISTED },
	{ chain: "bsc", protocol: "uniswap_v4", status: VENUE_STATUS_LISTED },
	{ chain: "ethereum", protocol: "uniswap_v3", status: VENUE_STATUS_LISTED },
	{ chain: "ethereum", protocol: "uniswap_v4", status: VENUE_STATUS_LISTED },
	{ chain: "base", protocol: "uniswap_v3", status: VENUE_STATUS_LISTED },
	{ chain: "base", protocol: "uniswap_v4", status: VENUE_STATUS_LISTED },
	{ chain: "base", protocol: "pancake_infinity", status: VENUE_STATUS_LISTED },
	{ chain: "robinhood", protocol: "uniswap_v3", status: VENUE_STATUS_ENABLED },
	{ chain: "robinhood", protocol: "uniswap_v4", status: VENUE_STATUS_ENABLED },
	{ chain: "solana", protocol: "meteora_dlmm", status: VENUE_STATUS_LISTED },
	{ chain: "solana", protocol: "raydium_clmm", status: VENUE_STATUS_LISTED },
	{ chain: "solana", protocol: "meteora_damm_v2", status: VENUE_STATUS_LISTED },
];

export function chainById(id: string): CatalogChain | undefined {
	return CHAIN_CATALOG.find((chain) => chain.id === id);
}

export function chainByEvmId(evmChainId: number): CatalogChain | undefined {
	return CHAIN_CATALOG.find((chain) => chain.evmChainId === evmChainId);
}

export function protocolById(id: string): CatalogProtocol | undefined {
	return PROTOCOL_CATALOG.find((protocol) => protocol.id === id);
}

export const VENUE_CATALOG: readonly CatalogVenue[] = VENUE_SPECS.map((spec) => {
	const chain = chainById(spec.chain);
	const protocol = protocolById(spec.protocol);
	if (!chain || !protocol) {
		throw new Error(`目录缺少链或协议：${spec.chain}/${spec.protocol}`);
	}
	return {
		chain: chain.id,
		evmChainId: chain.evmChainId,
		protocol: protocol.id,
		status: spec.status,
		label: `${chain.label} ${protocol.label}`,
	};
});

export function productCatalog(): ProductCatalog {
	return {
		chains: CHAIN_CATALOG,
		protocols: PROTOCOL_CATALOG,
		venues: VENUE_CATALOG,
	};
}

export function enabledVenues(): CatalogVenue[] {
	return VENUE_CATALOG.filter((venue) => venue.status === VENUE_STATUS_ENABLED);
}

export function findChain(input: string | undefined): CatalogChain | undefined {
	if (!input) {
		return undefined;
	}
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}
	const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
	const aliased = CHAIN_ALIASES[normalized];
	const byId = chainById(aliased ?? normalized);
	if (byId) {
		return byId;
	}
	if (/^\d+$/.test(trimmed)) {
		return chainByEvmId(Number(trimmed));
	}
	return undefined;
}

export function findProtocol(input: string | undefined): CatalogProtocol | undefined {
	if (!input) {
		return undefined;
	}
	const trimmed = input.trim();
	return trimmed ? protocolById(trimmed) : undefined;
}

export function isEnabledVenue(chainId: string, protocol: string): boolean {
	return VENUE_CATALOG.some(
		(venue) =>
			venue.chain === chainId &&
			venue.protocol === protocol &&
			venue.status === VENUE_STATUS_ENABLED,
	);
}

export function findVenue(chainId: string, protocol: string): CatalogVenue | undefined {
	return VENUE_CATALOG.find((venue) => venue.chain === chainId && venue.protocol === protocol);
}

export function venueKey(chain: string, protocol: string): string {
	return `${chain}:${protocol}`;
}

export function venueCount(chain: CatalogChain, protocol: string, count: number): VenuePoolCount {
	return {
		chain: chain.id,
		evmChainId: chain.evmChainId,
		protocol,
		count,
	};
}

export type RefreshScope = {
	chain: string | null;
	protocol: string | null;
};

export function resolveRefreshScope(input: {
	chain?: string;
	protocol?: string;
}): RefreshScope | { error: string } {
	const chainRaw = input.chain?.trim();
	const protocolRaw = input.protocol?.trim();
	const chain = chainRaw ? findChain(chainRaw) : undefined;
	if (chainRaw && !chain) {
		return { error: `未知链：${chainRaw}` };
	}
	const protocol = protocolRaw ? findProtocol(protocolRaw) : undefined;
	if (protocolRaw && !protocol) {
		return { error: `未知协议：${protocolRaw}` };
	}
	if (chain && protocol && !isEnabledVenue(chain.id, protocol.id)) {
		return { error: `${chain.label} ${protocol.label} 已列入目录但尚未接入，不能刷新。` };
	}
	if (chain && !protocol) {
		const enabled = enabledVenues().filter((venue) => venue.chain === chain.id);
		if (enabled.length === 0) {
			return { error: `${chain.label} 上还没有已启用的协议，不能刷新。` };
		}
	}
	if (protocol && !chain) {
		const enabled = enabledVenues().filter((venue) => venue.protocol === protocol.id);
		if (enabled.length === 0) {
			return { error: `${protocol.label} 尚未在已启用场所接入，不能刷新。` };
		}
	}
	return { chain: chain?.id ?? null, protocol: protocol?.id ?? null };
}
