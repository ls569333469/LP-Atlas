import Decimal from "decimal.js";
import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { knownToken } from "../src/adapters/tokens.ts";
import { buildUsdPrices } from "../src/normalize/prices.ts";
import { loadUsdPricePolicy } from "../src/normalize/pricing-policy.ts";
import {
	ELYSIUM_USDC_ADDRESS,
	ELYSIUM_WHYPE_ADDRESS,
	ROBINHOOD_USDG_ADDRESS,
	ROBINHOOD_WETH_ADDRESS,
	ZERO_ADDRESS,
} from "../src/shared/constants.ts";
import type { UsdQuote, UsdQuoteSource } from "../src/shared/usd-quotes.ts";

it("values Robinhood from its own verified USDG address and historical ETH bridge", async () => {
	const readContract = vi
		.fn()
		.mockImplementation(({ address }) =>
			Promise.resolve(address === ROBINHOOD_USDG_ADDRESS ? 6 : 18),
		);
	const policy = await loadUsdPricePolicy({ readContract } as unknown as PublicClient, 4663, 123n);
	expect(readContract.mock.calls.every(([call]) => call.blockNumber === 123n)).toBe(true);
	const decimals = new Map([
		[ROBINHOOD_USDG_ADDRESS.toLowerCase(), 6],
		[ROBINHOOD_WETH_ADDRESS.toLowerCase(), 18],
	]);
	// Raw ratio USDG/WETH = 2,500 / 10^12, exactly representable via sqrt = 1/20,000.
	const prices = buildUsdPrices(
		[
			{
				token0: ROBINHOOD_WETH_ADDRESS,
				token1: ROBINHOOD_USDG_ADDRESS,
				sqrtPriceX96: 2n ** 96n / 20000n,
				liquidity: 100n,
			},
		],
		decimals,
		undefined,
		policy,
	);
	expect(prices.get(ROBINHOOD_WETH_ADDRESS.toLowerCase())?.toNumber()).toBeCloseTo(2500, 8);
	expect(prices.get(ZERO_ADDRESS)?.toNumber()).toBeCloseTo(2500, 8);
	expect(prices.has(ELYSIUM_USDC_ADDRESS.toLowerCase())).toBe(false);
	expect(prices.has(ELYSIUM_WHYPE_ADDRESS.toLowerCase())).toBe(false);
	expect(knownToken(ROBINHOOD_USDG_ADDRESS, 4663)?.decimals).toBe(6);
	expect(knownToken(ROBINHOOD_USDG_ADDRESS, 99901)).toBeUndefined();
	expect(
		buildUsdPrices(
			[
				{
					token0: ROBINHOOD_WETH_ADDRESS,
					token1: ROBINHOOD_USDG_ADDRESS,
					sqrtPriceX96: 2n ** 96n,
					liquidity: 0n,
				},
			],
			decimals,
			undefined,
			policy,
		).has(ROBINHOOD_WETH_ADDRESS.toLowerCase()),
	).toBe(false);
});

it("does not seed unavailable historical anchors or reuse current metadata as historical state", async () => {
	const report = vi.fn();
	const readContract = vi.fn().mockRejectedValue(new Error("historical state is not available"));
	const policy = await loadUsdPricePolicy(
		{ readContract } as unknown as PublicClient,
		4663,
		12n,
		report,
	);
	expect(policy.stable).toEqual([]);
	expect(policy.wrappedNative).toBeUndefined();
	expect(buildUsdPrices([], new Map(), undefined, policy).size).toBe(0);
	expect(report.mock.calls.flat().join(" ")).toContain("historical state is not available");
	const wrong = await loadUsdPricePolicy(
		{ readContract: vi.fn().mockResolvedValue(18) } as unknown as PublicClient,
		4663,
		12n,
	);
	expect(wrong.stable).toEqual([]);
	const unchanged = await loadUsdPricePolicy(
		{ readContract } as unknown as PublicClient,
		99901,
		12n,
	);
	expect(
		buildUsdPrices([], new Map(), undefined, unchanged)
			.get(ELYSIUM_USDC_ADDRESS.toLowerCase())
			?.toString(),
	).toBe("1");
});

it("retries a transient historical WETH read at the same block", async () => {
	let wethCalls = 0;
	const readContract = vi.fn().mockImplementation(({ address }) => {
		if (address === ROBINHOOD_USDG_ADDRESS) return Promise.resolve(6);
		if (++wethCalls === 1) return Promise.reject(new Error("fetch failed"));
		return Promise.resolve(18);
	});
	const report = vi.fn();
	const policy = await loadUsdPricePolicy(
		{ readContract } as unknown as PublicClient,
		4663,
		123n,
		report,
	);
	expect(wethCalls).toBe(2);
	expect(policy.wrappedNative).toBe(ROBINHOOD_WETH_ADDRESS);
	expect(report).not.toHaveBeenCalled();
	expect(readContract.mock.calls.every(([call]) => call.blockNumber === 123n)).toBe(true);
});

it.each([false, true])(
	"locks native and verified wrappers against pool-derived prices, unavailable=%s",
	async (unavailable) => {
		const source: UsdQuoteSource = {
			getQuote: async (assetId, targetAt) => {
				if (unavailable) throw new Error("source unavailable");
				return { assetId, targetAt, priceUsd: "2000" } as UsdQuote;
			},
		};
		const policy = await loadUsdPricePolicy(
			{
				readContract: vi.fn(async ({ address }) => (address === ROBINHOOD_USDG_ADDRESS ? 6 : 18)),
			} as unknown as PublicClient,
			4663,
			123n,
			undefined,
			{ source, targetAt: 700 },
		);
		const prices = buildUsdPrices(
			[
				{
					token0: ROBINHOOD_WETH_ADDRESS,
					token1: ROBINHOOD_USDG_ADDRESS,
					sqrtPriceX96: 2n ** 96n,
					liquidity: 1000n,
				},
			],
			new Map([
				[ROBINHOOD_WETH_ADDRESS.toLowerCase(), 18],
				[ROBINHOOD_USDG_ADDRESS.toLowerCase(), 6],
			]),
			new Map([
				[ZERO_ADDRESS, new Decimal(999999)],
				[ROBINHOOD_WETH_ADDRESS.toLowerCase(), new Decimal(999999)],
			]),
			policy,
		);
		expect(prices.get(ZERO_ADDRESS)?.toString()).toBe(unavailable ? undefined : "2000");
		expect(prices.get(ROBINHOOD_WETH_ADDRESS.toLowerCase())).toBe(prices.get(ZERO_ADDRESS));
		const noMapping = await loadUsdPricePolicy(
			{ readContract: vi.fn(async () => 6) } as unknown as PublicClient,
			4663,
			123n,
			undefined,
			{ source, targetAt: 700 },
		);
		expect(
			buildUsdPrices(
				[],
				new Map(),
				new Map([[ROBINHOOD_WETH_ADDRESS.toLowerCase(), new Decimal(999999)]]),
				noMapping,
			).has(ROBINHOOD_WETH_ADDRESS.toLowerCase()),
		).toBe(false);
	},
);
