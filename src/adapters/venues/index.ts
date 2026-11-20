import type { VenueAdapter } from "../venue-adapter.ts";
import { venueAdapter as basePancakeInfinity } from "./base/pancake-infinity.ts";
import { venueAdapter as baseUniswapV3 } from "./base/uniswap-v3.ts";
import { venueAdapter as baseUniswapV4 } from "./base/uniswap-v4.ts";
import { venueAdapter as bscPancakeInfinity } from "./bsc/pancake-infinity.ts";
import { venueAdapter as bscPancakeV3 } from "./bsc/pancake-v3.ts";
import { venueAdapter as bscUniswapV3 } from "./bsc/uniswap-v3.ts";
import { venueAdapter as bscUniswapV4 } from "./bsc/uniswap-v4.ts";
import { venueAdapter as elysiumUniswapV3 } from "./elysium/uniswap-v3.ts";
import { venueAdapter as elysiumUniswapV4 } from "./elysium/uniswap-v4.ts";
import { venueAdapter as ethereumUniswapV3 } from "./ethereum/uniswap-v3.ts";
import { venueAdapter as ethereumUniswapV4 } from "./ethereum/uniswap-v4.ts";
import { venueAdapter as robinhoodUniswapV3 } from "./robinhood/uniswap-v3.ts";
import { venueAdapter as robinhoodUniswapV4 } from "./robinhood/uniswap-v4.ts";
import { venueAdapter as solanaMeteoraDammV2 } from "./solana/meteora-damm-v2.ts";
import { venueAdapter as solanaMeteoraDlmm } from "./solana/meteora-dlmm.ts";
import { venueAdapter as solanaRaydiumClmm } from "./solana/raydium-clmm.ts";

/** One catalog venue <-> one adapter module. Keep this list 1:1 with src/shared/catalog.ts. */
export const VENUE_ADAPTERS: readonly VenueAdapter[] = [
	elysiumUniswapV3,
	elysiumUniswapV4,
	bscPancakeV3,
	bscUniswapV3,
	bscPancakeInfinity,
	bscUniswapV4,
	ethereumUniswapV3,
	ethereumUniswapV4,
	baseUniswapV3,
	baseUniswapV4,
	basePancakeInfinity,
	robinhoodUniswapV3,
	robinhoodUniswapV4,
	solanaMeteoraDlmm,
	solanaRaydiumClmm,
	solanaMeteoraDammV2,
];
