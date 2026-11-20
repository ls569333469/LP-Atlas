import { MULTICALL3_ADDRESS } from "../../../shared/constants.ts";
import { UNISWAP_V3_ROBINHOOD } from "../../../shared/deployments.ts";
import { createUniswapV3Reader } from "../../uniswap-v3-reader.ts";
import { createReadyAdapter } from "../../venue-adapter.ts";
// Orbit RPC/log block numbers are L2 heights; contract block.number is not used for hour alignment.
export const {
	createPriceReader: createV3PriceReader,
	decodeV3PoolCreatedLog,
	decodeV3SwapLog,
	discoverV3Pools,
	loadV3Swaps,
	loadV3SwapLogs,
	readV3PoolStates,
} = createUniswapV3Reader({
	factory: UNISWAP_V3_ROBINHOOD.factory,
	multicallAddress: MULTICALL3_ADDRESS,
	storagePrefix: "4663:uniswap_v3:",
	discoveryChunkSize: 150_000n,
	swapChunkSize: 250n,
	swapConcurrency: 16,
	stateConcurrency: 32,
});
export const venueAdapter = createReadyAdapter("robinhood", "uniswap_v3");
