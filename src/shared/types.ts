import type { CatalogVenue, ProductCatalog, VenuePoolCount } from "./catalog.ts";
import type {
	BOARD_SORT_FIELDS,
	BOARD_WINDOWS,
	DEFAULT_BOARD_SORT,
	METRIC_SOURCES,
	RPC_SOURCE_CONFIGURED,
	RPC_SOURCE_PUBLIC_TEMPORARY,
} from "./constants.ts";
import type { FeeDataStatus } from "./fee-quality.ts";

/** Stable English protocol id, e.g. uniswap_v3. The enabled set comes from the server catalog. */
export type ProtocolId = string;
export type MetricSource = (typeof METRIC_SOURCES)[number];
export type RpcSourceKind = typeof RPC_SOURCE_CONFIGURED | typeof RPC_SOURCE_PUBLIC_TEMPORARY;
export type SortField = (typeof BOARD_SORT_FIELDS)[number];
export type SortDirection = "asc" | "desc";
export type WindowId = (typeof BOARD_WINDOWS)[number]["id"];
export type DefaultSortWindow = typeof DEFAULT_BOARD_SORT.window;

export type RpcSourceInfo = {
	kind: RpcSourceKind;
	label: string;
};

export type ChainRpcSource = {
	windowsMeta?: Record<WindowId, BoardWindowMeta>;
	refresh?: BoardRefreshState;
	chain: string;
	evmChainId: number | null;
	rpcSource: RpcSourceInfo;
};

export type MetricValue = {
	/** Decimal string. Null means the metric is missing and must stay empty. */
	value: string | null;
	source: MetricSource;
	asOf: string;
	complete: boolean;
	/** Present for LP fee-derived metrics; coverage and fee quality are independent. */
	feeStatus?: FeeDataStatus;
	reason?: string;
};

export type TokenRef = {
	name?: string | null;
	chainId: number;
	address: string;
	symbol: string;
	decimals: number;
};

export type BoardWindowMetrics = Pick<
	BoardRow,
	"volumeUsd" | "feesUsd" | "feesApr" | "changeVsPrevWindow" | "priceChange" | "capitalEfficiency"
>;

export type BoardWindowMeta = {
	windowStart: string;
	windowEnd: string;
	currentHourComplete: boolean;
};

export type PoolRiskNotice = {
	kind: "entry" | "exit" | "add_settlement" | "remove_settlement" | "swap_settlement";
	level: "permission_only" | "verified";
	label: string;
	description: string;
	evidence?: { source: string; checkedAt: string; codeVersion: string; scope: string };
};

export type BoardRow = {
	poolId: string;
	chainId: number;
	chain: string;
	protocol: ProtocolId;
	pairLabel: string;
	token0: TokenRef;
	token1: TokenRef;
	feeTierPips: number;
	feeTierLabel: string;
	hookType: string | null;
	riskNotices?: PoolRiskNotice[];
	feeEntitlementNotice?: string;
	tvlUsd: MetricValue;
	volumeUsd: MetricValue;
	feesUsd: MetricValue;
	/** Annualized ratio as a decimal string, e.g. "0.125" means 12.5%. */
	feesApr: MetricValue;
	/** Relative change of current-window LP fees vs the previous equal window. */
	changeVsPrevWindow: MetricValue;
	/** Pair mid-price change over the window, as a ratio. */
	priceChange: MetricValue;
	/** Window volume / TVL. */
	capitalEfficiency: MetricValue;
	poolAgeSeconds: MetricValue;
	windows?: Record<WindowId, BoardWindowMetrics>;
};

export type BoardMetricCondition = {
	field: SortField;
	window: WindowId | null;
	operator: ">" | ">=" | "<" | "<=" | "=";
	value: string;
};

export type BoardFilters = {
	hideLpRestrictions?: boolean;
	minLpFees1hUsd?: string;
	metricConditions?: BoardMetricCondition[];
	minTvlUsd: string;
	minWindowVolumeUsd: string;
	chain: string | null;
	protocol: ProtocolId | null;
	chains?: string[];
	protocols?: ProtocolId[];
	feeTierPips: number | null;
	search: string | null;
};

export type BoardSort = {
	field: SortField;
	window: WindowId;
	direction: SortDirection;
};

export type RefreshStatus = "idle" | "running" | "ok" | "error" | "partial";

export type BoardRefreshState = {
	status: RefreshStatus;
	startedAt: string | null;
	finishedAt: string | null;
	lastSuccessAt: string | null;
	error: string | null;
	scopeChain: string | null;
	scopeProtocol: ProtocolId | null;
};

export type BoardSuccessResponse = {
	ok: true;
	dataRevision?: string;
	includeWindows?: "all";
	windowsMeta?: Record<WindowId, BoardWindowMeta>;
	pagination?: {
		page: number;
		pageSize: number;
		total: number;
		totalPages: number;
		from: number;
		to: number;
		snapshotId: string;
	};
	rows: BoardRow[];
	columns: ReadonlyArray<{ id: string; label: string }>;
	catalog: ProductCatalog;
	enabledVenues: CatalogVenue[];
	chainRpcSources: ChainRpcSource[];
	defaultFilters: BoardFilters;
	appliedFilters: BoardFilters;
	sort: BoardSort;
	source: MetricSource;
	asOf: string | null;
	windowStart: string | null;
	windowEnd: string | null;
	currentHourComplete: boolean;
	rpcSource: RpcSourceInfo;
	discoveredPoolCount: VenuePoolCount[];
	rowCountBeforeFilter: number;
	refresh: BoardRefreshState;
	gaps: string[];
	warnings: string[];
};

export type BoardErrorResponse = {
	ok: false;
	error: string;
	catalog?: ProductCatalog;
	enabledVenues?: CatalogVenue[];
	chainRpcSources?: ChainRpcSource[];
	rpcSource?: RpcSourceInfo;
	refresh?: BoardRefreshState;
	gaps?: string[];
};

export type BoardResponse = BoardSuccessResponse | BoardErrorResponse;

export type AutoScanState = {
	enabled: boolean;
	intervalMs: number;
	nextRunAt: string | null;
	lastAttemptAt: string | null;
	lastFinishedAt: string | null;
	status: RefreshStatus | "skipped";
	message: string | null;
};

export type HealthResponse = {
	dataRevision?: string;
	ok: true;
	service: "lp-atlas";
	phase: "1";
	autoScan?: AutoScanState;
	catalog: ProductCatalog;
	enabledVenues: CatalogVenue[];
	chainRpcSources: ChainRpcSource[];
	refresh: BoardRefreshState;
	time: string;
};

export type RefreshRequest = {
	chain?: string;
	protocol?: string;
};

export type RefreshAcceptedResponse = {
	ok: true;
	accepted: true;
	alreadyRunning: boolean;
	rpcSource: RpcSourceInfo;
	chainRpcSources: ChainRpcSource[];
	refresh: BoardRefreshState;
};

export type RefreshSuccessResponse = {
	ok: true;
	accepted?: false;
	asOf: string;
	blockNumber: string;
	rpcSource: RpcSourceInfo;
	chainRpcSources: ChainRpcSource[];
	discoveredPoolCount: VenuePoolCount[];
	windowsBuilt: number;
	durationMs: number;
	refresh: BoardRefreshState;
	gaps: string[];
	warnings: string[];
};

export type RefreshErrorResponse = {
	ok: false;
	error: string;
	rpcSource?: RpcSourceInfo;
	chainRpcSources?: ChainRpcSource[];
	lastSuccessAt?: string | null;
	refresh?: BoardRefreshState;
	gaps?: string[];
};

export type RefreshResponse =
	| RefreshAcceptedResponse
	| RefreshSuccessResponse
	| RefreshErrorResponse;
