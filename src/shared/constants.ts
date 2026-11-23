/**
 * Official Elysium and Uniswap addresses, plus board defaults.
 * Sources (reviewed 2026-11-12):
 * - https://elysium.kinetiq.xyz/docs/connecting-to-elysium
 * - https://elysium.kinetiq.xyz/docs/contract-addresses
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-elysium-deployments
 * - https://developers.uniswap.org/docs/protocols/v4/deployments
 */

export const CHAIN_ID_ELYSIUM = 99901;
export const CHAIN_ID_ETHEREUM = 1;
export const CHAIN_ID_BSC = 56;
export const CHAIN_ID_BASE = 8453;
export const CHAIN_ID_ROBINHOOD = 4663;

export const ELYSIUM_PUBLIC_RPC_URL = "https://rpc.elysium.kinetiq.xyz";
export const ELYSIUM_EXPLORER_URL = "https://elysium.kinetiq.xyz/explorer";
export const ELYSIUM_NATIVE_SYMBOL = "HYPE";
export const ELYSIUM_NATIVE_DECIMALS = 18;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Official bridged USDC (6 decimals). Do not treat look-alike tokens as $1. */
export const ELYSIUM_USDC_ADDRESS = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
/** Official wrapped HYPE. */
export const ELYSIUM_WHYPE_ADDRESS = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
export const ELYSIUM_MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const UNISWAP_V3_ELYSIUM = {
	factory: "0x1707327F626496A7b5b3872e7E4d2879Df7d7a9f",
	nonfungiblePositionManager: "0xF025e0Fe9E331A0eF05c2ad3C4E9C64b625cda6f",
	multicall: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
} as const;

export const UNISWAP_V4_ELYSIUM = {
	poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1",
	stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
	positionManager: "0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518",
	/** Same CREATE2 address on every official Uniswap v4 deployment, including Elysium 99901. */
	reservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
} as const;

export const FEE_PIPS_DENOMINATOR = 1_000_000;
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
export const DYNAMIC_FEE_LABEL = "动态费率";
export const PRICE_SPACING_LABEL = "价格档位间距";
export const BIN_STEP_UNIT = "基点";
export const HOUR_SECONDS = 3600;
export const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Default filters are unified across chains and protocols. No APR threshold. */
export const DEFAULT_BOARD_FILTERS = {
	minTvlUsd: "1000",
	minWindowVolumeUsd: "100",
	minLpFees1hUsd: "10",
} as const;

export const DEFAULT_BOARD_SORT = {
	field: "feesApr",
	window: "1h",
	direction: "desc",
} as const;

/** First-phase determined windows. Other lengths stay deferred. */
export const BOARD_WINDOWS = [
	{ id: "1h", seconds: 3600, label: "1 小时" },
	{ id: "2h", seconds: 7200, label: "2 小时" },
	{ id: "4h", seconds: 14400, label: "4 小时" },
	{ id: "6h", seconds: 21600, label: "6 小时" },
	{ id: "24h", seconds: 86400, label: "24 小时" },
	{ id: "3d", seconds: 259200, label: "3 天" },
] as const;

export const BOARD_SORT_FIELDS = [
	"feesApr",
	"tvl",
	"volume",
	"fees",
	"changeVsPrevWindow",
	"priceChange",
	"capitalEfficiency",
	"poolAge",
] as const;

export const BOARD_WINDOW_METRICS = [
	{ key: "feesApr", sort: "feesApr", label: "fees APR" },
	{ key: "volumeUsd", sort: "volume", label: "成交量" },
	{ key: "feesUsd", sort: "fees", label: "LP 手续费" },
	{ key: "changeVsPrevWindow", sort: "changeVsPrevWindow", label: "手续费环比", signed: true },
	{ key: "priceChange", sort: "priceChange", label: "价格涨跌", signed: true },
	{ key: "capitalEfficiency", sort: "capitalEfficiency", label: "资金效率" },
] as const;

export const BOARD_COLUMNS = [
	{ id: "pair", label: "交易对" },
	{ id: "feeTier", label: "费率档" },
	{ id: "protocol", label: "协议" },
	{ id: "tvl", label: "TVL" },
	{ id: "volume", label: "成交量" },
	{ id: "fees", label: "手续费" },
	{ id: "feesApr", label: "fees APR" },
	{ id: "changeVsPrevWindow", label: "相对上一窗口变化" },
	{ id: "priceChange", label: "涨跌" },
	{ id: "capitalEfficiency", label: "资金效率" },
	{ id: "poolAge", label: "池龄" },
] as const;

export const PROTOCOL_LABELS = {
	uniswap_v3: "Uniswap V3",
	uniswap_v4: "Uniswap V4",
} as const;

export const METRIC_SOURCE_SELF_BUILT = "self_built";
export const METRIC_SOURCE_OFFICIAL_INDEX = "official_index";
export const METRIC_SOURCE_UNOFFICIAL = "unofficial";
export const METRIC_SOURCES = [
	METRIC_SOURCE_SELF_BUILT,
	METRIC_SOURCE_OFFICIAL_INDEX,
	METRIC_SOURCE_UNOFFICIAL,
] as const;
export const RPC_SOURCE_PUBLIC_TEMPORARY = "public_temporary";
export const RPC_SOURCE_CONFIGURED = "configured";

export const PUBLIC_RPC_WARNING =
	"当前使用官方公共 RPC，仅供临时联调，不是生产归档节点。历史日志或状态若不足会明确报错或标出缺口，不会用其它窗口冒充已定窗口。";

// Current 3D plus required comparisons through 24H; independent of cache retention.
export const DETERMINED_LOOKBACK_SECONDS = Math.max(
	...BOARD_WINDOWS.map((window) => window.seconds * (window.id === "3d" ? 1 : 2)),
);
/** Local hourly aggregates are kept for 4 days; older rows are pruned after each refresh. */
export const HOURLY_RETENTION_SECONDS = 4 * 24 * 3600;
export const PUBLIC_REFRESH_MAX_HOURS = 8;
export const CONFIGURED_REFRESH_MAX_HOURS = 24;

/** Canonical deployment, bytecode checked on Robinhood Chain 4663. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Robinhood official anchors: https://docs.robinhood.com/chain/contracts/ (checked 2026-11-14). */
export const ROBINHOOD_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ROBINHOOD_WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
