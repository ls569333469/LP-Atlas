import Decimal from "decimal.js";
import type { PublicClient } from "viem";
import { erc20Abi } from "../adapters/abi.ts";
import { errorText } from "../adapters/errors.ts";
import { withRetry } from "../adapters/retry.ts";
import {
	CHAIN_ID_ELYSIUM,
	ROBINHOOD_USDG_ADDRESS,
	ROBINHOOD_WETH_ADDRESS,
	ZERO_ADDRESS,
} from "../shared/constants.ts";
import { USD_VALUATION_VERSION, type UsdQuoteSource } from "../shared/usd-quotes.ts";
import { ELYSIUM_PRICE_POLICY, type UsdPricePolicy } from "./prices.ts";

/** A successful current-state check cannot authorize a historical dollar anchor. */
export async function loadUsdPricePolicy(
	client: PublicClient,
	chainId: number,
	blockNumber: bigint,
	reportGap?: (message: string) => void,
	quoteInput?: { source: UsdQuoteSource; targetAt: number },
): Promise<UsdPricePolicy> {
	if (chainId === CHAIN_ID_ELYSIUM)
		return attachRoot(ELYSIUM_PRICE_POLICY, "HYPE", quoteInput, reportGap);
	if (chainId !== 4663) throw new Error("No USD price policy for chain");
	const results = await Promise.allSettled(
		([ROBINHOOD_USDG_ADDRESS, ROBINHOOD_WETH_ADDRESS] as const).map((address) =>
			withRetry(() =>
				client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
			),
		),
	);
	for (const [index, result] of results.entries()) {
		const expected = index === 0 ? 6 : 18;
		if (result.status === "rejected" || Number(result.value) !== expected) {
			const detail =
				result.status === "rejected"
					? errorText(result.reason)
					: `decimals=${result.value}, expected=${expected}`;
			reportGap?.(`Robinhood ${index === 0 ? "USDG" : "WETH"} block ${blockNumber}: ${detail}`);
		}
	}
	return attachRoot(
		{
			stable:
				results[0]?.status === "fulfilled" && Number(results[0].value) === 6
					? [ROBINHOOD_USDG_ADDRESS]
					: [],
			wrappedNative:
				results[1]?.status === "fulfilled" && Number(results[1].value) === 18
					? ROBINHOOD_WETH_ADDRESS
					: undefined,
			requireLiquidity: true,
		},
		"ETH",
		quoteInput,
		reportGap,
		ROBINHOOD_WETH_ADDRESS,
	);
}

async function attachRoot(
	policy: UsdPricePolicy,
	asset: "ETH" | "HYPE",
	input?: { source: UsdQuoteSource; targetAt: number },
	reportGap?: (message: string) => void,
	lockedWrapped?: string,
): Promise<UsdPricePolicy> {
	if (!input) return policy;
	const tokens = [
		ZERO_ADDRESS.toLowerCase(),
		...(policy.wrappedNative ? [policy.wrappedNative.toLowerCase()] : []),
	];
	const locked = new Set([...tokens, ...(lockedWrapped ? [lockedWrapped.toLowerCase()] : [])]);
	const result: UsdPricePolicy = { ...policy, lockedTokens: locked, rootPrices: new Map() };
	try {
		const quote = await input.source.getQuote(asset, input.targetAt);
		const price = new Decimal(quote.priceUsd);
		result.rootPrices = new Map(tokens.map((token) => [token, price]));
		result.quote = quote;
		result.valuationVersion = USD_VALUATION_VERSION;
	} catch {
		reportGap?.(`RedStone ${asset} 美元报价缺失，保留原币累计`);
	}
	return result;
}
