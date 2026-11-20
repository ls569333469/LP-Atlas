import { ELYSIUM_MULTICALL3_ADDRESS, UNISWAP_V3_ELYSIUM } from "../../../shared/constants.ts";
import { createUniswapV3Reader } from "../../uniswap-v3-reader.ts";
import { createReadyAdapter } from "../../venue-adapter.ts";
export const {
	decodeV3PoolCreatedLog,
	decodeV3SwapLog,
	discoverV3Pools,
	loadV3Swaps,
	readV3PoolStates,
} = createUniswapV3Reader({
	factory: UNISWAP_V3_ELYSIUM.factory,
	multicallAddress: ELYSIUM_MULTICALL3_ADDRESS,
});
export { CHAIN_ID_ELYSIUM } from "../../../shared/constants.ts";
export const venueAdapter = createReadyAdapter("elysium", "uniswap_v3");
