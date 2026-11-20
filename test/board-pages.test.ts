import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultBoardFilters, filterBoardRows, sortBoardRows } from "../src/metrics/filter-sort.ts";
import { BoardPageError, createBoardPager } from "../src/server/board-pages.ts";
import { enabledVenues, productCatalog } from "../src/shared/catalog.ts";
import { BOARD_COLUMNS, BOARD_WINDOWS, DEFAULT_BOARD_SORT } from "../src/shared/constants.ts";
import { poolIdentity } from "../src/shared/pool-identity.ts";
import type { BoardRow, BoardSuccessResponse, MetricValue } from "../src/shared/types.ts";

const metric = (value: string | null): MetricValue => ({
	value,
	source: "self_built",
	asOf: "2026-11-12T06:00:00Z",
	complete: true,
});

function row(index: number): BoardRow {
	return {
		poolId: `pool-${String(index).padStart(5, "0")}`,
		chainId: 99901,
		chain: "elysium",
		protocol: "uniswap_v3",
		pairLabel: "A/B",
		token0: { chainId: 99901, address: "0x01", symbol: "A", decimals: 18 },
		token1: { chainId: 99901, address: "0x02", symbol: "B", decimals: 18 },
		feeTierPips: 500,
		feeTierLabel: "0.05%",
		hookType: null,
		tvlUsd: metric("1000"),
		volumeUsd: metric("100"),
		feesUsd: metric("10"),
		feesApr: metric(String(index)),
		changeVsPrevWindow: metric(null),
		priceChange: metric(null),
		capitalEfficiency: metric("0.1"),
		poolAgeSeconds: metric("3600"),
	};
}

function board(rows: BoardRow[]): BoardSuccessResponse {
	return {
		ok: true,
		rows,
		columns: BOARD_COLUMNS,
		catalog: productCatalog(),
		enabledVenues: enabledVenues(),
		chainRpcSources: [],
		defaultFilters: defaultBoardFilters(),
		appliedFilters: defaultBoardFilters(),
		sort: DEFAULT_BOARD_SORT,
		source: "self_built",
		rpcSource: { kind: "public_temporary", label: "fixture" },
		discoveredPoolCount: [],
		asOf: "2026-11-12T06:00:00Z",
		windowStart: null,
		windowEnd: null,
		currentHourComplete: true,
		rowCountBeforeFilter: rows.length,
		gaps: [],
		warnings: [],
		refresh: {
			status: "partial",
			startedAt: null,
			finishedAt: null,
			lastSuccessAt: "2026-11-12T06:00:00Z",
			error: null,
			scopeChain: null,
			scopeProtocol: null,
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("frozen board pagination", () => {
	it.each([0, 1, 49, 50, 51, 20_000])(
		"globally sorts %i rows before paging with correct boundaries",
		async (count) => {
			const source = board(Array.from({ length: count }, (_, index) => row(index)));
			const read = vi.fn(async () => ({
				...source,
				rows: sortBoardRows(filterBoardRows(source.rows, defaultBoardFilters())),
			}));
			const paging = createBoardPager();
			const first = await paging({
				query: { page: "1", pageSize: "50" },
				key: "default",
				revision: "1",
				read,
			});
			expect(first.ok).toBe(true);
			if (!first.ok) throw new Error("fixture failed");
			expect(first.rows.length).toBe(Math.min(count, 50));
			expect(first.pagination).toMatchObject({
				total: count,
				totalPages: Math.ceil(count / 50),
				from: count ? 1 : 0,
				to: Math.min(count, 50),
			});
			if (count) expect(first.rows[0]?.poolId).toBe(row(count - 1).poolId);
			for (const size of [50, 100, 200]) {
				const ids: string[] = [];
				for (let page = 1; page <= Math.max(1, Math.ceil(count / size)); page++) {
					const result = await paging({
						query: {
							page: String(page),
							pageSize: String(size),
							snapshotId: first.pagination?.snapshotId,
						},
						key: "default",
						revision: "2",
						read,
					});
					if (!result.ok) throw new Error("fixture failed");
					expect(result.rows.length).toBeLessThanOrEqual(size);
					ids.push(...result.rows.map((item) => item.poolId));
				}
				expect(ids).toHaveLength(count);
				expect(new Set(ids).size).toBe(count);
				if (count) expect(ids.at(-1)).toBe(row(0).poolId);
			}
			expect(read).toHaveBeenCalledTimes(1);
		},
		10_000,
	);

	it("freezes values while a newer scan changes source rows and reuses reads", async () => {
		const source = board([row(1), row(2)]);
		const read = vi.fn(async () => source);
		const paging = createBoardPager();
		const input = { query: { page: "1" }, key: "1h", revision: "1", read };
		const [first, same] = await Promise.all([paging(input), paging(input)]);
		expect(read).toHaveBeenCalledTimes(1);
		if (!first.ok || !same.ok) throw new Error("fixture failed");
		expect(first.pagination?.snapshotId).toBe(same.pagination?.snapshotId);
		source.rows[0] = row(99);
		const pinned = await paging({
			...input,
			revision: "2",
			query: { page: "1", snapshotId: first.pagination?.snapshotId },
		});
		if (!pinned.ok) throw new Error("fixture failed");
		expect(pinned.rows[0]?.poolId).toBe("pool-00001");
		const latest = await paging({ ...input, revision: "2" });
		if (!latest.ok) throw new Error("fixture failed");
		expect(latest.rows[0]?.poolId).toBe("pool-00099");
	});

	it("rejects invalid sizes, out-of-range pages, mismatched, expired and evicted snapshots", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async () => board([row(1)]));
		const paging = createBoardPager();
		const input = { query: {}, key: "1h", revision: "1", read };
		for (const query of [
			{ page: "0" },
			{ page: "1.5" },
			{ pageSize: "201" },
			{ pageSize: "-1" },
			{ page: "2" },
		]) {
			await expect(paging({ ...input, query })).rejects.toMatchObject({ statusCode: 400 });
		}
		const result = await paging(input);
		if (!result.ok) throw new Error("fixture failed");
		const snapshotId = result.pagination?.snapshotId;
		await expect(paging({ ...input, key: "24h", query: { snapshotId } })).rejects.toMatchObject({
			statusCode: 409,
		});
		vi.advanceTimersByTime(10 * 60 * 1000);
		await expect(paging({ ...input, query: { snapshotId } })).rejects.toBeInstanceOf(
			BoardPageError,
		);
		const fresh = await paging(input);
		if (!fresh.ok) throw new Error("fixture failed");
		for (let index = 0; index < 10; index++) await paging({ ...input, key: `other-${index}` });
		await expect(
			paging({ ...input, query: { snapshotId: fresh.pagination?.snapshotId } }),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("does not cache failed queries and can retry", async () => {
		const paging = createBoardPager();
		const read = vi.fn(async () => board([])).mockRejectedValueOnce(new Error("database busy"));
		const input = { query: {}, key: "1h", revision: "1", read };
		await expect(paging(input)).rejects.toThrow("database busy");
		expect((await paging(input)).ok).toBe(true);
	});
});

it("freezes 20,000 six-window rows and pages all sizes without mixing chains", async () => {
	const source = board(
		Array.from({ length: 20_000 }, (_, index) => {
			const item = row(index);
			item.chain = index % 2 ? "base" : "elysium";
			item.poolId = `pool-${Math.floor(index / 2)}`;
			item.windows = Object.fromEntries(
				BOARD_WINDOWS.map((window) => [
					window.id,
					{
						volumeUsd: { ...item.volumeUsd, value: String(index + window.seconds) },
						feesUsd: { ...item.feesUsd },
						feesApr: { ...item.feesApr },
						changeVsPrevWindow: { ...item.changeVsPrevWindow },
						priceChange: { ...item.priceChange },
						capitalEfficiency: { ...item.capitalEfficiency },
					},
				]),
			) as NonNullable<BoardRow["windows"]>;
			return item;
		}),
	);
	source.includeWindows = "all";
	const pager = createBoardPager();
	const read = vi.fn(async () => source);
	const start = performance.now();
	const first = await pager({ key: "all", revision: "1", query: { page: "1" }, read });
	if (!first.ok) throw new Error("fixture failed");
	console.info(
		"six-window cold ms",
		performance.now() - start,
		"RSS MiB",
		process.memoryUsage().rss / 1048576,
	);
	for (const size of [50, 100, 200]) {
		const keys = new Set<string>();
		for (let page = 1; page <= Math.ceil(20_000 / size); page++) {
			const result = await pager({
				key: "all",
				revision: "2",
				query: {
					page: String(page),
					pageSize: String(size),
					snapshotId: first.pagination?.snapshotId,
				},
				read,
			});
			if (!result.ok) throw new Error("fixture failed");
			for (const item of result.rows) {
				keys.add(`${item.chain}:${item.poolId}`);
				expect(Object.keys(item.windows ?? {})).toHaveLength(6);
			}
		}
		expect(keys.size).toBe(20_000);
	}
	expect(read).toHaveBeenCalledTimes(1);
}, 30_000);

it("keeps chain, protocol, case and fee metadata distinct in same-snapshot selection", async () => {
	const identities = [
		{ chain: "elysium", protocol: "uniswap_v3", poolId: "same" },
		{ chain: "base", protocol: "uniswap_v3", poolId: "same" },
		{ chain: "elysium", protocol: "uniswap_v4", poolId: "same" },
		{ chain: "solana", protocol: "meteora_dlmm", poolId: "AbC" },
		{ chain: "solana", protocol: "meteora_dlmm", poolId: "abc" },
	];
	const rows = identities.map((identity, index) => {
		const item = { ...row(index), ...identity };
		item.feesUsd = {
			...item.feesUsd,
			value: null,
			feeStatus: "protocol_state_missing",
			reason: "fixture missing state",
		};
		return item;
	});
	const source = { ...board(rows), includeWindows: "all" as const, dataRevision: "actual" };
	const pager = createBoardPager();
	const read = vi.fn(async () => source);
	const first = await pager({ key: "all", revision: "before-read", query: {}, read });
	if (!first.ok) throw new Error("fixture failed");
	expect(first.rows).toEqual(rows);
	expect(new Set(rows.map(poolIdentity)).size).toBe(5);
	const selected = await pager({
		key: "all",
		revision: "newer",
		query: { snapshotId: first.pagination?.snapshotId, poolKeys: rows.map(poolIdentity) },
		read,
	});
	if (!selected.ok) throw new Error("fixture failed");
	expect(selected.rows).toEqual(rows);
	expect(selected.dataRevision).toBe("actual");
	expect(read).toHaveBeenCalledTimes(1);
	await expect(
		pager({
			key: "all",
			revision: "newer",
			query: {
				snapshotId: first.pagination?.snapshotId,
				poolKeys: [...rows.map(poolIdentity), "sixth"],
			},
			read,
		}),
	).rejects.toMatchObject({ statusCode: 400 });
});
