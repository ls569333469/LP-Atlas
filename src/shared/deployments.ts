/**
 * Official factory / PoolManager / StateView / PositionManager addresses
 * used by scanners. Do not treat this as a complete address book.
 *
 * Sources (reviewed 2026-11-12):
 * - https://developers.uniswap.org/deployments
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
 * - https://developers.uniswap.org/docs/protocols/v4/deployments
 * - https://developer.pancakeswap.finance/contracts/v3/addresses
 * - https://developer.pancakeswap.finance/contracts/infinity/resources/addresses
 * - Elysium addresses remain in `constants.ts`
 */

export type UniswapV3Deployment = {
	factory: `0x${string}`;
	nonfungiblePositionManager: `0x${string}`;
};

export type UniswapV4Deployment = {
	reservesLens?: `0x${string}`;
	poolManager: `0x${string}`;
	stateView: `0x${string}`;
	positionManager: `0x${string}`;
};

export type PancakeV3Deployment = {
	factory: `0x${string}`;
	poolDeployer: `0x${string}`;
	nonfungiblePositionManager: `0x${string}`;
};

export type PancakeInfinityDeployment = {
	vault: `0x${string}`;
	clPoolManager: `0x${string}`;
	clPositionManager: `0x${string}`;
};

export const UNISWAP_V3_ETHEREUM = {
	factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
	nonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
} as const satisfies UniswapV3Deployment;

export const UNISWAP_V4_ETHEREUM = {
	poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
	stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
	positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
} as const satisfies UniswapV4Deployment;

export const UNISWAP_V3_BASE = {
	factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
	nonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
} as const satisfies UniswapV3Deployment;

export const UNISWAP_V4_BASE = {
	poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
	stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
	positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
} as const satisfies UniswapV4Deployment;

export const UNISWAP_V3_BSC = {
	factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
	nonfungiblePositionManager: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
} as const satisfies UniswapV3Deployment;

export const UNISWAP_V4_BSC = {
	poolManager: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
	stateView: "0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4",
	positionManager: "0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b",
} as const satisfies UniswapV4Deployment;

export const UNISWAP_V3_ROBINHOOD = {
	factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
	nonfungiblePositionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
} as const satisfies UniswapV3Deployment;

export const UNISWAP_V4_ROBINHOOD = {
	reservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
	poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
	stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
	positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
} as const satisfies UniswapV4Deployment;

export const PANCAKE_V3_BSC = {
	factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
	poolDeployer: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
	nonfungiblePositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
} as const satisfies PancakeV3Deployment;

/** Official Pancake Infinity on BNB Smart Chain and Base share these addresses. */
export const PANCAKE_INFINITY_BSC_BASE = {
	vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
	clPoolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
	clPositionManager: "0x55f4c8abA71A1e923edC303eb4fEfF14608cC226",
} as const satisfies PancakeInfinityDeployment;

/**
 * Official Pancake Exchange V3 subgraph IDs from
 * https://developer.pancakeswap.finance/apis/subgraph (reviewed 2026-11-12).
 * These are Pancake-published IDs, not Uniswap Labs production indexes.
 */
export const PANCAKE_V3_BSC_SUBGRAPH_ID = "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ";

/**
 * Public Graph explorer example IDs quoted on
 * https://developers.uniswap.org/docs/ecosystem/subgraphs/overview
 * Uniswap Labs labels these as examples, not official production deployments.
 * Do not record or use them as official subgraph IDs.
 */
export const UNOFFICIAL_UNISWAP_EXPLORER_SUBGRAPH_IDS = {
	ethereumV3: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
	ethereumV4: "DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G",
} as const;
