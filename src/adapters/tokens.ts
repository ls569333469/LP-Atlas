import type { Address, PublicClient } from "viem";
import {
	CHAIN_ID_ELYSIUM,
	ELYSIUM_NATIVE_DECIMALS,
	ELYSIUM_NATIVE_SYMBOL,
	ELYSIUM_USDC_ADDRESS,
	ELYSIUM_WHYPE_ADDRESS,
	MULTICALL3_ADDRESS,
	ROBINHOOD_USDG_ADDRESS,
	ROBINHOOD_WETH_ADDRESS,
	ZERO_ADDRESS,
} from "../shared/constants.ts";
import { erc20Abi } from "./abi.ts";
import { withRetry } from "./retry.ts";
import type { TokenMetadata } from "./types.ts";

const KNOWN: Record<string, TokenMetadata> = {
	[ZERO_ADDRESS.toLowerCase()]: {
		address: ZERO_ADDRESS,
		symbol: ELYSIUM_NATIVE_SYMBOL,
		decimals: ELYSIUM_NATIVE_DECIMALS,
		name: "HYPE",
	},
	[ELYSIUM_USDC_ADDRESS.toLowerCase()]: {
		address: ELYSIUM_USDC_ADDRESS as Address,
		symbol: "USDC",
		decimals: 6,
		name: "USD Coin",
	},
	[ELYSIUM_WHYPE_ADDRESS.toLowerCase()]: {
		address: ELYSIUM_WHYPE_ADDRESS as Address,
		symbol: "WHYPE",
		decimals: 18,
		name: "Wrapped HYPE",
	},
};

export function knownToken(address: string, chainId?: number): TokenMetadata | undefined {
	if (chainId === 4663) {
		const key = address.toLowerCase();
		if (key === ZERO_ADDRESS)
			return { address: ZERO_ADDRESS, symbol: "ETH", decimals: 18, name: "Ether" };
		if (key === ROBINHOOD_USDG_ADDRESS.toLowerCase())
			return {
				address: ROBINHOOD_USDG_ADDRESS,
				symbol: "USDG",
				decimals: 6,
				name: "Global Dollar",
			};
		if (key === ROBINHOOD_WETH_ADDRESS.toLowerCase())
			return { address: ROBINHOOD_WETH_ADDRESS, symbol: "WETH", decimals: 18, name: "WETH" };
	}
	if (chainId !== undefined && chainId !== CHAIN_ID_ELYSIUM) {
		return undefined;
	}
	return KNOWN[address.toLowerCase()];
}

export function normalizeTokenAddress(address: string): string {
	return address.toLowerCase();
}

export async function loadTokenMetadata(
	client: PublicClient,
	addresses: string[],
	cached: Map<string, TokenMetadata>,
	chainId: number = CHAIN_ID_ELYSIUM,
): Promise<Map<string, TokenMetadata>> {
	const result = new Map(cached);
	const missing: Address[] = [];
	for (const raw of addresses) {
		const address = raw.toLowerCase();
		if (result.has(address)) {
			continue;
		}
		const known = knownToken(address, chainId);
		if (known) {
			result.set(address, known);
			continue;
		}
		missing.push(raw as Address);
	}
	const batchSize = 50;
	for (let i = 0; i < missing.length; i += batchSize) {
		const batch = missing.slice(i, i + batchSize);
		const contracts = batch.flatMap((address) => [
			{ address, abi: erc20Abi, functionName: "symbol" as const },
			{ address, abi: erc20Abi, functionName: "decimals" as const },
			{ address, abi: erc20Abi, functionName: "name" as const },
		]);
		const responses = await withRetry(() =>
			client.multicall({
				contracts,
				allowFailure: true,
				multicallAddress: MULTICALL3_ADDRESS as Address,
			}),
		);
		for (let index = 0; index < batch.length; index += 1) {
			const address = batch[index];
			if (!address) {
				continue;
			}
			const symbolResult = responses[index * 3];
			const decimalsResult = responses[index * 3 + 1];
			const nameResult = responses[index * 3 + 2];
			const decimals =
				decimalsResult?.status === "success" ? Number(decimalsResult.result) : undefined;
			if (decimals === undefined || !Number.isFinite(decimals)) {
				continue;
			}
			const symbol =
				symbolResult?.status === "success" && symbolResult.result
					? sanitizeSymbol(String(symbolResult.result))
					: shortSymbol(address);
			const name = nameResult?.status === "success" ? String(nameResult.result) : null;
			result.set(address.toLowerCase(), {
				address,
				symbol,
				decimals,
				name,
			});
		}
	}
	return result;
}

function sanitizeSymbol(value: string): string {
	const trimmed = value.replace(/\0/g, "").trim();
	return trimmed.length > 0 ? trimmed : "UNKNOWN";
}

function shortSymbol(address: string): string {
	return address.slice(0, 6).toUpperCase();
}
