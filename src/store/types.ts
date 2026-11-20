import type { VenuePoolCount } from "../shared/catalog.ts";
import type { FeeDataStatus } from "../shared/fee-quality.ts";
import type { MetricSource, ProtocolId } from "../shared/types.ts";

export type StoredPool = {
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

export type StoredToken = {
	chainId: number;
	address: string;
	symbol: string;
	decimals: number;
	name: string | null;
};

export type StoredWindow = {
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

export type StoredScannedHour = {
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
