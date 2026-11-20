import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lookbackHourStarts, selectRefreshHours } from "../src/normalize/refresh-hours.ts";
import {
	CHAIN_ID_ELYSIUM,
	DETERMINED_LOOKBACK_SECONDS,
	HOUR_SECONDS,
	HOURLY_RETENTION_SECONDS,
	METRIC_SOURCE_SELF_BUILT,
} from "../src/shared/constants.ts";
import type { AppDatabase } from "../src/store/db.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	hourlyRetentionCutoff,
	pruneExpiredHourlyData,
	pruneHourlyCache,
} from "../src/store/prune.ts";
import {
	finishRefreshRun,
	insertRefreshRun,
	latestSuccessfulRefresh,
	listPools,
	listScannedHours,
	listTokens,
	listWindowsInRange,
	upsertPool,
	upsertScannedHour,
	upsertToken,
	upsertWindow,
} from "../src/store/repositories.ts";
import type { StoredWindow } from "../src/store/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	const dirs = tempDirs.splice(0);
	for (const dir of dirs) {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch (error) {
			const busy = error instanceof Error && (error as NodeJS.ErrnoException).code === "EBUSY";
			if (!busy) {
				throw error;
			}
		}
	}
});

async function tempDb(): Promise<AppDatabase> {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-retention-"));
	tempDirs.push(dir);
	return openDatabase(path.join(dir, "lp-atlas.db"));
}

function iso(unix: number): string {
	return new Date(unix * 1000).toISOString();
}

function windowRow(poolId: string, start: number): StoredWindow {
	return {
		poolId,
		windowStart: start,
		windowEnd: start + HOUR_SECONDS,
		complete: true,
		volume0: "0",
		volume1: "0",
		lpFees0: "0",
		lpFees1: "0",
		swapCount: 0,
		volumeUsd: "1",
		lpFeesUsd: "1",
		tvlUsd: "1000",
		sqrtPriceStart: null,
		sqrtPriceEnd: null,
		source: METRIC_SOURCE_SELF_BUILT,
		asOf: iso(start + HOUR_SECONDS),
		gapReason: null,
	};
}

async function seedCatalog(db: AppDatabase): Promise<void> {
	await upsertToken(db, {
		chainId: CHAIN_ID_ELYSIUM,
		address: "0x0000000000000000000000000000000000000001",
		symbol: "USDC",
		decimals: 6,
		name: "USD Coin",
	});
	await upsertPool(
		db,
		{
			poolId: "pool-keep",
			chainId: CHAIN_ID_ELYSIUM,
			protocol: "uniswap_v3",
			token0: "0x0000000000000000000000000000000000000001",
			token1: "0x0000000000000000000000000000000000000002",
			feePips: 500,
			tickSpacing: 10,
			hooks: null,
			poolAddress: "0x00000000000000000000000000000000000000aa",
			createdBlock: 1,
			createdAtUnix: 1_600_000_000,
		},
		iso(1_600_000_000),
	);
}

async function seedHour(db: AppDatabase, start: number): Promise<void> {
	await upsertWindow(db, windowRow("pool-keep", start));
	await upsertScannedHour(db, {
		chainId: CHAIN_ID_ELYSIUM,
		protocol: "uniswap_v3",
		windowStart: start,
		windowEnd: start + HOUR_SECONDS,
		complete: true,
		fromBlock: "1",
		toBlock: "2",
		asOf: iso(start + HOUR_SECONDS),
		gapReason: null,
	});
}

describe("hourly retention cutoff", () => {
	it("aligns the 4-day cutoff to the hour and does not request older hours", () => {
		const asOf = 1_700_000_100;
		const currentStart = Math.floor(asOf / HOUR_SECONDS) * HOUR_SECONDS;
		const cutoff = hourlyRetentionCutoff(asOf);
		expect(cutoff).toBe(currentStart - HOURLY_RETENTION_SECONDS);
		expect(cutoff % HOUR_SECONDS).toBe(0);
		expect(HOURLY_RETENTION_SECONDS).toBe(4 * 24 * HOUR_SECONDS);
		expect(DETERMINED_LOOKBACK_SECONDS).toBe(3 * 24 * HOUR_SECONDS);

		const { starts, lookbackStart, currentStart: lookbackCurrent } = lookbackHourStarts(asOf);
		expect(lookbackCurrent).toBe(currentStart);
		expect(lookbackStart).toBe(currentStart - 71 * HOUR_SECONDS);
		expect(lookbackStart).toBeGreaterThan(cutoff);
		expect(starts[0]).toBe(lookbackStart);
		expect(starts.at(-1)).toBe(currentStart);
		expect(starts.every((start) => start >= cutoff)).toBe(true);
		expect(starts).toHaveLength(72);

		const selected = selectRefreshHours({
			asOfUnix: asOf,
			scannedStarts: new Set(),
			maxHours: 10_000,
		});
		expect(selected.length).toBe(starts.length);
		expect(Math.min(...selected)).toBe(lookbackStart);
		expect(selected.every((start) => start >= cutoff)).toBe(true);
	});
});

describe("pruneExpiredHourlyData", () => {
	it("removes hourly rows older than 4 days, keeps in-window hours, catalog, and the latest success", async () => {
		const db = await tempDb();
		const asOf = 1_700_000_100;
		const cutoff = hourlyRetentionCutoff(asOf);
		const inside = cutoff;
		const alsoInside = cutoff + HOUR_SECONDS;
		const current = Math.floor(asOf / HOUR_SECONDS) * HOUR_SECONDS;
		const expired = cutoff - HOUR_SECONDS;
		const older = cutoff - 2 * HOUR_SECONDS;

		await seedCatalog(db);
		await seedHour(db, expired);
		await seedHour(db, older);
		await seedHour(db, inside);
		await seedHour(db, alsoInside);
		await seedHour(db, current);

		const oldSuccessId = await insertRefreshRun(db, {
			startedAt: iso(expired),
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "official public rpc",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, oldSuccessId, {
			finishedAt: iso(expired + 60),
			status: "ok",
			blockNumber: "10",
			blockTime: iso(expired),
			windowsBuilt: 3,
			durationMs: 10,
		});
		const oldErrorId = await insertRefreshRun(db, {
			startedAt: iso(older),
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "official public rpc",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, oldErrorId, {
			finishedAt: iso(older + 60),
			status: "error",
			error: "timeout",
			blockTime: iso(older),
			windowsBuilt: 0,
			durationMs: 10,
		});
		const oldPartialEmptyId = await insertRefreshRun(db, {
			startedAt: iso(expired - HOUR_SECONDS),
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "official public rpc",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, oldPartialEmptyId, {
			finishedAt: iso(expired - HOUR_SECONDS + 60),
			status: "partial",
			blockTime: iso(expired - HOUR_SECONDS),
			windowsBuilt: 0,
			durationMs: 10,
		});
		const recentId = await insertRefreshRun(db, {
			startedAt: iso(current),
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "official public rpc",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, recentId, {
			finishedAt: iso(current + 60),
			status: "partial",
			blockNumber: "20",
			blockTime: iso(asOf),
			windowsBuilt: 2,
			durationMs: 10,
		});

		const first = await pruneExpiredHourlyData(db, asOf);
		expect(first.cutoff).toBe(cutoff);
		expect(first.windowsDeleted).toBe(2);
		expect(first.scannedHoursDeleted).toBe(2);
		expect(first.refreshRunsDeleted).toBe(3);

		const windows = await listWindowsInRange(db, older - HOUR_SECONDS, current + HOUR_SECONDS);
		expect(windows.map((row) => row.windowStart).sort((a, b) => a - b)).toEqual([
			inside,
			alsoInside,
			current,
		]);
		const scanned = await listScannedHours(db, {
			startUnix: older - HOUR_SECONDS,
			endUnixExclusive: current + HOUR_SECONDS,
		});
		expect(scanned.map((row) => row.windowStart).sort((a, b) => a - b)).toEqual([
			inside,
			alsoInside,
			current,
		]);

		const runs = await db.execute("SELECT id, status FROM refresh_runs ORDER BY id");
		expect(runs.rows.map((row) => Number(row.id))).toEqual([recentId]);
		expect(await latestSuccessfulRefresh(db)).toMatchObject({ id: recentId, status: "partial" });

		expect(await listPools(db)).toHaveLength(1);
		expect(await listTokens(db)).toHaveLength(1);

		const second = await pruneExpiredHourlyData(db, asOf);
		expect(second).toEqual({
			cutoff,
			windowsDeleted: 0,
			scannedHoursDeleted: 0,
			refreshRunsDeleted: 0,
		});
		expect((await listPools(db))[0]?.poolId).toBe("pool-keep");
		db.close();
	});

	it("keeps the latest successful refresh_run even when it is older than the cutoff", async () => {
		const db = await tempDb();
		const asOf = 1_700_000_100;
		const cutoff = hourlyRetentionCutoff(asOf);
		const expired = cutoff - HOUR_SECONDS;
		await seedCatalog(db);

		const staleSuccessId = await insertRefreshRun(db, {
			startedAt: iso(expired),
			status: "running",
			rpcSourceKind: "configured",
			rpcSourceLabel: "archive",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, staleSuccessId, {
			finishedAt: iso(expired + 30),
			status: "partial",
			blockTime: iso(expired),
			windowsBuilt: 4,
			durationMs: 20,
		});
		const staleErrorId = await insertRefreshRun(db, {
			startedAt: iso(expired - HOUR_SECONDS),
			status: "running",
			rpcSourceKind: "configured",
			rpcSourceLabel: "archive",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, staleErrorId, {
			finishedAt: iso(expired - HOUR_SECONDS + 30),
			status: "error",
			error: "rpc down",
			blockTime: iso(expired - HOUR_SECONDS),
			windowsBuilt: 0,
			durationMs: 20,
		});

		const result = await pruneExpiredHourlyData(db, asOf);
		expect(result.refreshRunsDeleted).toBe(1);
		const runs = await db.execute("SELECT id, status FROM refresh_runs");
		expect(runs.rows).toHaveLength(1);
		expect(Number(runs.rows[0]?.id)).toBe(staleSuccessId);
		expect(await latestSuccessfulRefresh(db)).toMatchObject({
			id: staleSuccessId,
			status: "partial",
			windowsBuilt: 4,
		});
		expect(await listPools(db)).toHaveLength(1);
		expect(await listTokens(db)).toHaveLength(1);

		const indexes = await db.execute("PRAGMA index_list(scanned_hours)");
		expect(indexes.rows.map((row) => String(row.name))).toContain("idx_scanned_hours_start");
		db.close();
	});
});

describe("pruneHourlyCache clock", () => {
	it("uses lastSuccess block_time so a later head cannot eat hours still inside the retained window", async () => {
		const db = await tempDb();
		const lastSuccessAsOf = 1_700_000_100;
		const cutoff = hourlyRetentionCutoff(lastSuccessAsOf);
		const { lookbackStart } = lookbackHourStarts(lastSuccessAsOf);
		const laterHead = lastSuccessAsOf + 10 * 24 * HOUR_SECONDS;
		expect(lookbackStart).toBeLessThan(hourlyRetentionCutoff(laterHead));

		await seedCatalog(db);
		await seedHour(db, lookbackStart);
		await seedHour(db, cutoff - HOUR_SECONDS);

		const successId = await insertRefreshRun(db, {
			startedAt: iso(lastSuccessAsOf),
			status: "running",
			rpcSourceKind: "configured",
			rpcSourceLabel: "archive",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, successId, {
			finishedAt: iso(lastSuccessAsOf + 60),
			status: "ok",
			blockTime: iso(lastSuccessAsOf),
			windowsBuilt: 4,
			durationMs: 20,
		});

		const result = await pruneHourlyCache(db, laterHead);
		expect(result?.cutoff).toBe(cutoff);
		expect(result?.windowsDeleted).toBe(1);
		expect(result?.scannedHoursDeleted).toBe(1);

		const windows = await listWindowsInRange(db, cutoff - 2 * HOUR_SECONDS, laterHead);
		expect(windows.map((row) => row.windowStart)).toEqual([lookbackStart]);
		expect(await listPools(db)).toHaveLength(1);
		expect(await listTokens(db)).toHaveLength(1);
		db.close();
	});
});
