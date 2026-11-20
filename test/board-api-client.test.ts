import { afterEach, expect, it, vi } from "vitest";
import { fetchBoard } from "../src/web/src/api.ts";

afterEach(() => vi.unstubAllGlobals());

it("sends bounded page queries and the cancellation signal to fetch", async () => {
	const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, rows: [] })));
	vi.stubGlobal("fetch", request);
	const controller = new AbortController();
	await fetchBoard({
		page: 2,
		pageSize: 100,
		snapshotId: "pinned-version",
		sort: { window: "24h" },
		signal: controller.signal,
	});
	const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
	const params = new URL(url, "http://localhost").searchParams;
	expect(new URL(url, "http://localhost").pathname).toBe("/api/v2/board");
	expect(params.get("page")).toBe("2");
	expect(params.get("pageSize")).toBe("100");
	expect(params.get("window")).toBe("24h");
	expect(params.get("snapshotId")).toBe("pinned-version");
	expect(options.signal).toBe(controller.signal);
});

it("preserves the actionable expired-snapshot error", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: false, error: "查询快照已失效，请重试加载" }), {
					status: 409,
				}),
		),
	);
	await expect(fetchBoard({ page: 2, pageSize: 50, snapshotId: "expired" })).rejects.toThrow(
		"查询快照已失效",
	);
});

it("sends filter values with their units and keeps them on detail snapshot requests", async () => {
	const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, rows: [] })));
	vi.stubGlobal("fetch", request);
	const conditions = [
		{ field: "feesApr" as const, window: "1h" as const, operator: ">" as const, value: "30" },
	];
	await fetchBoard({
		filters: { minLpFees1hUsd: "30", feeTierPips: 0, metricConditions: conditions },
		snapshotId: "same",
		poolKeys: ["pool"],
		includeWindows: "all",
	});
	const [url] = request.mock.calls[0] as unknown as [string, RequestInit];
	const params = new URL(url, "http://localhost").searchParams;
	expect(params.get("minLpFees1hUsd")).toBe("30");
	expect(params.get("feeTierPips")).toBe("0");
	expect(JSON.parse(params.get("metricConditions")!)).toEqual(conditions);
	expect(params.get("snapshotId")).toBe("same");
});
