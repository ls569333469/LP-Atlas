import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
	MeteoraRequestBudget,
	readMeteoraCandidates,
	readMeteoraPool,
} from "../src/adapters/venues/solana/meteora-dlmm.ts";

const poolId = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const fixture = () =>
	JSON.parse(fs.readFileSync(new URL("./fixtures/meteora/pool-0.json", import.meta.url), "utf8"));
afterEach(() => vi.useRealTimers());

it("discovers only filtered candidates and reuses list metadata without per-pool detail reads", async () => {
	const pool = fixture();
	delete pool.reserve_x;
	delete pool.reserve_y;
	pool.created_at = 1795000000123;
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(
				JSON.stringify({
					total: 1,
					pages: 1,
					current_page: 1,
					page_size: 1000,
					data: [pool],
				}),
			),
	);
	const result = await readMeteoraCandidates({ fetchImpl, budget: new MeteoraRequestBudget() });
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
	expect(url.searchParams.get("filter_by")).toBe("tvl>=1000 && volume_1h>=100");
	expect(url.searchParams.get("sort_by")).toBe("volume_1h:desc");
	expect(url.searchParams.get("page_size")).toBe("1000");
	expect(result[0]).toMatchObject({
		address: poolId,
		reserveX: null,
		reserveY: null,
		createdAtUnix: 1795000000,
	});
	expect(result[0]?.reportedStatistics).toHaveProperty("fees");
});

it("rejects truncated discovery rather than replacing a published directory with a partial page", async () => {
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(
				JSON.stringify({
					total: 2,
					pages: 1,
					current_page: 1,
					page_size: 1000,
					data: [fixture()],
				}),
			),
	);
	await expect(
		readMeteoraCandidates({ fetchImpl, budget: new MeteoraRequestBudget() }),
	).rejects.toThrow("Incomplete");
});

it("isolates a malformed candidate while checking the full raw page count", async () => {
	const invalid = { ...fixture(), address: "invalid" };
	const notices: string[] = [];
	const fetchImpl: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				total: 2,
				pages: 1,
				current_page: 1,
				page_size: 1000,
				data: [fixture(), invalid],
			}),
		);
	const result = await readMeteoraCandidates({
		fetchImpl,
		onInvalidPool: (message) => notices.push(message),
	});
	expect(result).toHaveLength(1);
	expect(notices).toHaveLength(1);
});

it("shares pacing and concurrency between all queued endpoint requests", async () => {
	vi.useFakeTimers();
	const budget = new MeteoraRequestBudget(2, 16);
	const starts: number[] = [];
	let active = 0;
	let peak = 0;
	const pending = Promise.all(
		Array.from({ length: 20 }, () =>
			budget.run(async () => {
				starts.push(Date.now());
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 200));
				active--;
			}),
		),
	);
	await vi.runAllTimersAsync();
	await pending;
	expect(peak).toBe(2);
	for (let i = 1; i < starts.length; i++)
		expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(62);
	expect(starts.at(-1)! - starts[0]!).toBeGreaterThan(1200);
});

it("honors Retry-After and bounds a retry through the same shared queue", async () => {
	vi.useFakeTimers();
	const starts: number[] = [];
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
		starts.push(Date.now());
		return starts.length === 1
			? new Response("limited", { status: 429, headers: { "retry-after": "2" } })
			: new Response(JSON.stringify(fixture()));
	});
	const pending = readMeteoraPool(poolId, { fetchImpl, budget: new MeteoraRequestBudget() });
	await vi.runAllTimersAsync();
	expect((await pending).address).toBe(poolId);
	expect(starts).toHaveLength(2);
	expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2000);
});
