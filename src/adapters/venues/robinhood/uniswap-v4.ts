import { MULTICALL3_ADDRESS } from "../../../shared/constants.ts";
import { UNISWAP_V4_ROBINHOOD } from "../../../shared/deployments.ts";
import { createUniswapV4Reader } from "../../uniswap-v4-reader.ts";
import { createReadyAdapter } from "../../venue-adapter.ts";
// Orbit RPC/log block numbers are L2 heights; contract block.number is not used for hour alignment.
export const {
	createPriceReader: createV4PriceReader,
	decodeV4InitializeLog,
	decodeV4SwapLog,
	discoverV4Pools,
	loadV4Swaps,
	readV4Slot0s,
	readV4Reserves,
	toV4PoolState,
} = createUniswapV4Reader({
	poolManager: UNISWAP_V4_ROBINHOOD.poolManager,
	stateView: UNISWAP_V4_ROBINHOOD.stateView,
	reservesLens: UNISWAP_V4_ROBINHOOD.reservesLens,
	multicallAddress: MULTICALL3_ADDRESS,
	storagePrefix: "4663:uniswap_v4:",
	swapChunkSize: 800n,
	swapConcurrency: 16,
	stateConcurrency: 32,
	reserveConcurrency: 64,
});
export const venueAdapter = createReadyAdapter("robinhood", "uniswap_v4");
