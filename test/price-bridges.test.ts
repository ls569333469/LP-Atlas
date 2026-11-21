import Decimal from "decimal.js";
import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { createV3PriceReader } from "../src/adapters/venues/robinhood/uniswap-v3.ts";
import { createV4PriceReader } from "../src/adapters/venues/robinhood/uniswap-v4.ts";
import {
	buildPriceBridgeIndex,
	missingPriceBridges,
	supplementUsdPrices,
} from "../src/normalize/price-bridges.ts";
import { repairClosedHour } from "../src/normalize/repair-hour.ts";
import { ELYSIUM_USDC_ADDRESS, ZERO_ADDRESS } from "../src/shared/constants.ts";
import type {
	StoredEvmPool as StoredPool,
	StoredEvmScannedHour as StoredScannedHour,
	StoredNativeWindow as StoredWindow,
} from "../src/store/types.ts";

const x = `0x${"1".repeat(40)}`;
const y = `0x${"2".repeat(40)}`;
const q96 = 2n ** 96n;
function pool(id: string, token0: string, token1: string, v3 = false): StoredPool {
	return {
		poolId: id,
		chainId: 99901,
		protocol: v3 ? "uniswap_v3" : "uniswap_v4",
		token0,
		token1,
		feePips: 10000,
		tickSpacing: 200,
		hooks: null,
		poolAddress: v3 ? id : null,
		createdBlock: 1,
		createdAtUnix: 1,
	};
}
const target = pool(`0x${"3".repeat(40)}`, x, y, true);
const anchor = pool(`0x${"4".repeat(64)}`, ZERO_ADDRESS, ELYSIUM_USDC_ADDRESS.toLowerCase());
const bridge = pool(`0x${"5".repeat(64)}`, ZERO_ADDRESS, x);

it.each([false, true])(
	"revalues nonempty legacy dollars from raw amounts, missing reserves=%s",
	async (missing) => {
		const p = pool(x, ZERO_ADDRESS, y, true);
		const old: StoredWindow = {
			poolId: x,
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			volume0: "1000000",
			volume1: "1000000",
			lpFees0: "10000",
			lpFees1: "0",
			swapCount: 7,
			volumeUsd: "999999",
			lpFeesUsd: "8888",
			feeStatus: "estimated",
			tvlUsd: "7777",
			sqrtPriceStart: q96.toString(),
			sqrtPriceEnd: q96.toString(),
			source: "self_built",
			asOf: "1970-01-01T02:00:00Z",
			gapReason: null,
		};
		const hour: StoredScannedHour = {
			chainId: 99901,
			protocol: "uniswap_v3",
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			fromBlock: "10",
			toBlock: "100",
			stateBlockNumber: "100",
			priceBoundaryVersion: 1,
			usdBridgeVersion: 1,
			asOf: old.asOf,
			gapReason: null,
		};
		const result = await repairClosedHour({
			client: {} as PublicClient,
			pools: [p],
			windows: [old],
			hours: [hour],
			pricingAnchor: () => false,
			pricePolicy: {
				stable: [],
				rootPrices: new Map([[ZERO_ADDRESS, new Decimal(2)]]),
				lockedTokens: new Set([ZERO_ADDRESS]),
				valuationVersion: 2,
			},
			loadDecimals: async () =>
				new Map([
					[ZERO_ADDRESS, 6],
					[y, 6],
				]),
			readers: {
				readV3PoolStates: async () =>
					new Map(
						missing
							? []
							: [
									[
										x,
										{
											poolId: x,
											sqrtPriceX96: q96,
											tick: 0,
											liquidity: 100n,
											feeProtocol0: 0,
											feeProtocol1: 0,
											amount0: 1000000n,
											amount1: 1000000n,
										},
									],
								],
					),
				readV4Slot0s: async () => new Map(),
				readV4Reserves: async () => new Map(),
				toV4PoolState: () => undefined,
			},
		});
		if (missing) {
			expect(result.windows).toEqual([]);
			expect(result.hours[0]?.usdValuationVersion).toBeNull();
			expect(result.gaps.join()).toContain(x);
		} else {
			expect(result.windows).toEqual([
				{ ...old, volumeUsd: "2", lpFeesUsd: "0.02", tvlUsd: "4", usdValuationVersion: 2 },
			]);
			expect(result.hours[0]?.usdValuationVersion).toBe(2);
		}
	},
);

it("selects only relevant historical paths, excluding later-created and disconnected pools", () => {
	const future = { ...bridge, poolId: "future", createdBlock: 101 };
	expect(
		missingPriceBridges({
			pools: [anchor, target, future, pool("disconnected", "z", "w"), bridge],
			blockNumber: 100n,
			pricedTokens: [ZERO_ADDRESS],
			neededTokens: [y],
		}).map((p) => p.poolId),
	).toEqual([target.poolId, bridge.poolId]);
});

it.each(["liquid", "zero", "failed"] as const)(
	"repairs missing USD using the original end block, bridge=%s",
	async (mode) => {
		const multicall = vi.fn(
			async ({
				contracts,
				blockNumber,
			}: {
				contracts: Array<{ functionName: string; args?: readonly unknown[] }>;
				blockNumber: bigint;
			}) => {
				expect(blockNumber).toBe(100n);
				return contracts.map((call) => {
					const isBridge = call.args?.[0] === bridge.poolId;
					if (isBridge && mode === "failed")
						return { status: "failure", error: new Error("429 Rate Limit") };
					return {
						status: "success",
						result:
							call.functionName === "slot0"
								? [q96, 0, 0, 0, 0, 0, true]
								: call.functionName === "getSlot0"
									? [q96, 0, 0, 10000]
									: call.functionName === "balanceOf"
										? 1000000n
										: isBridge && mode === "zero"
											? 0n
											: 100n,
					};
				});
			},
		);
		const client = { multicall } as unknown as PublicClient;
		const hour: StoredScannedHour = {
			chainId: 99901,
			protocol: "uniswap_v3",
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			fromBlock: "10",
			toBlock: "100",
			stateBlockNumber: "100",
			priceBoundaryVersion: 1,
			asOf: "1970-01-01T02:00:00Z",
			gapReason: null,
		};
		const row: StoredWindow = {
			poolId: target.poolId,
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			volume0: "1000000",
			volume1: "1000000",
			lpFees0: "10000",
			lpFees1: "0",
			swapCount: 1,
			volumeUsd: null,
			lpFeesUsd: null,
			feeStatus: "estimated",
			tvlUsd: null,
			sqrtPriceStart: q96.toString(),
			sqrtPriceEnd: q96.toString(),
			source: "self_built",
			asOf: hour.asOf,
			gapReason: "missing USD",
		};
		const input = {
			client,
			pools: [target, anchor, bridge],
			windows: [row],
			hours: [hour],
			pricingAnchor: (a: string, b: string) => a === anchor.token0 && b === anchor.token1,
			loadDecimals: async (tokens: string[]) =>
				new Map(tokens.map((token) => [token.toLowerCase(), 6])),
		};
		const result = await repairClosedHour(input);
		const optimized = await repairClosedHour({
			...input,
			priceReaders: { v3: createV3PriceReader(), v4: createV4PriceReader() },
		});
		expect(optimized).toEqual(result);
		if (mode === "liquid") {
			expect(result.windows).toEqual([
				{ ...row, volumeUsd: "1", lpFeesUsd: "0.01", tvlUsd: "2", gapReason: null },
			]);
			const partial = { ...row, volumeUsd: "123.456", tvlUsd: "99", gapReason: null };
			const retained = await repairClosedHour({ ...input, windows: [partial] });
			expect(retained.windows).toEqual([{ ...partial, lpFeesUsd: "0.01" }]);
		} else expect(result.windows).toEqual([]);
		expect(result.hours).toEqual(mode === "failed" ? [] : [{ ...hour, usdBridgeVersion: 1 }]);
		if (mode === "zero") {
			multicall.mockClear();
			const second = await repairClosedHour({ ...input, hours: result.hours });
			expect(second.windows).toEqual([]);
			expect(multicall).not.toHaveBeenCalled();
		}
	},
);

it.each([false, true])(
	"bypasses a zero-liquidity direct bridge, already loaded=%s",
	async (loaded) => {
		const middle = "0x6666666666666666666666666666666666666666";
		const detour1 = pool(`0x${"7".repeat(64)}`, ZERO_ADDRESS, middle);
		const detour2 = pool(`0x${"8".repeat(64)}`, middle, x);
		const client = {
			multicall: vi.fn(
				async ({ contracts }: { contracts: Array<{ functionName: string; args: string[] }> }) =>
					contracts.map((call) => ({
						status: "success",
						result:
							call.functionName === "getSlot0"
								? [q96, 0, 0, 0]
								: call.args[0] === bridge.poolId
									? 0n
									: 100n,
					})),
			),
		} as unknown as PublicClient;
		const result = await supplementUsdPrices({
			client,
			pools: [bridge, detour1, detour2],
			blockNumber: 100n,
			prices: new Map([[ZERO_ADDRESS, new Decimal(7)]]),
			pricedPools: loaded ? [{ ...bridge, sqrtPriceX96: q96, liquidity: 0n }] : [],
			loadedPoolIds: new Set(loaded ? [bridge.poolId] : []),
			pricePolicy: { stable: [], requireLiquidity: true },
			neededTokens: [x],
			decimals: new Map([[ZERO_ADDRESS, 6]]),
			loadDecimals: async (tokens) => new Map(tokens.map((t) => [t, 6])),
		});
		expect(result.complete).toBe(true);
		expect(result.prices.get(x)?.minus(7).abs().lt("1e-17")).toBe(true);
		expect(result.prices.get(ZERO_ADDRESS)?.toString()).toBe("7");
	},
);
it("repairs namespaced Robinhood V3 by its raw address without replaying valid amounts", async () => {
	const usd = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
	const raw = `0x${"9".repeat(40)}`;
	const target = { ...pool(raw, usd, y, true), poolId: `4663:uniswap_v3:${raw}`, chainId: 4663 };
	const hour: StoredScannedHour = {
		chainId: 4663,
		protocol: "uniswap_v3",
		windowStart: 3600,
		windowEnd: 7200,
		complete: true,
		fromBlock: "91",
		toBlock: "100",
		stateBlockNumber: "100",
		priceBoundaryVersion: 0,
		usdBridgeVersion: 0,
		asOf: "1970-01-01T02:00:00Z",
		gapReason: null,
	};
	const row: StoredWindow = {
		poolId: target.poolId,
		windowStart: 3600,
		windowEnd: 7200,
		complete: true,
		volume0: "1000000",
		volume1: "1000000",
		lpFees0: "10000",
		lpFees1: "0",
		swapCount: 1,
		volumeUsd: "777",
		lpFeesUsd: null,
		feeStatus: "estimated",
		tvlUsd: null,
		sqrtPriceStart: null,
		sqrtPriceEnd: q96.toString(),
		source: "self_built",
		asOf: hour.asOf,
		gapReason: null,
	};
	const readV3 = vi.fn(async (_client, inputs, block) => {
		expect(inputs[0].poolAddress.toLowerCase()).toBe(raw);
		expect([90n, 100n]).toContain(block);
		return new Map([
			[
				raw,
				{
					poolId: raw,
					sqrtPriceX96: q96,
					tick: 0,
					liquidity: 100n,
					feeProtocol0: 0,
					feeProtocol1: 0,
					amount0: 1000000n,
					amount1: 1000000n,
				},
			],
		]);
	});
	const repaired = await repairClosedHour({
		client: {} as PublicClient,
		pools: [target],
		windows: [row],
		hours: [hour],
		pricingAnchor: () => false,
		loadDecimals: async () =>
			new Map([
				[usd, 6],
				[y, 6],
			]),
		pricePolicy: { stable: [usd], requireLiquidity: true },
		readers: {
			readV3PoolStates: readV3,
			readV4Slot0s: vi.fn().mockResolvedValue(new Map()),
			readV4Reserves: vi.fn().mockResolvedValue(new Map()),
			toV4PoolState: vi.fn(),
		},
	});
	expect(repaired.gaps).toEqual([]);
	expect(repaired.windows).toEqual([
		{ ...row, sqrtPriceStart: q96.toString(), lpFeesUsd: "0.01", tvlUsd: "2" },
	]);
	expect(repaired.hours).toEqual([{ ...hour, priceBoundaryVersion: 1, usdBridgeVersion: 1 }]);
});
it("loads only the needed namespaced V3 pricing bridge at the requested historical block", async () => {
	const raw = "0x9999999999999999999999999999999999999999";
	const v3bridge = {
		...pool(raw, ZERO_ADDRESS, x, true),
		chainId: 4663,
		poolId: `4663:uniswap_v3:${raw}`,
	};
	const readV3States = vi
		.fn()
		.mockResolvedValue(new Map([[raw, { sqrtPriceX96: q96, liquidity: 100n }]]));
	const result = await supplementUsdPrices({
		client: {} as PublicClient,
		pools: [v3bridge],
		blockNumber: 100n,
		prices: new Map([[ZERO_ADDRESS, new Decimal(7)]]),
		pricedPools: [],
		loadedPoolIds: new Set(),
		neededTokens: [x],
		decimals: new Map([[ZERO_ADDRESS, 6]]),
		loadDecimals: async () => new Map([[x, 6]]),
		readV3States,
		pricePolicy: { stable: [], requireLiquidity: true },
	});
	expect(result.complete).toBe(true);
	expect(result.prices.get(x)?.minus(7).abs().lt("1e-17")).toBe(true);
	expect(readV3States).toHaveBeenCalledTimes(1);
	expect(readV3States.mock.calls[0]?.[2]).toBe(100n);
	expect(readV3States.mock.calls[0]?.[1][0].poolAddress.toLowerCase()).toBe(raw);
});

it("reuses one catalog index across historical blocks and failures without changing path order", () => {
	const future = { ...bridge, poolId: "future", createdBlock: 101 };
	const pools = [anchor, target, future, pool("disconnected", "z", "w"), bridge];
	const index = buildPriceBridgeIndex(pools);
	for (const blockNumber of [100n, 102n, 100n]) {
		for (const excluded of [new Set<string>(), new Set([bridge.poolId])]) {
			const expected = missingPriceBridges({
				pools: pools.filter((p) => !excluded.has(p.poolId)),
				blockNumber,
				pricedTokens: [ZERO_ADDRESS],
				neededTokens: [y],
			});
			expect(
				missingPriceBridges({
					pools,
					index,
					excluded,
					blockNumber,
					pricedTokens: [ZERO_ADDRESS],
					neededTokens: [y],
				}),
			).toEqual(expected);
		}
	}
});

it("keeps deferred dollars and incomplete valuation without reading their states", async () => {
	const old: StoredWindow = {
		poolId: target.poolId,
		windowStart: 3600,
		windowEnd: 7200,
		complete: true,
		volume0: "100",
		volume1: "100",
		lpFees0: "1",
		lpFees1: "1",
		swapCount: 1,
		volumeUsd: null,
		lpFeesUsd: "5",
		tvlUsd: "8",
		feeStatus: "estimated",
		sqrtPriceStart: q96.toString(),
		sqrtPriceEnd: q96.toString(),
		source: "self_built",
		asOf: "1970-01-01T02:00:00Z",
		gapReason: null,
	};
	const read = vi.fn(async () => new Map());
	const result = await repairClosedHour({
		client: {} as PublicClient,
		pools: [target],
		windows: [old],
		hours: [
			{
				chainId: 99901,
				protocol: "uniswap_v3",
				windowStart: 3600,
				windowEnd: 7200,
				complete: true,
				fromBlock: "10",
				toBlock: "100",
				priceBoundaryVersion: 1,
				usdBridgeVersion: 1,
				asOf: old.asOf,
				gapReason: null,
			},
		],
		deferredUsdPoolIds: new Set([target.poolId]),
		pricePolicy: { stable: [], valuationVersion: 2 },
		pricingAnchor: () => false,
		loadDecimals: async () => new Map(),
		readers: {
			readV3PoolStates: read,
			readV4Slot0s: read,
			readV4Reserves: read,
			toV4PoolState: () => undefined,
		},
	});
	expect(read).not.toHaveBeenCalled();
	expect(result.windows).toEqual([]);
	expect(result.hours[0]?.usdValuationVersion).toBeNull();
});

it.each(["zero", "disconnected", "rpc-failure", "quote-failure", "reserves-failure"])(
	"records only evidenced historical deferrals: %s",
	async (mode) => {
		const w: StoredWindow = {
			poolId: target.poolId,
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			volume0: "100",
			volume1: "100",
			lpFees0: "1",
			lpFees1: "1",
			swapCount: 1,
			volumeUsd: null,
			lpFeesUsd: null,
			tvlUsd: null,
			feeStatus: "estimated",
			sqrtPriceStart: q96.toString(),
			sqrtPriceEnd: q96.toString(),
			source: "self_built",
			asOf: "1970-01-01T02:00:00Z",
			gapReason: null,
		};
		const quote = {
			assetId: "ETH" as const,
			priceUsd: "2",
			sourceId: "redstone_push" as const,
			feedId: "test",
			publishedAt: 7100,
			fetchedAt: w.asOf,
			sourceChainId: 1,
			sourceBlockNumber: "100",
			sourceBlockTimestamp: 7100,
			targetAt: 7199,
			sourceVersion: 1,
		};
		const result = await repairClosedHour({
			client: {} as PublicClient,
			pools: [target],
			completeCatalog: true,
			windows: [w],
			hours: [
				{
					chainId: 99901,
					protocol: "uniswap_v3",
					windowStart: 3600,
					windowEnd: 7200,
					complete: true,
					fromBlock: "10",
					toBlock: "100",
					priceBoundaryVersion: 1,
					usdBridgeVersion: 1,
					asOf: w.asOf,
					gapReason: null,
				},
			],
			pricePolicy: {
				stable: [ELYSIUM_USDC_ADDRESS],
				requireLiquidity: true,
				valuationVersion: 2,
				rootPrices: new Map([[ZERO_ADDRESS, new Decimal(2)]]),
				quote: mode === "quote-failure" ? undefined : quote,
			},
			pricingAnchor: () => false,
			loadDecimals: async () =>
				new Map([
					[x, 6],
					[y, 6],
				]),
			readers: {
				readV3PoolStates: async () =>
					mode === "rpc-failure"
						? new Map()
						: new Map([
								[
									target.poolId,
									{
										poolId: target.poolId,
										sqrtPriceX96: q96,
										tick: 0,
										liquidity: mode === "zero" ? 0n : 100n,
										amount0: mode === "reserves-failure" ? null : 100n,
										amount1: 100n,
										feeProtocol0: 0,
										feeProtocol1: 0,
									},
								],
							]),
				readV4Slot0s: async () => new Map(),
				readV4Reserves: async () => new Map(),
				toV4PoolState: () => undefined,
			},
		});
		expect(result.deferrals?.map((row) => row.reason)).toEqual(
			mode === "zero"
				? ["zero_end_liquidity"]
				: mode === "disconnected"
					? ["no_historical_path"]
					: [],
		);
		expect(result.windows).toEqual([]);
		expect(result.hours[0]?.usdValuationVersion).toBeNull();
	},
);
