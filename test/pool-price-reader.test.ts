import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { readV3PoolStates as readElysiumV3 } from "../src/adapters/venues/elysium/uniswap-v3.ts";
import {
	createV3PriceReader,
	readV3PoolStates,
} from "../src/adapters/venues/robinhood/uniswap-v3.ts";
import {
	createV4PriceReader,
	readV4Reserves,
	readV4Slot0s,
} from "../src/adapters/venues/robinhood/uniswap-v4.ts";

const address = `0x${"1".repeat(40)}` as const;
const token0 = `0x${"2".repeat(40)}` as const;
const token1 = `0x${"3".repeat(40)}` as const;
const v4Id = `4663:uniswap_v4:0x${"4".repeat(64)}`;
const q96 = 2n ** 96n;
function fixture() {
	const multicall = vi.fn(
		async ({
			contracts,
			blockNumber,
		}: {
			contracts: Array<{ functionName: string }>;
			blockNumber: bigint;
		}) =>
			contracts.map((call) => ({
				status: "success" as const,
				result:
					call.functionName === "slot0"
						? [q96 + blockNumber, 0, 0, 0, 0, 0, true]
						: call.functionName === "getSlot0"
							? [q96 + blockNumber, 0, 0, 10000]
							: 100n,
			})),
	);
	return { multicall, client: { multicall } as unknown as PublicClient };
}

it("matches full V3/V4 state prices with only one boundary subcall per pool", async () => {
	const { client, multicall } = fixture();
	const full3 = await readV3PoolStates(client, [{ poolAddress: address, token0, token1 }], 100n);
	expect(multicall.mock.calls[0]?.[0].contracts).toHaveLength(4);
	const full4 = await readV4Slot0s(client, [v4Id], 100n);
	expect(multicall.mock.calls[1]?.[0].contracts).toHaveLength(2);
	for (const [reader, id, full] of [
		[createV3PriceReader(), address, full3.get(address)],
		[createV4PriceReader(), v4Id, full4.get(v4Id)],
	] as const) {
		const result = await reader.readBoundaries(client, [id], 100n);
		expect(result.get(id)).toEqual({ sqrtPriceX96: full?.sqrtPriceX96 });
		expect(multicall.mock.lastCall?.[0].contracts).toHaveLength(1);
		expect(multicall.mock.lastCall?.[0].blockNumber).toBe(100n);
	}
});

it("reuses seeded exact-block results, fills only missing pools and liquidity, and isolates blocks and refreshes", async () => {
	const { client, multicall } = fixture();
	const reader = createV3PriceReader();
	reader.seed(100n, new Map([[address, { sqrtPriceX96: q96, liquidity: 123n }]]));
	expect((await reader.readQuotes(client, [address], 100n)).get(address)?.liquidity).toBe(123n);
	await reader.readBoundaries(client, [address], 100n);
	expect(multicall).not.toHaveBeenCalled();
	await reader.readBoundaries(client, [address, token0], 100n);
	expect(multicall.mock.lastCall?.[0].contracts).toHaveLength(1);
	await reader.readQuotes(client, [token0], 100n);
	expect(multicall.mock.lastCall?.[0].contracts.map((call) => call.functionName)).toEqual([
		"liquidity",
	]);
	expect((await reader.readBoundaries(client, [address], 101n)).get(address)?.sqrtPriceX96).toBe(
		q96 + 101n,
	);
	const count = multicall.mock.calls.length;
	await createV3PriceReader().readBoundaries(client, [address], 100n);
	expect(multicall).toHaveBeenCalledTimes(count + 1);
});

it("retains the preceding end block while reading the next end before its boundary", async () => {
	const { client, multicall } = fixture();
	const reader = createV4PriceReader();
	reader.seed(100n, new Map([[v4Id, { sqrtPriceX96: q96 }]]));
	await reader.readBoundaries(client, [v4Id], 50n);
	reader.seed(150n, new Map([[v4Id, { sqrtPriceX96: q96 + 1n }]]));
	const count = multicall.mock.calls.length;
	expect((await reader.readBoundaries(client, [v4Id], 100n)).get(v4Id)?.sqrtPriceX96).toBe(q96);
	expect(multicall).toHaveBeenCalledTimes(count);
	await reader.readBoundaries(client, [v4Id], 99n);
	expect(multicall).toHaveBeenCalledTimes(count + 1);
});

it("reads two quote subcalls, retries failed fields only, and does not invent missing liquidity", async () => {
	const { client, multicall } = fixture();
	const reader = createV3PriceReader();
	multicall
		.mockResolvedValueOnce([
			{ status: "success", result: [q96, 0, 0, 0, 0, 0, true] },
			{ status: "failure", error: new Error("unavailable") },
		] as never)
		.mockResolvedValueOnce([{ status: "failure", error: new Error("unavailable") }] as never);
	expect(await reader.readQuotes(client, [address], 100n)).toEqual(new Map());
	expect(multicall.mock.calls[0]?.[0].contracts).toHaveLength(2);
	expect(multicall.mock.calls[1]?.[0].contracts.map((call) => call.functionName)).toEqual([
		"liquidity",
	]);
	expect((await reader.readBoundaries(client, [address], 100n)).get(address)?.sqrtPriceX96).toBe(
		q96,
	);
	expect(multicall).toHaveBeenCalledTimes(2);
	expect((await reader.readQuotes(client, [address], 100n)).get(address)?.liquidity).toBe(100n);
	expect(multicall.mock.lastCall?.[0].contracts.map((call) => call.functionName)).toEqual([
		"liquidity",
	]);
});

it("parallelizes Robinhood state and quote batches while preserving results and Elysium serial reads", async () => {
	const pools = Array.from({ length: 40 * 34 }, (_, index) => ({
		poolAddress: `0x${(index + 10).toString(16).padStart(40, "0")}` as `0x${string}`,
		token0,
		token1,
	}));
	const ids4 = Array.from(
		{ length: 80 * 34 },
		(_, index) => `4663:uniswap_v4:0x${(index + 10).toString(16).padStart(64, "0")}`,
	);
	const { client, multicall } = fixture();
	const original = multicall.getMockImplementation();
	if (!original) throw new Error("missing fixture implementation");
	let active = 0;
	let peak = 0;
	multicall.mockImplementation(async (args) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, multicall.mock.calls.length === 1 ? 5 : 1));
		try {
			return await original(args);
		} finally {
			active--;
		}
	});
	const full3 = await readV3PoolStates(client, pools, 100n);
	expect(peak).toBe(32);
	expect([...full3.keys()]).toEqual(pools.map((pool) => pool.poolAddress));
	expect(full3.get(`0x${"a".padStart(40, "0")}`)?.amount0).toBe(100n);
	peak = 0;
	const full4 = await readV4Slot0s(client, ids4, 100n);
	expect(peak).toBe(32);
	expect([...full4.keys()]).toEqual(ids4);
	for (const [reader, ids] of [
		[createV3PriceReader(), pools.map((pool) => pool.poolAddress)],
		[createV4PriceReader(), ids4],
	] as const) {
		peak = 0;
		const result = await reader.readQuotes(client, ids, 100n);
		expect(peak).toBe(32);
		expect(result.size).toBe(ids.length);
		expect(
			[...result.values()].every(
				(value) => value.sqrtPriceX96 === q96 + 100n && value.liquidity === 100n,
			),
		).toBe(true);
	}
	peak = 0;
	const serial = await readElysiumV3(client, pools.slice(0, 120), 100n);
	expect(peak).toBe(1);
	expect([...serial]).toEqual([...full3].slice(0, 120));
	expect(active).toBe(0);
});

it("uses up to 64 Robinhood reserve batches and preserves reserve amounts", async () => {
	let active = 0;
	let peak = 0;
	const client = {
		multicall: async ({ contracts }: { contracts: unknown[] }) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return contracts.map(() => ({
				status: "success",
				result: { coreAmount0: 7n, coreAmount1: 9n, hasCustomAccounting: false },
			}));
		},
	} as unknown as PublicClient;
	const pools = Array.from({ length: 650 }, (_, index) => ({
		poolId: `4663:uniswap_v4:0x${index.toString(16).padStart(64, "0")}`,
		token0,
		token1,
		feePips: 10000,
		tickSpacing: 200,
		hooks: null,
	}));
	const result = await readV4Reserves(client, pools, undefined, 100n);
	expect(peak).toBe(64);
	expect(result.size).toBe(650);
	expect(
		[...result.values()].every(
			(value) => value.amount0 === 7n && value.amount1 === 9n && value.gap === null,
		),
	).toBe(true);
	expect(active).toBe(0);
});
