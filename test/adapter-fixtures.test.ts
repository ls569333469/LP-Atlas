import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
	decodeV3PoolCreatedLog,
	decodeV3SwapLog,
	readV3PoolStates,
} from "../src/adapters/venues/elysium/uniswap-v3.ts";
import {
	decodeV4InitializeLog,
	decodeV4SwapLog,
	loadV4Swaps,
	readV4Reserves,
	readV4Slot0s,
} from "../src/adapters/venues/elysium/uniswap-v4.ts";
import {
	ELYSIUM_WHYPE_ADDRESS,
	UNISWAP_V3_ELYSIUM,
	UNISWAP_V4_ELYSIUM,
	V4_DYNAMIC_FEE_FLAG,
} from "../src/shared/constants.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

it("keeps successful reserves if the failed-only retry throws", async () => {
	const pool = (digit: string) => ({
		poolId: `0x${digit.repeat(64)}`,
		token0: `0x${"1".repeat(40)}` as const,
		token1: `0x${"2".repeat(40)}` as const,
		feePips: 100,
		tickSpacing: 1,
		hooks: null,
	});
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([
			{
				status: "success",
				result: { coreAmount0: 44n, coreAmount1: 55n, hasCustomAccounting: false },
			},
			{ status: "failure", error: new Error("429 Rate Limit Exceeded") },
		])
		.mockRejectedValue(new Error("execution reverted"));
	const pools = [pool("1"), pool("2")] as const;
	const result = await readV4Reserves({ multicall } as unknown as PublicClient, [...pools]);
	expect(result.get(pools[0].poolId)).toMatchObject({ amount0: 44n, amount1: 55n, gap: null });
	expect(result.get(pools[1].poolId)?.gap).toContain("429");
});

it("keeps successful V4 states if the failed-only retry throws", async () => {
	const poolIds = [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`] as const;
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([
			{ status: "success", result: [123n, 4, 0, 100] },
			{ status: "success", result: 88n },
			{ status: "failure", error: new Error("429 Rate Limit Exceeded") },
			{ status: "success", result: 99n },
		])
		.mockRejectedValue(new Error("execution reverted"));
	const result = await readV4Slot0s({ multicall } as unknown as PublicClient, [...poolIds]);
	expect(result.get(poolIds[0])).toMatchObject({ sqrtPriceX96: 123n, liquidity: 88n });
	expect(result.has(poolIds[1])).toBe(false);
});

it("keeps successful V3 states if the failed-only retry throws", async () => {
	const address = `0x${"1".repeat(40)}` as const;
	const other = `0x${"2".repeat(40)}` as const;
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([
			{ status: "success", result: [123n, 4, 0, 1, 1, 33, true] },
			{ status: "success", result: 88n },
			{ status: "success", result: 44n },
			{ status: "success", result: 55n },
			{ status: "failure", error: new Error("429 Rate Limit Exceeded") },
			{ status: "success", result: 99n },
			{ status: "success", result: 66n },
			{ status: "success", result: 77n },
		])
		.mockRejectedValue(new Error("execution reverted"));
	const result = await readV3PoolStates({ multicall } as unknown as PublicClient, [
		{ poolAddress: address, token0: address, token1: other },
		{ poolAddress: other, token0: address, token1: other },
	]);
	expect(result.get(address)).toMatchObject({ amount0: 44n, amount1: 55n });
	expect(result.has(other)).toBe(false);
});

it("retries failed reserve reads once while preserving successful pools and unresolved gaps", async () => {
	const pool = (digit: string) => ({
		poolId: `0x${digit.repeat(64)}`,
		token0: `0x${"1".repeat(40)}` as const,
		token1: `0x${"2".repeat(40)}` as const,
		feePips: 100,
		tickSpacing: 1,
		hooks: null,
	});
	const success = {
		status: "success",
		result: { coreAmount0: 44n, coreAmount1: 55n, hasCustomAccounting: false },
	};
	const failure = { status: "failure", error: new Error("429 Rate Limit Exceeded") };
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([success, failure, failure])
		.mockResolvedValueOnce([success, failure]);
	const pools = [pool("1"), pool("2"), pool("3")] as const;
	const result = await readV4Reserves(
		{ multicall } as unknown as PublicClient,
		[...pools],
		4,
		123n,
	);
	for (const [call] of multicall.mock.calls) expect(call.blockNumber).toBe(123n);
	expect(multicall).toHaveBeenCalledTimes(2);
	expect(multicall.mock.calls[1]?.[0].contracts).toHaveLength(2);
	expect(result.get(pools[0].poolId)).toMatchObject({ amount0: 44n, amount1: 55n, gap: null });
	expect(result.get(pools[1].poolId)).toMatchObject({ amount0: 44n, amount1: 55n, gap: null });
	expect(result.get(pools[2].poolId)?.gap).toContain("429");
});

it("recovers a failed V3 slot0 read without discarding valid balances", async () => {
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([
			{ status: "failure", error: new Error("temporary RPC failure") },
			{ status: "success", result: 88n },
			{ status: "success", result: 44n },
			{ status: "success", result: 55n },
		])
		.mockResolvedValueOnce([{ status: "success", result: [123n, 4, 0, 1, 1, 33, true] }]);
	const address = `0x${"1".repeat(40)}` as const;
	const result = await readV3PoolStates(
		{ multicall } as unknown as PublicClient,
		[{ poolAddress: address, token0: address, token1: address }],
		123n,
	);
	for (const [call] of multicall.mock.calls) expect(call.blockNumber).toBe(123n);
	expect(result.get(address)).toMatchObject({
		amount0: 44n,
		amount1: 55n,
		feeProtocol0: 1,
		feeProtocol1: 2,
	});
	expect(multicall).toHaveBeenCalledTimes(2);
	expect(multicall.mock.calls[1]?.[0].contracts).toHaveLength(1);
});

it("retries only failed state reads and keeps the successful liquidity result", async () => {
	const multicall = vi
		.fn()
		.mockResolvedValueOnce([
			{ status: "failure", error: new Error("temporary RPC failure") },
			{ status: "success", result: 88n },
		])
		.mockResolvedValueOnce([{ status: "success", result: [123n, 4, 0, 100] }]);
	const client = { multicall } as unknown as PublicClient;
	const poolId = `0x${"1".repeat(64)}`;
	const states = await readV4Slot0s(client, [poolId], 123n);
	for (const [call] of multicall.mock.calls) expect(call.blockNumber).toBe(123n);
	expect(states.get(poolId)).toEqual({
		sqrtPriceX96: 123n,
		tick: 4,
		protocolFee: 0,
		lpFee: 100,
		liquidity: 88n,
	});
	expect(multicall).toHaveBeenCalledTimes(2);
	expect(multicall.mock.calls[1]?.[0].contracts).toHaveLength(1);
});

function readLog(name: string): {
	address: `0x${string}`;
	topics: `0x${string}`[];
	data: `0x${string}`;
	blockNumber: `0x${string}`;
	logIndex: `0x${string}`;
	blockTimestamp: `0x${string}`;
} {
	return JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as {
		address: `0x${string}`;
		topics: `0x${string}`[];
		data: `0x${string}`;
		blockNumber: `0x${string}`;
		logIndex: `0x${string}`;
		blockTimestamp: `0x${string}`;
	};
}

describe("official log fixtures", () => {
	it("decodes a Uniswap V3 PoolCreated event from Elysium", () => {
		const pool = decodeV3PoolCreatedLog(readLog("v3-pool-created.json"));
		expect(pool.protocol).toBe("uniswap_v3");
		expect(pool.token1.toLowerCase()).toBe(ELYSIUM_WHYPE_ADDRESS.toLowerCase());
		expect(pool.feePips).toBe(10_000);
		expect(pool.tickSpacing).toBe(200);
		expect(pool.poolAddress?.toLowerCase()).toBe("0x5b34f4548e931567db20a511d4bc205fcd7fce68");
		expect(UNISWAP_V3_ELYSIUM.factory.toLowerCase()).toBe(
			"0x1707327f626496a7b5b3872e7e4d2879df7d7a9f",
		);
	});

	it("decodes a Uniswap V3 Swap event and isolates LP fees", () => {
		const swap = decodeV3SwapLog(readLog("v3-swap.json"), {
			feePips: 10_000,
			feeProtocol0: 0,
			feeProtocol1: 0,
		});
		expect(swap.protocol).toBe("uniswap_v3");
		expect(swap.inputIsToken0).toBe(false);
		expect(swap.lpFee > 0n).toBe(true);
		expect(swap.protocolFee).toBe(0n);
	});

	it("decodes a Uniswap V4 Initialize event, including a dynamic fee hook pool", () => {
		const pool = decodeV4InitializeLog(readLog("v4-initialize.json"));
		expect(pool.protocol).toBe("uniswap_v4");
		expect(pool.token0.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
		expect(pool.feePips & V4_DYNAMIC_FEE_FLAG).toBe(V4_DYNAMIC_FEE_FLAG);
		expect(pool.hooks?.toLowerCase()).toBe("0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec");
		expect(UNISWAP_V4_ELYSIUM.poolManager.toLowerCase()).toBe(
			"0xe2e105d3f7209a9da11f83ccf3e7398a753823f1",
		);
	});

	it("decodes a Uniswap V4 Swap event using the event fee, not a fee tier times volume", () => {
		const swap = decodeV4SwapLog(readLog("v4-swap.json"), () => 0);
		expect(swap.protocol).toBe("uniswap_v4");
		expect(swap.feePips).toBe(100);
		// Real event: 9.83 WHYPE paid in, token0 received out; fee is in WHYPE.
		expect(swap.inputIsToken0).toBe(false);
		expect(swap.amount1).toBe(-9_830_000_000_000_000_000n);
		expect(swap.lpFee).toBe(983_000_000_000_000n);
	});
});

it("narrows a larger swap range on the node log limit without gaps or duplicate events", async () => {
	const fixture = JSON.parse(readFileSync(path.join(fixtures, "v4-swap.json"), "utf8"));
	const ranges: bigint[][] = [];
	const client = {
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			ranges.push([fromBlock, toBlock]);
			if (toBlock - fromBlock + 1n > 2000n)
				throw new Error("logs count limit exceeded (10000) consider refine/narrow down your query");
			return [{ ...fixture, blockNumber: fromBlock, logIndex: 0 }];
		},
	} as unknown as PublicClient;
	const swaps = await loadV4Swaps(client, 0n, 7999n, new Map());
	expect(ranges[0]).toEqual([0n, 7999n]);
	expect(swaps.map((s) => s.blockNumber)).toEqual([0n, 2000n, 4000n, 6000n]);
	expect(swaps).toHaveLength(4);
});
it.each([false, true])(
	"splits gas-capped reserve batches without unchanged retries, thrown=%s",
	async (thrown) => {
		const pools = ["1", "2", "3", "4"].map((digit) => ({
			poolId: `0x${digit.repeat(64)}`,
			token0: `0x${"1".repeat(40)}` as const,
			token1: `0x${"2".repeat(40)}` as const,
			feePips: 100,
			tickSpacing: 1,
			hooks: null,
		}));
		const multicall = vi.fn(
			async ({
				contracts,
				blockNumber,
			}: {
				contracts: Array<{ args: readonly unknown[] }>;
				blockNumber: bigint;
			}) => {
				expect(blockNumber).toBe(123n);
				if (contracts.length > 1) {
					if (thrown) throw new Error("out of gas");
					return contracts.map(() => ({ status: "failure", error: new Error("out of gas") }));
				}
				const key = contracts[0]?.args[1] as { currency0: string };
				expect(key.currency0).toBe(pools[0]?.token0);
				return [
					{
						status: "success",
						result: { coreAmount0: 44n, coreAmount1: 55n, hasCustomAccounting: false },
					},
				];
			},
		);
		const result = await readV4Reserves({ multicall } as unknown as PublicClient, pools, 1, 123n);
		expect(result.size).toBe(4);
		for (const pool of pools)
			expect(result.get(pool.poolId)).toMatchObject({ amount0: 44n, amount1: 55n, gap: null });
		// 4 -> 2+2 -> 1+1+1+1. No unchanged retry of the gas-capped batch.
		expect(multicall).toHaveBeenCalledTimes(7);
	},
);
it("keeps a single irreducible gas failure while recovering its neighbor", async () => {
	const pools = [100, 200].map((feePips) => ({
		poolId: String(feePips),
		token0: `0x${"1".repeat(40)}` as const,
		token1: `0x${"2".repeat(40)}` as const,
		feePips,
		tickSpacing: 1,
		hooks: null,
	}));
	const multicall = vi.fn(
		async ({ contracts }: { contracts: Array<{ args: readonly unknown[] }> }) =>
			contracts.map((contract) =>
				contracts.length > 1 || (contract.args[1] as { fee: number }).fee === 200
					? { status: "failure", error: new Error("out of gas") }
					: {
							status: "success",
							result: { coreAmount0: 44n, coreAmount1: 55n, hasCustomAccounting: false },
						},
			),
	);
	const result = await readV4Reserves({ multicall } as unknown as PublicClient, pools, 1, 123n);
	expect(result.get("100")).toMatchObject({ amount0: 44n, amount1: 55n, gap: null });
	expect(result.get("200")?.gap).toContain("out of gas");
	expect(multicall).toHaveBeenCalledTimes(4);
});
