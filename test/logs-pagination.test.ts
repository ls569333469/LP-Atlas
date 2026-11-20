import type { Log, PublicClient } from "viem";
import { expect, it } from "vitest";
import { v4PoolManagerAbi } from "../src/adapters/abi.ts";
import { RpcFailureError } from "../src/adapters/errors.ts";
import { getLogsPaginated } from "../src/adapters/logs.ts";
import { refreshDiagnostics, refreshGaps } from "../src/normalize/refresh-pipeline.ts";

const event = v4PoolManagerAbi[1];
const row = (blockNumber: bigint) => ({ blockNumber, logIndex: 0 }) as Log;

it("shares eight log slots across concurrent protocols and preserves range order", async () => {
	let active = 0,
		peak = 0;
	const client = {
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, Number(20n - fromBlock)));
			active--;
			return Array.from({ length: Number(toBlock - fromBlock + 1n) }, (_, i) =>
				row(fromBlock + BigInt(i)),
			);
		},
	} as unknown as PublicClient;
	const request = { client, event, fromBlock: 0n, toBlock: 15n, chunkSize: 2n, concurrency: 8 };
	const results = await Promise.all([getLogsPaginated(request), getLogsPaginated(request)]);
	expect(peak).toBe(8);
	for (const result of results)
		expect(result.map((r) => r.blockNumber)).toEqual(
			Array.from({ length: 16 }, (_, i) => BigInt(i)),
		);
});

it("splits failed ranges without losing or duplicating blocks", async () => {
	const client = {
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			if (toBlock > fromBlock) throw new RpcFailureError("rpc_down", "timeout");
			return [row(fromBlock)];
		},
	} as unknown as PublicClient;
	const logs = await getLogsPaginated({
		client,
		event,
		fromBlock: 0n,
		toBlock: 7n,
		chunkSize: 8n,
		concurrency: 8,
	});
	expect(logs.map((r) => r.blockNumber)).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]);
});

it("bounds connection-failure splitting and rejects the entire incomplete result", async () => {
	let calls = 0;
	const client = {
		getLogs: async () => {
			calls++;
			throw new RpcFailureError("rpc_down", "offline");
		},
	} as unknown as PublicClient;
	await expect(
		getLogsPaginated({
			client,
			event,
			fromBlock: 0n,
			toBlock: 1999n,
			chunkSize: 2000n,
			concurrency: 8,
		}),
	).rejects.toThrow("offline");
	// Both halves are attempted; four split levels remain a finite request bound.
	expect(calls).toBeLessThanOrEqual(31);
});

it("shrinks oversized HTTP responses past the connection-failure depth without losing logs", async () => {
	const client = {
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			if (toBlock > fromBlock)
				throw new Error("HTTP response body exceeded the size limit. Max: 10485760 bytes");
			return [row(fromBlock)];
		},
	} as unknown as PublicClient;
	const logs = await getLogsPaginated({
		client,
		event,
		fromBlock: 0n,
		toBlock: 31n,
		chunkSize: 32n,
		concurrency: 8,
	});
	expect(logs.map((log) => log.blockNumber)).toEqual(
		Array.from({ length: 32 }, (_, index) => BigInt(index)),
	);
});

it("reads split halves concurrently, keeps their order and drains a failed sibling", async () => {
	let active = 0;
	let peak = 0;
	let failLeft = false;
	const client = {
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			if (toBlock > fromBlock) throw new RpcFailureError("rpc_range_limited", "split");
			active++;
			peak = Math.max(peak, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, fromBlock === 0n ? 1 : 10));
				if (failLeft && fromBlock === 0n) throw new RpcFailureError("rpc_down", "left failed");
				return [row(fromBlock)];
			} finally {
				active--;
			}
		},
	} as unknown as PublicClient;
	const request = { client, event, fromBlock: 0n, toBlock: 1n, chunkSize: 2n, concurrency: 2 };
	expect((await getLogsPaginated(request)).map((log) => log.blockNumber)).toEqual([0n, 1n]);
	expect(peak).toBe(2);
	failLeft = true;
	await expect(getLogsPaginated(request)).rejects.toThrow("left failed");
	expect(active).toBe(0);
});

it("backs off and reduces shared concurrency after rate limiting", async () => {
	let first = true,
		active = 0,
		peak = 0;
	const client = {
		getLogs: async ({ fromBlock }: { fromBlock: bigint }) => {
			if (first) {
				first = false;
				throw new RpcFailureError("rpc_rate_limited", "429");
			}
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 2));
			active--;
			return [row(fromBlock)];
		},
	} as unknown as PublicClient;
	await getLogsPaginated({
		client,
		event,
		fromBlock: 0n,
		toBlock: 0n,
		chunkSize: 1n,
		concurrency: 8,
	});
	const logs = await getLogsPaginated({
		client,
		event,
		fromBlock: 0n,
		toBlock: 15n,
		chunkSize: 1n,
		concurrency: 8,
	});
	expect(peak).toBeLessThanOrEqual(4);
	expect(logs).toHaveLength(16);
});

it("retains scan failures before chain-prefixed pool notices", () => {
	const notices = Array.from({ length: 90 }, (_, i) => `4663:uniswap_v4:0x${i}: 自定义记账`);
	const failure = "Uniswap V4 窗口拉取失败：timeout";
	expect(refreshGaps([...notices, failure])[0]).toBe(failure);
	expect(refreshGaps(notices)).toHaveLength(90);
});

it("separates Hook reserve limits without dropping any real failures", () => {
	const notices = Array.from(
		{ length: 95 },
		(_, i) =>
			`4663:uniswap_v4:0x${i}: 该池 hook 可能有自定义记账，ReservesLens 的 core 金额可能不是全部可兑换深度`,
	);
	const failures = Array.from(
		{ length: 85 },
		(_, i) => `0x${i}: 官方 ReservesLens 未能读出 TVL：429`,
	);
	const result = refreshDiagnostics([...notices, ...failures, notices[0]!], ["public_temporary"]);
	expect(result.gaps).toHaveLength(85);
	expect(result.gaps).toEqual(failures);
	expect(result.warnings).toContain("public_temporary");
	expect(result.warnings).toContain(notices[94]);
	expect(result.warnings.join(" ")).toContain("95 个池");
});
