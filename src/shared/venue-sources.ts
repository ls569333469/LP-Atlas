import { VENUE_CATALOG, venueKey } from "./catalog.ts";
import { UNISWAP_V3_ELYSIUM, UNISWAP_V4_ELYSIUM } from "./constants.ts";
import {
	PANCAKE_INFINITY_BSC_BASE,
	PANCAKE_V3_BSC,
	PANCAKE_V3_BSC_SUBGRAPH_ID,
	UNISWAP_V3_BASE,
	UNISWAP_V3_BSC,
	UNISWAP_V3_ETHEREUM,
	UNISWAP_V3_ROBINHOOD,
	UNISWAP_V4_BASE,
	UNISWAP_V4_BSC,
	UNISWAP_V4_ETHEREUM,
	UNISWAP_V4_ROBINHOOD,
} from "./deployments.ts";
import type { SourceCapabilities } from "./source-contracts.ts";
import type { WindowId } from "./types.ts";

export type IngestPath = "official_index" | "self_built" | "not_started";
export type OfficialIndexKind = "pancake_subgraph" | "uniswap_official_subgraph" | "none";
export type OfficialNativeWindow = "1h" | "1d";

export type VenueContracts = {
	factory?: `0x${string}`;
	poolDeployer?: `0x${string}`;
	poolManager?: `0x${string}`;
	stateView?: `0x${string}`;
	positionManager?: `0x${string}`;
	vault?: `0x${string}`;
	clPoolManager?: `0x${string}`;
};

export type VenueSourceEnv = {
	rpcUrl?: string;
	rpcUrlBackup?: string;
	graphApiKey?: "THE_GRAPH_API_KEY";
	subgraphId?: string;
};

export type BoardWindowRule = {
	windowId: WindowId;
	/** Official 1h buckets always preferred when every needed hour exists. */
	hourCount: number;
	/**
	 * Official 1d buckets may be used only when the board window is an exact
	 * UTC-day range. Never use a 1d bucket to fill a missing hour or a
	 * rolling window that is not UTC-day aligned.
	 */
	utcDayCount: number | null;
};

export const OFFICIAL_NATIVE_WINDOWS = [
	"1h",
	"1d",
] as const satisfies readonly OfficialNativeWindow[];

export const BOARD_WINDOW_COMPOSITION_RULES: readonly BoardWindowRule[] = [
	{ windowId: "1h", hourCount: 1, utcDayCount: null },
	{ windowId: "2h", hourCount: 2, utcDayCount: null },
	{ windowId: "4h", hourCount: 4, utcDayCount: null },
	{ windowId: "6h", hourCount: 6, utcDayCount: null },
	{ windowId: "24h", hourCount: 24, utcDayCount: 1 },
	{ windowId: "3d", hourCount: 72, utcDayCount: 3 },
];

export type VenueSourcePolicy = {
	chain: string;
	protocol: string;
	ingest: IngestPath;
	indexKind: OfficialIndexKind;
	officialWindows: readonly OfficialNativeWindow[];
	contracts: VenueContracts;
	env: VenueSourceEnv;
	/** Only an officially published production subgraph ID belongs here. Never invent one. */
	officialSubgraphId: string | null;
	notes: string;
};

const GRAPH_KEY = "THE_GRAPH_API_KEY" as const;

const POLICIES: readonly VenueSourcePolicy[] = [
	{
		chain: "elysium",
		protocol: "uniswap_v3",
		ingest: "self_built",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			factory: UNISWAP_V3_ELYSIUM.factory,
			positionManager: UNISWAP_V3_ELYSIUM.nonfungiblePositionManager,
		},
		env: { rpcUrl: "ELYSIUM_RPC_URL", rpcUrlBackup: "ELYSIUM_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"已启用。自建小时档；公开 RPC 只能标 public_temporary，验收须用归档节点。不要另起拉取器。",
	},
	{
		chain: "elysium",
		protocol: "uniswap_v4",
		ingest: "self_built",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			poolManager: UNISWAP_V4_ELYSIUM.poolManager,
			stateView: UNISWAP_V4_ELYSIUM.stateView,
			positionManager: UNISWAP_V4_ELYSIUM.positionManager,
		},
		env: { rpcUrl: "ELYSIUM_RPC_URL", rpcUrlBackup: "ELYSIUM_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes: "已启用。自建小时档，V4 状态走官方 StateView。不要另起拉取器。",
	},
	{
		chain: "bsc",
		protocol: "pancake_v3",
		ingest: "official_index",
		indexKind: "pancake_subgraph",
		officialWindows: OFFICIAL_NATIVE_WINDOWS,
		contracts: {
			factory: PANCAKE_V3_BSC.factory,
			poolDeployer: PANCAKE_V3_BSC.poolDeployer,
			positionManager: PANCAKE_V3_BSC.nonfungiblePositionManager,
		},
		env: {
			rpcUrl: "BSC_RPC_URL",
			rpcUrlBackup: "BSC_RPC_URL_BACKUP",
			graphApiKey: GRAPH_KEY,
			subgraphId: "PANCAKE_V3_BSC_SUBGRAPH_ID",
		},
		officialSubgraphId: PANCAKE_V3_BSC_SUBGRAPH_ID,
		notes:
			"BSC 启动时的第一批场所之一。用 Pancake 官方 Exchange V3 subgraph 的 1h/1d；缺小时留空。密钥只放服务端。尚未启用，不得接入默认刷新。",
	},
	{
		chain: "bsc",
		protocol: "uniswap_v3",
		ingest: "self_built",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			factory: UNISWAP_V3_BSC.factory,
			positionManager: UNISWAP_V3_BSC.nonfungiblePositionManager,
		},
		env: { rpcUrl: "BSC_RPC_URL", rpcUrlBackup: "BSC_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"未发现 Uniswap Labs 生产索引。默认自建小时档。若以后自托管官方 subgraph，再改为 official_index，不得把公开 Explorer 部署写成官方 ID。尚未启用。",
	},
	{
		chain: "bsc",
		protocol: "pancake_infinity",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			vault: PANCAKE_INFINITY_BSC_BASE.vault,
			clPoolManager: PANCAKE_INFINITY_BSC_BASE.clPoolManager,
			positionManager: PANCAKE_INFINITY_BSC_BASE.clPositionManager,
		},
		env: { rpcUrl: "BSC_RPC_URL", rpcUrlBackup: "BSC_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"后续场所。轮到再按当时官方协议单独写适配器。Pancake 官方 subgraph 页目前未列出 Infinity 生产索引，不得捏造。",
	},
	{
		chain: "bsc",
		protocol: "uniswap_v4",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			poolManager: UNISWAP_V4_BSC.poolManager,
			stateView: UNISWAP_V4_BSC.stateView,
			positionManager: UNISWAP_V4_BSC.positionManager,
		},
		env: { rpcUrl: "BSC_RPC_URL", rpcUrlBackup: "BSC_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"后续场所。未确认 Labs 生产索引；轮到时优先官方自托管 subgraph，否则自建小时档并走官方 StateView。",
	},
	{
		chain: "ethereum",
		protocol: "uniswap_v3",
		ingest: "official_index",
		indexKind: "uniswap_official_subgraph",
		officialWindows: OFFICIAL_NATIVE_WINDOWS,
		contracts: {
			factory: UNISWAP_V3_ETHEREUM.factory,
			positionManager: UNISWAP_V3_ETHEREUM.nonfungiblePositionManager,
		},
		env: {
			rpcUrl: "ETHEREUM_RPC_URL",
			rpcUrlBackup: "ETHEREUM_RPC_URL_BACKUP",
			graphApiKey: GRAPH_KEY,
			subgraphId: "UNISWAP_V3_ETHEREUM_SUBGRAPH_ID",
		},
		officialSubgraphId: null,
		notes:
			"优先走 Labs 或官方自托管 subgraph 的 1h/1d。Uniswap 文档中的 Explorer ID 是示例，不是官方生产部署，只能当非官方备份。环境变量未证实时不得填写假官方 ID。尚未启用。",
	},
	{
		chain: "ethereum",
		protocol: "uniswap_v4",
		ingest: "official_index",
		indexKind: "uniswap_official_subgraph",
		officialWindows: OFFICIAL_NATIVE_WINDOWS,
		contracts: {
			poolManager: UNISWAP_V4_ETHEREUM.poolManager,
			stateView: UNISWAP_V4_ETHEREUM.stateView,
			positionManager: UNISWAP_V4_ETHEREUM.positionManager,
		},
		env: {
			rpcUrl: "ETHEREUM_RPC_URL",
			rpcUrlBackup: "ETHEREUM_RPC_URL_BACKUP",
			graphApiKey: GRAPH_KEY,
			subgraphId: "UNISWAP_V4_ETHEREUM_SUBGRAPH_ID",
		},
		officialSubgraphId: null,
		notes:
			"同 Ethereum Uniswap V3：官方索引优先，但生产 subgraph ID 尚未确认。不得把公开 Explorer ID 写成官方 ID。尚未启用。",
	},
	{
		chain: "base",
		protocol: "uniswap_v3",
		ingest: "official_index",
		indexKind: "uniswap_official_subgraph",
		officialWindows: OFFICIAL_NATIVE_WINDOWS,
		contracts: {
			factory: UNISWAP_V3_BASE.factory,
			positionManager: UNISWAP_V3_BASE.nonfungiblePositionManager,
		},
		env: {
			rpcUrl: "BASE_RPC_URL",
			rpcUrlBackup: "BASE_RPC_URL_BACKUP",
			graphApiKey: GRAPH_KEY,
			subgraphId: "UNISWAP_V3_BASE_SUBGRAPH_ID",
		},
		officialSubgraphId: null,
		notes: "与 Ethereum Uniswap V3 相同政策。生产 subgraph ID 未确认。尚未启用。",
	},
	{
		chain: "base",
		protocol: "uniswap_v4",
		ingest: "official_index",
		indexKind: "uniswap_official_subgraph",
		officialWindows: OFFICIAL_NATIVE_WINDOWS,
		contracts: {
			poolManager: UNISWAP_V4_BASE.poolManager,
			stateView: UNISWAP_V4_BASE.stateView,
			positionManager: UNISWAP_V4_BASE.positionManager,
		},
		env: {
			rpcUrl: "BASE_RPC_URL",
			rpcUrlBackup: "BASE_RPC_URL_BACKUP",
			graphApiKey: GRAPH_KEY,
			subgraphId: "UNISWAP_V4_BASE_SUBGRAPH_ID",
		},
		officialSubgraphId: null,
		notes: "与 Ethereum Uniswap V4 相同政策。生产 subgraph ID 未确认。尚未启用。",
	},
	{
		chain: "base",
		protocol: "pancake_infinity",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			vault: PANCAKE_INFINITY_BSC_BASE.vault,
			clPoolManager: PANCAKE_INFINITY_BSC_BASE.clPoolManager,
			positionManager: PANCAKE_INFINITY_BSC_BASE.clPositionManager,
		},
		env: { rpcUrl: "BASE_RPC_URL", rpcUrlBackup: "BASE_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes: "已列入后续场所。轮到 Base 再按当时官方协议写适配器，不要提前启用。",
	},
	{
		chain: "robinhood",
		protocol: "uniswap_v3",
		ingest: "self_built",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			factory: UNISWAP_V3_ROBINHOOD.factory,
			positionManager: UNISWAP_V3_ROBINHOOD.nonfungiblePositionManager,
		},
		env: { rpcUrl: "ROBINHOOD_RPC_URL", rpcUrlBackup: "ROBINHOOD_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"The Graph 目前仅提供 Substreams（eip155:4663），没有官方托管 subgraph。路径与 Elysium 相同：归档 RPC 自建小时档。不得伪造官方 1h 索引。已按 08 场所方案启用，临时公开源生产拉数，归档验收未完成。",
	},
	{
		chain: "robinhood",
		protocol: "uniswap_v4",
		ingest: "self_built",
		indexKind: "none",
		officialWindows: [],
		contracts: {
			poolManager: UNISWAP_V4_ROBINHOOD.poolManager,
			stateView: UNISWAP_V4_ROBINHOOD.stateView,
			positionManager: UNISWAP_V4_ROBINHOOD.positionManager,
		},
		env: { rpcUrl: "ROBINHOOD_RPC_URL", rpcUrlBackup: "ROBINHOOD_RPC_URL_BACKUP" },
		officialSubgraphId: null,
		notes:
			"无官方托管 subgraph。自建小时档并走官方 StateView，与 Elysium V4 相同。已按 08 场所方案启用，临时公开源生产拉数，归档验收未完成。",
	},
	{
		chain: "solana",
		protocol: "meteora_dlmm",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {},
		env: {},
		officialSubgraphId: null,
		notes: "轮到 Solana 再写适配器。窗口须对齐已定六个窗口，不得冒充。",
	},
	{
		chain: "solana",
		protocol: "raydium_clmm",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {},
		env: {},
		officialSubgraphId: null,
		notes: "轮到 Solana 再写适配器。窗口须对齐已定六个窗口，不得冒充。",
	},
	{
		chain: "solana",
		protocol: "meteora_damm_v2",
		ingest: "not_started",
		indexKind: "none",
		officialWindows: [],
		contracts: {},
		env: {},
		officialSubgraphId: null,
		notes: "已列入后续场所。轮到 Solana 再写适配器，不要提前启用。",
	},
];

const POLICY_BY_KEY = new Map(
	POLICIES.map((policy) => [venueKey(policy.chain, policy.protocol), policy]),
);

export function venueSourcePolicies(): readonly VenueSourcePolicy[] {
	return POLICIES;
}

export function venueSourcePolicy(chain: string, protocol: string): VenueSourcePolicy | undefined {
	return POLICY_BY_KEY.get(venueKey(chain, protocol));
}

export function assertVenueSourceCatalogCoverage(): void {
	for (const venue of VENUE_CATALOG) {
		if (!POLICY_BY_KEY.has(venueKey(venue.chain, venue.protocol))) {
			throw new Error(`场所缺少数据路径政策：${venue.chain}/${venue.protocol}`);
		}
	}
}

assertVenueSourceCatalogCoverage();

/** Reviewed capability boundaries; not all official sources are subgraphs. */
export function venueSourceCapabilities(chain: string, protocol: string): SourceCapabilities {
	const policy = venueSourcePolicy(chain, protocol);
	if (!policy) throw new Error("Missing source policy");
	if (policy.ingest === "self_built")
		return {
			kind: "event_scan",
			coverageScope: "venue",
			rawAmounts: true,
			historicalState: "required",
		};
	if (policy.ingest === "official_index")
		return { kind: "official_index", nativeWindows: policy.officialWindows };
	return {
		kind: "not_started",
		candidate:
			chain === "solana" && protocol === "meteora_dlmm"
				? "official_cumulative"
				: chain === "solana" && protocol === "raydium_clmm"
					? "events_and_state"
					: "unreviewed",
		coverage: "unverified",
		ordinaryLpFees: "unverified",
		historicalState: "unverified",
	};
}
