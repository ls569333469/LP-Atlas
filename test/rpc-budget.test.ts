import {
	createPublicClient,
	custom,
	decodeFunctionData,
	encodeFunctionResult,
	multicall3Abi,
} from "viem";
import { afterEach, expect, it, vi } from "vitest";
import {
	createRpcBudget,
	forEachRpcBatch,
	limitRpcTransport,
	robinhoodRpcTransport,
	withRpcCategory,
} from "../src/adapters/rpc-budget.ts";

afterEach(() => vi.useRealTimers());
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("counts actual Multicall split requests against the state budget", async () => {
	let active = 0;
	let peak = 0;
	let requests = 0;
	const abi = [
		{
			type: "function",
			name: "value",
			stateMutability: "view",
			inputs: [],
			outputs: [{ type: "uint256" }],
		},
	] as const;
	const transport = limitRpcTransport(
		custom(
			{
				request: async ({ params }) => {
					const call = (params as [{ data: `0x${string}` }])[0];
					const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data });
					if (decoded.functionName !== "aggregate3") throw new Error("unexpected call");
					active++;
					requests++;
					peak = Math.max(peak, active);
					await tick();
					active--;
					return encodeFunctionResult({
						abi: multicall3Abi,
						functionName: "aggregate3",
						result: decoded.args[0].map(() => ({
							success: true,
							returnData: encodeFunctionResult({ abi, functionName: "value", result: 7n }),
						})),
					});
				},
			},
			{ retryCount: 0 },
		),
		createRpcBudget(),
	);
	const client = createPublicClient({ transport });
	const result = await withRpcCategory("state", () =>
		client.multicall({
			contracts: Array.from({ length: 96 }, () => ({
				address: `0x${"1".repeat(40)}` as const,
				abi,
				functionName: "value" as const,
			})),
			multicallAddress: `0x${"2".repeat(40)}`,
			batchSize: 1,
			blockNumber: 100n,
		}),
	);
	expect(requests).toBe(96);
	expect(peak).toBe(32);
	expect(active).toBe(0);
	expect(result).toEqual(Array.from({ length: 96 }, () => ({ status: "success", result: 7n })));
});

it("shares 64 total slots across clients and categories without reserving idle capacity", async () => {
	const active = { total: 0, state: 0, reserve: 0, logs: 0, other: 0 };
	const peaks = { ...active };
	const transport = custom(
		{
			request: async ({ method, params }) => {
				const category =
					method === "eth_getLogs"
						? "logs"
						: ((params as string[])[0] as "state" | "reserve" | "other");
				active.total++;
				active[category]++;
				peaks.total = Math.max(peaks.total, active.total);
				peaks[category] = Math.max(peaks[category], active[category]);
				await tick();
				active.total--;
				active[category]--;
				return "0x1";
			},
		},
		{ retryCount: 0 },
	);
	const a = createPublicClient({ transport: robinhoodRpcTransport("budget-test", transport) });
	const b = createPublicClient({ transport: robinhoodRpcTransport("budget-test", transport) });
	const tasks = (["state", "logs", "reserve", "other"] as const).flatMap((category) =>
		Array.from({ length: 100 }, (_, i) =>
			withRpcCategory(category, () =>
				(i % 2 ? a : b).request({
					method: category === "logs" ? "eth_getLogs" : "eth_call",
					params: [category],
				} as never),
			),
		),
	);
	expect(await Promise.all(tasks)).toHaveLength(400);
	expect(peaks.total).toBe(64);
	expect(peaks.state).toBe(32);
	expect(peaks.logs).toBe(16);
	expect(peaks.reserve).toBeLessThanOrEqual(64);
	expect(peaks.other).toBeLessThanOrEqual(64);
	await Promise.all(
		Array.from({ length: 100 }, () =>
			withRpcCategory("reserve", () =>
				a.request({ method: "eth_call", params: ["reserve"] } as never),
			),
		),
	);
	expect(peaks.reserve).toBe(64);
	expect(active.total).toBe(0);
});

it("releases failed requests, halves the affected category on 429, and drains after backoff", async () => {
	vi.useFakeTimers();
	const budget = createRpcBudget();
	await expect(
		budget.run("state", async () => {
			throw new Error("HTTP 429");
		}),
	).rejects.toThrow("429");
	let active = 0;
	let peak = 0;
	const transport = limitRpcTransport(
		custom(
			{
				request: async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 1));
					active--;
					return "0x1";
				},
			},
			{ retryCount: 0 },
		),
		budget,
	);
	const client = createPublicClient({ transport });
	const work = Promise.all(
		Array.from({ length: 40 }, () =>
			withRpcCategory("state", () => client.request({ method: "eth_blockNumber" })),
		),
	);
	await vi.advanceTimersByTimeAsync(399);
	expect(peak).toBe(0);
	await vi.runAllTimersAsync();
	await work;
	expect(peak).toBe(16);
	expect(active).toBe(0);
	await expect(
		budget.run("other", async () => {
			throw new Error("connection failed");
		}),
	).rejects.toThrow();
	await expect(budget.run("other", async () => 123)).resolves.toBe(123);
});

it("drains already-started batches on failure and does not schedule remaining batches", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started: number[] = [];
	let finished = false;
	const job = forEachRpcBatch([0, 1, 2, 3], 1, 2, async ([id]) => {
		started.push(id as number);
		if (id === 0) throw new Error("batch failed");
		await gate;
	}).finally(() => {
		finished = true;
	});
	const assertion = expect(job).rejects.toThrow("batch failed");
	await tick();
	expect(finished).toBe(false);
	expect(started).toEqual([0, 1]);
	release();
	await assertion;
	expect(started).toEqual([0, 1]);
});
