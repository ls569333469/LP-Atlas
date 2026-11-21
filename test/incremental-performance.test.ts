import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { loadCatalog } from "../src/normalize/catalog-cache.ts";
import { buildPriceBridgeIndex } from "../src/normalize/price-bridges.ts";
import { backfillPoolAges } from "../src/normalize/refresh-pipeline.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	countPoolsByVenue,
	deferUsdRepair,
	getTokens,
	listDeferredUsdRepairs,
	listPools,
	listRepairHourKeys,
	listStaleUsdHourStarts,
	listUsdRepairHourKeys,
	listWindowPoolIds,
	listWindowsForStarts,
	upsertPool,
	upsertScannedHour,
	upsertToken,
	upsertWindow,
} from "../src/store/repositories.ts";
import type {
	StoredEvmPool as StoredPool,
	StoredNativeWindow as StoredWindow,
} from "../src/store/types.ts";

const pool = (
	id: string,
	chainId = 4663,
	createdBlock = 10,
	createdAtUnix: number | null = null,
): StoredPool => ({
	poolId: `${chainId}:uniswap_v3:${id}`,
	chainId,
	protocol: "uniswap_v3",
	token0: "0x01",
	token1: "0x02",
	feePips: 10000,
	tickSpacing: 200,
	hooks: null,
	poolAddress: id,
	createdBlock,
	createdAtUnix,
});
const window = (poolId: string): StoredWindow => ({
	poolId,
	windowStart: 100,
	windowEnd: 3700,
	complete: true,
	volume0: "100",
	volume1: "200",
	lpFees0: "1",
	lpFees1: "2",
	swapCount: 3,
	volumeUsd: "300",
	lpFeesUsd: "3",
	tvlUsd: "1000",
	sqrtPriceStart: "1",
	sqrtPriceEnd: "2",
	source: "self_built",
	asOf: "2026-11-15T00:00:00Z",
	gapReason: null,
});

it("reuses catalog objects and bridge order, adds persisted new pools and isolates chains", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-catalog-"));
	const file = path.join(dir, "test.db");
	const db = await openDatabase(file);
	try {
		for (const row of [pool("0xbb"), pool("0xaa"), pool("0xbb", 99901)])
			await upsertPool(db, row, "now");
		const first = await loadCatalog(db, 4663);
		const query = await db.execute(
			"EXPLAIN QUERY PLAN SELECT rowid FROM pools WHERE chain_id=4663 AND rowid>100 ORDER BY rowid",
		);
		expect(query.rows.map((row) => String(row.detail)).join(" ")).toContain("rowid>?");
		const second = await loadCatalog(db, 4663);
		expect(second.added).toBe(0);
		expect(second.pools).toBe(first.pools);
		expect(second.priceIndex).toBe(first.priceIndex);
		await upsertPool(db, { ...pool("0x44"), protocol: "uniswap_v4", poolAddress: null }, "now");
		await loadCatalog(db, 4663);
		await upsertPool(db, pool("0xcc"), "now");
		const third = await loadCatalog(db, 4663);
		expect(third.added).toBe(1);
		expect(third.pools).toEqual(await listPools(db, 4663));
		expect(third.priceIndex).toEqual(buildPriceBridgeIndex(third.pools));
		expect(third.catalogOrder.get(pool("0xcc").poolId)).toBeGreaterThan(
			third.catalogOrder.get(pool("0xaa").poolId) ?? 0,
		);
		expect((await loadCatalog(db, 99901)).pools).toHaveLength(1);
		const counts = await countPoolsByVenue(db);
		expect(await countPoolsByVenue(db)).toEqual(counts);
		for (let attempt = 0; attempt < 2; attempt++) {
			const tx = await db.transaction("read");
			try {
				const execute = vi.spyOn(tx, "execute");
				expect(await countPoolsByVenue(tx, db)).toBe(counts);
				expect(
					execute.mock.calls.some(([statement]) => String(statement).includes("GROUP BY")),
				).toBe(false);
			} finally {
				tx.close();
			}
		}
		await upsertPool(db, pool("0xdd", 99901), "now");
		expect((await countPoolsByVenue(db)).find((row) => row.evmChainId === 99901)?.count).toBe(2);
		const restored = await openDatabase(file);
		try {
			expect((await loadCatalog(restored, 4663)).pools).toEqual(third.pools);
			expect(await countPoolsByVenue(restored)).not.toBe(counts);
		} finally {
			restored.close();
		}
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("limits window and token queries to the requested chain without changing amounts", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-sql-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		for (const chainId of [4663, 99901]) {
			const row = pool("0xaa", chainId);
			await upsertPool(db, row, "now");
			await upsertWindow(db, window(row.poolId));
			await upsertToken(db, {
				chainId,
				address: "0xaa",
				decimals: chainId === 4663 ? 6 : 18,
				symbol: String(chainId),
				name: null,
			});
		}
		expect(
			(await listWindowsForStarts(db, [100], { chainId: 4663 })).map((row) => row.poolId),
		).toEqual([pool("0xaa").poolId]);
		expect(await listWindowPoolIds(db, 99901)).toEqual(new Set([pool("0xaa", 99901).poolId]));
		expect(await listWindowPoolIds(db, 4663, "uniswap_v4")).toEqual(new Set());
		expect(await listWindowsForStarts(db, [100])).toHaveLength(2);
		expect((await getTokens(db, 4663, ["0xaa"]))[0]?.decimals).toBe(6);
		const before = await db.execute("SELECT * FROM window_aggregates ORDER BY pool_id");
		await listWindowsForStarts(db, [100], { chainId: 99901 });
		expect((await db.execute("SELECT * FROM window_aggregates ORDER BY pool_id")).rows).toEqual(
			before.rows,
		);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("reuses exact creation blocks within one chain and persists ages before caching them", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-ages-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const rows = [
			pool("known", 4663, 10, 100),
			pool("reuse", 4663, 10),
			pool("read1", 4663, 20),
			pool("read2", 4663, 20),
			pool("other", 99901, 20, 999),
		];
		for (const row of rows) await upsertPool(db, row, "now");
		const getBlock = vi.fn(async () => ({ timestamp: 200n }));
		const client = { getBlock } as unknown as PublicClient;
		const catalog = await loadCatalog(db, 4663);
		const needed = new Set(catalog.pools.map((row) => row.poolId));
		await backfillPoolAges(db, client, catalog.pools, needed, 4663);
		expect(getBlock).toHaveBeenCalledTimes(1);
		expect(getBlock).toHaveBeenCalledWith({ blockNumber: 20n });
		expect((await listPools(db, 4663)).map((row) => row.createdAtUnix)).toEqual([
			100, 100, 200, 200,
		]);
		await upsertPool(db, pool("late", 4663, 20), "now");
		const next = await loadCatalog(db, 4663);
		await backfillPoolAges(
			db,
			client,
			next.pools,
			new Set(next.pools.map((row) => row.poolId)),
			4663,
		);
		expect(getBlock).toHaveBeenCalledTimes(1);
		expect(next.poolById.get(pool("late").poolId)?.createdAtUnix).toBe(200);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("keeps failed ages empty and retries them on the next round", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-age-retry-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const row = pool("retry");
		await upsertPool(db, row, "now");
		const getBlock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		const client = { getBlock } as unknown as PublicClient;
		await backfillPoolAges(db, client, [row], new Set([row.poolId]), 4663);
		expect(row.createdAtUnix).toBeNull();
		expect((await listPools(db, 4663))[0]?.createdAtUnix).toBeNull();
		expect(getBlock).toHaveBeenCalledTimes(3);
		getBlock.mockResolvedValue({ timestamp: 123n });
		await backfillPoolAges(db, client, [row], new Set([row.poolId]), 4663);
		expect(row.createdAtUnix).toBe(123);
		expect(getBlock).toHaveBeenCalledTimes(4);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("preserves repair queue selection for nonempty cross-chain and USD-version cases", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-repair-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const cases = [
			{ hour: 100, protocol: "uniswap_v3", status: "estimated", selected: false },
			{ hour: 200, protocol: "uniswap_v3", status: "legacy_unverified", selected: false },
			{ hour: 300, protocol: "uniswap_v4", status: "legacy_unverified", selected: true },
			{ hour: 400, protocol: "uniswap_v4", status: "hook_unresolved", selected: true },
			{ hour: 500, protocol: "uniswap_v3", status: "protocol_state_missing", selected: true },
			{ hour: 600, protocol: "uniswap_v3", status: "estimated", selected: true, tvl: null },
			{
				hour: 700,
				protocol: "uniswap_v3",
				status: "estimated",
				selected: true,
				volume: null,
				version: 0,
			},
			{
				hour: 800,
				protocol: "uniswap_v4",
				status: "estimated",
				selected: false,
				fees: null,
				version: 1,
			},
			{
				hour: 900,
				protocol: "uniswap_v3",
				status: "estimated",
				selected: false,
				volume: null,
				version: null,
			},
		] as const;
		for (const chainId of [4663, 99901])
			for (const item of cases) {
				const row = {
					...pool(String(item.hour), chainId),
					protocol: item.protocol,
					poolId: `${chainId}:${item.protocol}:${item.hour}`,
				};
				await upsertPool(db, row, "now");
				await upsertWindow(db, {
					...window(row.poolId),
					windowStart: item.hour,
					windowEnd: item.hour + 3600,
					feeStatus: item.status,
					tvlUsd: "tvl" in item ? item.tvl : "1000",
					volumeUsd: "volume" in item ? item.volume : "300",
					lpFeesUsd: "fees" in item ? item.fees : "3",
				});
				if ("version" in item && item.version !== null)
					await upsertScannedHour(db, {
						chainId,
						protocol: item.protocol,
						windowStart: item.hour,
						windowEnd: item.hour + 3600,
						complete: true,
						fromBlock: "1",
						toBlock: "2",
						usdBridgeVersion: item.version,
						asOf: "now",
						gapReason: null,
					});
			}
		const expected = new Set(
			cases.filter((item) => item.selected).map((item) => `${item.protocol}:${item.hour}`),
		);
		expect(await listRepairHourKeys(db, 4663)).toEqual(expected);
		expect(await listRepairHourKeys(db, 99901)).toEqual(expected);
		const stale = new Set(
			cases.filter((item) => !("volume" in item && item.volume === null)).map((item) => item.hour),
		);
		expect(await listStaleUsdHourStarts(db, 99901)).toEqual(stale);
		await db.execute(
			"UPDATE window_aggregates SET usd_valuation_version=2 WHERE pool_id LIKE '99901:%'",
		);
		expect(await listStaleUsdHourStarts(db, 99901)).toEqual(new Set());
		expect(await listStaleUsdHourStarts(db, 4663)).toEqual(stale);
		await db.execute(
			"UPDATE window_aggregates SET fee_status='estimated',volume_usd='300',lp_fees_usd='3',tvl_usd='1000' WHERE pool_id LIKE '99901:%'",
		);
		expect(await listRepairHourKeys(db, 99901)).toEqual(new Set());
		expect(await listRepairHourKeys(db, 4663)).toEqual(expected);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});

it("defers only investigated dollars and invalidates changed historical inputs", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-usd-defer-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	try {
		const p = pool("deferred", 4663, 1);
		await upsertPool(db, p, "now");
		const w = {
			...window(p.poolId),
			volumeUsd: null,
			tvlUsd: null,
			lpFeesUsd: null,
			feeStatus: "estimated" as const,
		};
		await upsertWindow(db, w);
		const h = {
			chainId: 4663,
			protocol: "uniswap_v3",
			windowStart: w.windowStart,
			windowEnd: w.windowEnd,
			complete: true,
			fromBlock: "1",
			toBlock: "20",
			asOf: w.asOf,
			gapReason: null,
			usdBridgeVersion: 0,
		};
		await upsertScannedHour(db, h);
		const watermark = Number((await db.execute("SELECT MAX(rowid) AS n FROM pools")).rows[0]?.n);
		const decision = {
			poolId: p.poolId,
			windowStart: w.windowStart,
			toBlock: h.toBlock,
			windowAsOf: w.asOf,
			window: w,
			catalogRowId: watermark,
			reason: "no_historical_path" as const,
			evidence: "verified fixture",
		};
		const key = `uniswap_v3:${w.windowStart}`;
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await deferUsdRepair(db, decision);
		expect(await listUsdRepairHourKeys(db, 4663)).toEqual(new Set());
		expect(await listRepairHourKeys(db, 4663)).toEqual(new Set());
		expect((await listDeferredUsdRepairs(db, 4663)).get(w.windowStart)).toEqual(
			new Set([p.poolId]),
		);
		expect(await listDeferredUsdRepairs(db, 99901)).toEqual(new Map());
		// A transient failure in another pool keeps this mixed hour eligible.
		const other = pool("transient", 4663, 2);
		await upsertPool(db, other, "now");
		await upsertWindow(db, { ...w, poolId: other.poolId });
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await db.execute({
			sql: "DELETE FROM window_aggregates WHERE pool_id=?",
			args: [other.poolId],
		});
		// The newly discovered historical pool invalidates the old graph evidence.
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await deferUsdRepair(db, {
			...decision,
			catalogRowId: Number((await db.execute("SELECT MAX(rowid) AS n FROM pools")).rows[0]?.n),
		});
		await upsertPool(db, pool("new-current", 4663, 100), "now");
		await upsertPool(db, pool("other-chain", 99901, 1), "now");
		expect(await listUsdRepairHourKeys(db, 4663)).toEqual(new Set());
		await upsertWindow(db, { ...w, volume0: "101" });
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await upsertWindow(db, w);
		await upsertScannedHour(db, { ...h, toBlock: "21" });
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await upsertScannedHour(db, h);
		await db.execute("UPDATE usd_repair_deferrals SET valuation_version=1");
		expect((await listUsdRepairHourKeys(db, 4663)).has(key)).toBe(true);
		await db.execute("UPDATE usd_repair_deferrals SET valuation_version=2");
		await upsertWindow(db, { ...w, feeStatus: "protocol_state_missing" });
		expect((await listRepairHourKeys(db, 4663)).has(key)).toBe(true);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EBUSY") throw error;
			},
		);
	}
});
