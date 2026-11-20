import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InStatement, TransactionMode } from "@libsql/client";
import { expect, it, vi } from "vitest";
import { resolveRpcConfig } from "../src/adapters/rpc.ts";
import { buildApp } from "../src/server/app.ts";
import { ZERO_ADDRESS } from "../src/shared/constants.ts";
import type { FeeDataStatus } from "../src/shared/fee-quality.ts";
import type { BoardSuccessResponse } from "../src/shared/types.ts";
import { openDatabase } from "../src/store/db.ts";
import {
	finishRefreshRun,
	insertRefreshRun,
	listWindowsInRange,
	upsertScannedHour,
	upsertWindow,
} from "../src/store/repositories.ts";
import { formatFeeApr, formatFeeUsd } from "../src/web/src/format.ts";

it("carries fee quality through SQLite, window composition, API and sorting, and rejects an unfinished past hour", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-fee-board-"));
	const db = await openDatabase(path.join(dir, "test.db"));
	const app = buildApp({ db, rpc: resolveRpcConfig({}) });
	const start = 1794470400;
	const asOf = "2026-11-12T08:14:40.000Z";
	try {
		const id = await insertRefreshRun(db, {
			startedAt: asOf,
			status: "running",
			rpcSourceKind: "public_temporary",
			rpcSourceLabel: "fixture",
			scopeChain: null,
			scopeProtocol: null,
		});
		await finishRefreshRun(db, id, {
			status: "partial",
			finishedAt: asOf,
			blockTime: asOf,
			windowsBuilt: 4,
		});
		const cases: Array<{
			id: string;
			hook: string;
			tier: number;
			fee: string;
			status: FeeDataStatus;
		}> = [
			{ id: "zero", hook: ZERO_ADDRESS, tier: 0, fee: "0", status: "legacy_unverified" },
			{
				id: "hook",
				hook: "0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC",
				tier: 8388608,
				fee: "0",
				status: "legacy_unverified",
			},
			{ id: "old", hook: ZERO_ADDRESS, tier: 3000, fee: "55", status: "legacy_unverified" },
			{ id: "corrected", hook: ZERO_ADDRESS, tier: 3000, fee: "12", status: "estimated" },
			{
				id: "state-missing",
				hook: ZERO_ADDRESS,
				tier: 3000,
				fee: "5",
				status: "protocol_state_missing",
			},
		];
		for (const item of cases) {
			await db.execute({
				sql: `INSERT INTO pools (pool_id,chain_id,protocol,token0,token1,fee_pips,tick_spacing,hooks,created_block,discovered_at)
				VALUES (?,99901,'uniswap_v4',?,?,?,60,?,1,?)`,
				args: [item.id, ZERO_ADDRESS, ZERO_ADDRESS, item.tier, item.hook, asOf],
			});
			await upsertWindow(db, {
				poolId: item.id,
				windowStart: start,
				windowEnd: start + 3600,
				complete: false,
				volume0: "1000",
				volume1: "1000",
				lpFees0: item.fee,
				lpFees1: "0",
				swapCount: 1,
				volumeUsd: "200",
				lpFeesUsd: item.fee,
				feeStatus: item.status,
				tvlUsd: "2000",
				sqrtPriceStart: "79228162514264337593543950336",
				sqrtPriceEnd: "79228162514264337593543950336",
				source: "self_built",
				asOf,
				gapReason: null,
			});
		}
		for (const windowStart of [start - 3600, start])
			await upsertScannedHour(db, {
				chainId: 99901,
				protocol: "uniswap_v4",
				windowStart,
				windowEnd: windowStart + 3600,
				complete: false,
				fromBlock: "1",
				toBlock: "2",
				asOf: windowStart === start ? asOf : "2026-11-12T07:05:16.000Z",
				gapReason: null,
				priceBoundaryVersion: 1,
			});
		const response = await app.inject(
			"/api/v2/board?window=1h&sortField=fees&sortDirection=desc&page=1&pageSize=50",
		);
		expect(response.statusCode).toBe(200);
		const board = response.json<BoardSuccessResponse>();
		expect(board.rows.map((row) => row.poolId)).toEqual(["corrected"]);
		expect(board.rows[0]?.feesUsd.value).toBe("12");
		expect(board.rows[0]?.changeVsPrevWindow.value).toBeNull();
		const legacy = (await app.inject("/api/v1/board?window=1h")).json<BoardSuccessResponse>();
		expect(legacy.rows).toHaveLength(5);
		expect(legacy.rows.find((row) => row.poolId === "hook")?.feesUsd.value).toBeNull();
		expect(
			(await listWindowsInRange(db, start, start + 3600)).find((row) => row.poolId === "old")
				?.lpFeesUsd,
		).toBe("55");
		const longer = (await app.inject("/api/v2/board?window=2h")).json<BoardSuccessResponse>();
		expect(longer.rows.map((row) => row.poolId)).toEqual(["corrected"]);
		expect(longer.rows[0]?.feesUsd.value).toBeNull();
		expect(longer.gaps.join(" ")).toContain("小时已结束但未补齐");
		for (const window of ["4h", "6h", "24h", "3d"]) {
			const missing = (
				await app.inject(`/api/v2/board?window=${window}`)
			).json<BoardSuccessResponse>();
			expect(missing.rows.map((row) => row.poolId)).toEqual(["corrected"]);
			expect(missing.rows[0]?.feesUsd.value).toBeNull();
		}

		// A fully scanned hour without swaps contributes zero, not a missing hour.
		await upsertScannedHour(db, {
			chainId: 99901,
			protocol: "uniswap_v4",
			windowStart: start - 3600,
			windowEnd: start,
			complete: true,
			fromBlock: "1",
			toBlock: "2",
			asOf,
			gapReason: null,
		});
		const restored = (
			await app.inject("/api/v2/board?window=2h&sortDirection=asc")
		).json<BoardSuccessResponse>();
		expect(restored.rows.map((row) => row.poolId)).toEqual(["corrected"]);
		expect(restored.rows[0]?.feesUsd.value).toBe("12");

		const six = (
			await app.inject("/api/v2/board?includeWindows=all&window=1h&page=1")
		).json<BoardSuccessResponse>();
		expect(six.includeWindows).toBe("all");
		expect(Object.keys(six.windowsMeta ?? {})).toEqual(["1h", "2h", "4h", "6h", "24h", "3d"]);
		expect(six.rows[0]?.windows?.["1h"].feesUsd).toEqual(six.rows[0]?.feesUsd);
		expect(six.rows[0]?.windows?.["3d"].feesUsd.value).toBeNull();
		const single = (await app.inject("/api/v2/board?window=1h")).json<BoardSuccessResponse>();
		expect(six.rows.map((row) => row.poolId)).toEqual(single.rows.map((row) => row.poolId));
		expect(six.dataRevision).toBe(String(id));
		for (const window of ["2h", "4h", "6h", "24h", "3d"]) {
			const all = (
				await app.inject(`/api/v2/board?includeWindows=all&window=${window}`)
			).json<BoardSuccessResponse>();
			const old = (await app.inject(`/api/v2/board?window=${window}`)).json<BoardSuccessResponse>();
			expect(all.rows.map((row) => row.poolId)).toEqual(old.rows.map((row) => row.poolId));
			expect(all.rows.map((row) => row.feesUsd)).toEqual(old.rows.map((row) => row.feesUsd));
		}

		const filteredQuery = new URLSearchParams({
			includeWindows: "all",
			window: "2h",
			page: "1",
			minLpFees1hUsd: "12",
			metricConditions: JSON.stringify([
				{ field: "fees", window: "1h", operator: ">=", value: "12" },
				{ field: "priceChange", window: "1h", operator: "=", value: "0" },
			]),
		});
		const filteredResponse = await app.inject(`/api/v2/board?${filteredQuery}`);
		expect(filteredResponse.statusCode).toBe(200);
		const filtered = filteredResponse.json<BoardSuccessResponse>();
		expect(filtered.rows.map((r) => r.poolId)).toEqual(["corrected"]);
		expect(filtered.rows[0]?.windows?.["1h"]).toEqual(six.rows[0]?.windows?.["1h"]);
		const wrongSnapshot = await app.inject(
			`/api/v2/board?${filteredQuery}&snapshotId=${six.pagination?.snapshotId}`,
		);
		expect(wrongSnapshot.statusCode).toBe(409);
		const threshold = (
			await app.inject("/api/v2/board?minLpFees1hUsd=12.00001&includeWindows=all")
		).json<BoardSuccessResponse>();
		expect(threshold.rows).toHaveLength(0);
		const missingCondition = new URLSearchParams({
			metricConditions: JSON.stringify([
				{ field: "fees", window: "3d", operator: ">=", value: "0" },
			]),
		});
		expect(
			(await app.inject(`/api/v2/board?${missingCondition}`)).json<BoardSuccessResponse>().rows,
		).toHaveLength(0);
		const snapshot = six.pagination?.snapshotId;
		const candidate = JSON.stringify([
			six.rows[0]?.chain,
			six.rows[0]?.protocol,
			six.rows[0]?.poolId,
		]);
		const detail = (
			await app.inject(
				`/api/v2/board?includeWindows=all&window=1h&snapshotId=${snapshot}&poolKeys=${encodeURIComponent(candidate)}`,
			)
		).json<BoardSuccessResponse>();
		expect(detail.rows).toEqual(six.rows.slice(0, 1));
		for (const query of [
			"chains=bad",
			"chain=elysium&chains=base",
			"protocols=bad",
			"includeWindows=no",
		]) {
			expect((await app.inject(`/api/v2/board?${query}`)).statusCode).toBe(400);
		}
		const unused = (
			await app.inject("/api/v2/board?includeWindows=all&chains=base&chains=solana")
		).json<BoardSuccessResponse>();
		expect(unused.rows).toEqual([]);
		expect(unused.catalog.venues.some((venue) => venue.status === "listed_not_implemented")).toBe(
			true,
		);
		const multi = (
			await app.inject(
				"/api/v2/board?includeWindows=all&chains=base&chains=elysium&protocols=uniswap_v4",
			)
		).json<BoardSuccessResponse>();
		expect(multi.rows).toHaveLength(single.rows.length);
		const reversed = (
			await app.inject(
				"/api/v2/board?includeWindows=all&chains=elysium&chains=base&protocols=uniswap_v4",
			)
		).json<BoardSuccessResponse>();
		expect(reversed.pagination?.snapshotId).toBe(multi.pagination?.snapshotId);

		const readerDb = await openDatabase(path.join(dir, "test.db"));
		const readerApp = buildApp({ db: readerDb, rpc: resolveRpcConfig({}) });
		const publication = await db.transaction("write");
		try {
			const stored = (await listWindowsInRange(db, start, start + 3600)).find(
				(row) => row.poolId === "corrected",
			);
			if (!stored) throw new Error("missing fixture");
			const nextAsOf = "2026-11-12T08:15:00.000Z";
			await upsertWindow(publication, {
				...stored,
				lpFees0: "99",
				lpFeesUsd: "99",
				asOf: nextAsOf,
			});
			await finishRefreshRun(publication, id, {
				status: "partial",
				blockTime: nextAsOf,
				finishedAt: nextAsOf,
				windowsBuilt: 4,
			});
			const beforeCommit = (
				await readerApp.inject("/api/v2/board?window=1h")
			).json<BoardSuccessResponse>();
			expect(beforeCommit.asOf).toBe(asOf);
			expect(beforeCommit.rows[0]?.feesUsd.value).toBe("12");
			await publication.commit();
			const afterCommit = (
				await readerApp.inject("/api/v2/board?window=1h")
			).json<BoardSuccessResponse>();
			expect(afterCommit.asOf).toBe(nextAsOf);
			expect(afterCommit.rows[0]?.feesUsd.value).toBe("99");
			const nextPublication = await db.transaction("write");
			const finalAsOf = "2026-11-12T08:16:00.000Z";
			await upsertWindow(nextPublication, {
				...stored,
				lpFees0: "123",
				lpFeesUsd: "123",
				asOf: finalAsOf,
			});
			await finishRefreshRun(nextPublication, id, {
				status: "partial",
				blockTime: finalAsOf,
				finishedAt: finalAsOf,
				windowsBuilt: 4,
			});
			const transaction = readerDb.transaction.bind(readerDb);
			let committed = false;
			const reading = vi
				.spyOn(readerDb, "transaction")
				.mockImplementation(async (mode?: TransactionMode) => {
					const tx = await transaction(mode);
					const execute = tx.execute.bind(tx);
					vi.spyOn(tx, "execute").mockImplementation(async (statement: InStatement) => {
						const result = await execute(statement);
						const sql = typeof statement === "string" ? statement : statement.sql;
						if (!committed && sql.includes("WHERE status IN ('ok', 'partial')")) {
							await nextPublication.commit();
							committed = true;
						}
						return result;
					});
					return tx;
				});
			try {
				const duringCommit = (
					await readerApp.inject("/api/v2/board?window=1h")
				).json<BoardSuccessResponse>();
				expect(committed).toBe(true);
				expect(duringCommit.asOf).toBe(nextAsOf);
				expect(duringCommit.rows[0]?.feesUsd.value).toBe("99");
				const nextRead = (
					await readerApp.inject("/api/v2/board?window=1h")
				).json<BoardSuccessResponse>();
				expect(nextRead.asOf).toBe(finalAsOf);
				expect(nextRead.rows[0]?.feesUsd.value).toBe("123");
				expect(duringCommit.rows[0]?.feesUsd.asOf).toBe(duringCommit.asOf);
			} finally {
				reading.mockRestore();
				nextPublication.close();
			}
		} finally {
			publication.close();
			await readerApp.close();
			readerDb.close();
		}

		await db.execute(
			"UPDATE window_aggregates SET sqrt_price_start = NULL WHERE pool_id = 'corrected'",
		);
		const filterApp = buildApp({ db, rpc: resolveRpcConfig({}) });
		try {
			for (const window of ["1h", "2h", "4h", "6h", "24h", "3d"]) {
				for (const suffix of ["", "&includeWindows=all"]) {
					const filtered = (
						await filterApp.inject(`/api/v2/board?window=${window}${suffix}`)
					).json<BoardSuccessResponse>();
					expect(filtered.rows).toHaveLength(0);
				}
			}
			const preservedLegacy = (
				await filterApp.inject("/api/v1/board?window=1h")
			).json<BoardSuccessResponse>();
			expect(preservedLegacy.rows.some((row) => row.poolId === "corrected")).toBe(true);
		} finally {
			await filterApp.close();
		}

		const currentHour = (await listWindowsInRange(db, start, start + 3600)).find(
			(row) => row.poolId === "corrected",
		);
		if (!currentHour) throw new Error("Missing corrected fixture");
		await upsertWindow(db, {
			...currentHour,
			windowStart: start - 3600,
			windowEnd: start,
			complete: true,
		});
		const zeroChangeApp = buildApp({ db, rpc: resolveRpcConfig({}) });
		try {
			const retained = (
				await zeroChangeApp.inject("/api/v2/board?includeWindows=all")
			).json<BoardSuccessResponse>();
			expect(retained.rows.map((row) => row.poolId)).toEqual(["corrected"]);
			expect(retained.rows[0]?.windows?.["1h"].changeVsPrevWindow.value).toBe("0");
			expect(retained.rows[0]?.windows?.["1h"].priceChange.value).toBeNull();
		} finally {
			await zeroChangeApp.close();
		}
		const sealedAsOf = new Date((start + 3599) * 1000).toISOString();
		await finishRefreshRun(db, id, { blockTime: sealedAsOf, windowsBuilt: 4 });
		await db.execute({
			sql: "UPDATE window_aggregates SET complete=1, as_of=? WHERE window_start=?",
			args: [sealedAsOf, start],
		});
		for (const protocol of ["uniswap_v3", "uniswap_v4"] as const)
			await upsertScannedHour(db, {
				chainId: 99901,
				protocol,
				windowStart: start,
				windowEnd: start + 3600,
				complete: true,
				fromBlock: "1",
				toBlock: "3600",
				asOf: sealedAsOf,
				gapReason: null,
				priceBoundaryVersion: 1,
			});
		await db.execute(`INSERT INTO pools (pool_id,chain_id,protocol,token0,token1,fee_pips,tick_spacing,created_block,discovered_at)
			SELECT 'closed-v3',chain_id,'uniswap_v3',token0,token1,fee_pips,tick_spacing,created_block,discovered_at FROM pools WHERE pool_id='corrected'`);
		for (const window of await listWindowsInRange(db, start - 3600, start + 3600))
			if (window.poolId === "corrected") await upsertWindow(db, { ...window, poolId: "closed-v3" });
		await upsertScannedHour(db, {
			chainId: 99901,
			protocol: "uniswap_v3",
			windowStart: start - 3600,
			windowEnd: start,
			complete: true,
			fromBlock: "1",
			toBlock: "2",
			asOf: new Date((start - 1) * 1000).toISOString(),
			gapReason: null,
			priceBoundaryVersion: 1,
		});
		const sealedApp = buildApp({ db, rpc: resolveRpcConfig({}) });
		try {
			const sealed = (
				await sealedApp.inject("/api/v2/board?includeWindows=all")
			).json<BoardSuccessResponse>();
			const result = sealed.rows.find((row) => row.poolId === "corrected");
			expect(result).toBeDefined();
			expect(sealed.asOf).toBe(sealedAsOf);
			expect(sealed.currentHourComplete).toBe(true);
			expect(sealed.windowsMeta?.["1h"].currentHourComplete).toBe(true);
			expect(result?.feesUsd.complete).toBe(true);
			expect(Number(result?.feesApr.value)).toBeCloseTo(
				(Number(result?.feesUsd.value) / Number(result?.tvlUsd.value)) * 8760,
				8,
			);
		} finally {
			await sealedApp.close();
		}
		await db.execute({
			sql: "UPDATE scanned_hours SET complete=0 WHERE window_start=? AND protocol='uniswap_v4'",
			args: [start],
		});
		await db.execute({
			sql: "UPDATE window_aggregates SET complete=0 WHERE window_start=? AND pool_id='corrected'",
			args: [start],
		});
		const partialApp = buildApp({ db, rpc: resolveRpcConfig({}) });
		try {
			const partial = (
				await partialApp.inject("/api/v2/board?includeWindows=all")
			).json<BoardSuccessResponse>();
			const result = partial.rows.find((row) => row.poolId === "corrected");
			expect(partial.currentHourComplete).toBe(false);
			expect(partial.rows.find((row) => row.poolId === "closed-v3")?.feesUsd.complete).toBe(true);
			expect(result?.feesUsd.complete).toBe(false);
			expect(Number(result?.feesApr.value)).toBeCloseTo(
				((Number(result?.feesUsd.value) / Number(result?.tvlUsd.value)) * 31536000) / 3599,
				8,
			);
		} finally {
			await partialApp.close();
		}
	} finally {
		await app.close();
		db.close();
		await rm(dir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
			// libsql on Windows may retain the file until the test worker exits.
			if (error.code !== "EBUSY") throw error;
		});
	}
});

it("does not round small positive fee signals to a displayed zero", () => {
	expect(formatFeeUsd("0.00001")).toBe("< US$0.01");
	expect(formatFeeUsd("0")).not.toContain("<");
	expect(formatFeeApr("0.000001")).toBe("< 0.01%");
	expect(formatFeeApr("0")).toBe("0.00%");
});
