import type { VenuePoolCount } from "../shared/catalog.ts";
import type { FeeDataStatus } from "../shared/fee-quality.ts";
import type { SourceObservation } from "../shared/source-contracts.ts";
import type { MetricSource, ProtocolId } from "../shared/types.ts";

export type StoredEvmPool = {
	chain?: string;
	evmChainId?: number;
	nativePoolId?: string;
	poolId: string;
	chainId: number;
	protocol: ProtocolId;
	token0: string;
	token1: string;
	feePips: number;
	tickSpacing: number;
	hooks: string | null;
	poolAddress: string | null;
	createdBlock: number;
	createdAtUnix: number | null;
};

export type StoredEvmToken = {
	chain?: string;
	evmChainId?: number;
	chainId: number;
	address: string;
	symbol: string;
	decimals: number;
	name: string | null;
};

export type StoredNativeWindow = {
	sourceObservation?: SourceObservation;
	representation?: "native_amounts";
	usdValuationVersion?: number | null;
	poolId: string;
	windowStart: number;
	windowEnd: number;
	complete: boolean;
	volume0: string;
	volume1: string;
	lpFees0: string;
	lpFees1: string;
	swapCount: number;
	volumeUsd: string | null;
	lpFeesUsd: string | null;
	feeStatus?: FeeDataStatus;
	tvlUsd: string | null;
	sqrtPriceStart: string | null;
	sqrtPriceEnd: string | null;
	source: MetricSource;
	asOf: string;
	gapReason: string | null;
};

export type StoredRefreshRun = {
	id: number;
	startedAt: string;
	finishedAt: string | null;
	status: "running" | "ok" | "error" | "partial";
	rpcSourceKind: string;
	rpcSourceLabel: string;
	blockNumber: string | null;
	blockTime: string | null;
	error: string | null;
	gaps: string | null;
	warnings: string | null;
	poolCounts: VenuePoolCount[] | null;
	windowsBuilt: number | null;
	durationMs: number | null;
	scopeChain: string | null;
	scopeProtocol: string | null;
};

export type StoredEvmScannedHour = {
	chain?: string;
	evmChainId?: number;
	coverageScope?: "venue";
	chainId: number;
	protocol: string;
	windowStart: number;
	windowEnd: number;
	complete: boolean;
	fromBlock: string;
	toBlock: string;
	stateBlockNumber?: string | null;
	priceBoundaryVersion?: number | null;
	usdBridgeVersion?: number | null;
	usdValuationVersion?: number | null;
	usdQuote?: import("../shared/usd-quotes.ts").UsdQuote | null;
	asOf: string;
	gapReason: string | null;
};

/** Canonical non-EVM records use the same tables and repositories, never numeric sentinels. */
export type StoredSolanaPool = Omit<
	StoredEvmPool,
	"chainId" | "chain" | "evmChainId" | "nativePoolId" | "feePips" | "tickSpacing" | "createdBlock"
> & {
	chain: "solana";
	evmChainId: null;
	chainId: null;
	nativePoolId: string;
	feePips: number | null;
	tickSpacing: null;
	createdBlock: null;
};
export type StoredPool = StoredEvmPool | StoredSolanaPool;
export type StoredSolanaToken = Omit<StoredEvmToken, "chainId" | "chain" | "evmChainId"> & {
	chain: "solana";
	evmChainId: null;
	chainId: null;
};
export type StoredToken = StoredEvmToken | StoredSolanaToken;
export type StoredOfficialWindow = Omit<
	StoredNativeWindow,
	| "representation"
	| "usdValuationVersion"
	| "volume0"
	| "volume1"
	| "lpFees0"
	| "lpFees1"
	| "swapCount"
> & {
	representation: "official_usd";
	usdValuationVersion?: null;
	sourceObservation: SourceObservation;
	volume0: null;
	volume1: null;
	lpFees0: null;
	lpFees1: null;
	swapCount: null;
	reportedFeesUsd?: string | null;
	reportedProtocolFeesUsd?: string | null;
};
export type StoredWindow = StoredNativeWindow | StoredOfficialWindow;
export type StoredSolanaScannedHour = Omit<
	StoredEvmScannedHour,
	| "chainId"
	| "chain"
	| "evmChainId"
	| "coverageScope"
	| "fromBlock"
	| "toBlock"
	| "stateBlockNumber"
	| "priceBoundaryVersion"
	| "usdBridgeVersion"
	| "usdValuationVersion"
	| "usdQuote"
> & {
	chain: "solana";
	evmChainId: null;
	chainId: null;
	/** Exact pool storage key; an API pool sample is not venue-wide coverage. */
	coverageScope: string;
	sourceObservation: SourceObservation;
	fromBlock: null;
	toBlock: null;
	stateBlockNumber?: null;
	priceBoundaryVersion?: null;
	usdBridgeVersion?: null;
	usdValuationVersion?: null;
	usdQuote?: null;
};
export type StoredScannedHour = StoredEvmScannedHour | StoredSolanaScannedHour;

export function isEvmPool(pool: StoredPool): pool is StoredEvmPool {
	return pool.chainId !== null;
}
export function isEvmToken(token: StoredToken): token is StoredEvmToken {
	return token.chainId !== null;
}
export function isNativeWindow(window: StoredWindow): window is StoredNativeWindow {
	return window.representation !== "official_usd";
}
export function isEvmScannedHour(hour: StoredScannedHour): hour is StoredEvmScannedHour {
	return hour.chainId !== null;
}
