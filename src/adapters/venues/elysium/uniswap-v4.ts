import { ELYSIUM_MULTICALL3_ADDRESS, UNISWAP_V4_ELYSIUM } from "../../../shared/constants.ts";
import { createUniswapV4Reader } from "../../uniswap-v4-reader.ts";
import { createReadyAdapter } from "../../venue-adapter.ts";
export const {
	decodeV4InitializeLog,
	decodeV4SwapLog,
	discoverV4Pools,
	loadV4Swaps,
	readV4Slot0s,
	readV4Reserves,
	toV4PoolState,
} = createUniswapV4Reader({
	poolManager: UNISWAP_V4_ELYSIUM.poolManager,
	stateView: UNISWAP_V4_ELYSIUM.stateView,
	reservesLens: UNISWAP_V4_ELYSIUM.reservesLens,
	multicallAddress: ELYSIUM_MULTICALL3_ADDRESS,
});
export { unpackV4ProtocolFee } from "../../fees.ts";
export const venueAdapter = createReadyAdapter("elysium", "uniswap_v4");
