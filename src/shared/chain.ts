import { defineChain } from "viem";
import {
	CHAIN_ID_ELYSIUM,
	ELYSIUM_EXPLORER_URL,
	ELYSIUM_NATIVE_DECIMALS,
	ELYSIUM_NATIVE_SYMBOL,
	ELYSIUM_PUBLIC_RPC_URL,
} from "./constants.ts";

/**
 * Elysium mainnet (chain ID 99901). Do not use `elysiumTestnet` from `viem/chains`.
 */
export const elysiumMainnet = defineChain({
	id: CHAIN_ID_ELYSIUM,
	name: "Elysium",
	nativeCurrency: {
		name: "HYPE",
		symbol: ELYSIUM_NATIVE_SYMBOL,
		decimals: ELYSIUM_NATIVE_DECIMALS,
	},
	rpcUrls: {
		default: { http: [ELYSIUM_PUBLIC_RPC_URL] },
	},
	blockExplorers: {
		default: { name: "Elysium Explorer", url: ELYSIUM_EXPLORER_URL },
	},
});

export const robinhoodMainnet = defineChain({
	id: 4663,
	name: "Robinhood Chain",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
	blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});
