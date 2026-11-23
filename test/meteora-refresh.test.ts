import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import Decimal from "decimal.js";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRpcConfig } from "../src/adapters/rpc.ts";
import { readBoard } from "../src/normalize/board.ts";
import { METEORA_SOURCE, runMeteoraRefresh } from "../src/normalize/official-refresh.ts";
import { buildApp } from "../src/server/app.ts";
import { migrate, openDatabase } from "../src/store/db.ts";
import { latestPublicationRevision, listWindowsInRange } from "../src/store/repositories.ts";
import { removeTempDirectories } from "./helpers/temp-directories.ts";

const dirs: string[] = [];
const H = 1795150800;
const pool = JSON.parse(
	fs.readFileSync(new URL("./fixtures/meteora/pool-0.json", import.meta.url), "utf8"),
);
pool.created_at = (H - 1000 * 3600) * 1000;
afterEach(async () => removeTempDirectories(dirs));
async function database() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-meteora-refresh-"));
	dirs.push(directory);
	return openDatabase(path.join(directory, "test.db"));
}
function source(options: { missingHours?: number[]; createdAt?: number | null } = {}) {
	let volume = 200;
	let price = pool.current_price;
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/pools")
			return new Response(
				JSON.stringify({
					total: 1,
					pages: 1,
					current_page: 1,
					page_size: 1000,
					data: [
						{
							...pool,
							current_price: price,
							...(options.createdAt !== undefined ? { created_at: options.createdAt } : {}),
						},
					],
				}),
			);
		if (!url.pathname.endsWith("/volume/history")) throw new Error("Unexpected redundant endpoint");
		const start = Number(url.searchParams.get("start_time")),
			end = Number(url.searchParams.get("end_time"));
		const data = [];
		for (let t = start; t <= end; t += 3600)
			if (!options.missingHours?.includes(t))
				data.push({
					timestamp: t,
					timestamp_str: new Date(t * 1000).toISOString(),
					volume,
					fees: 7,
					protocol_fees: 1,
				});
		return new Response(
			JSON.stringify({ start_time: start, end_time: end, timeframe: "1h", data }),
		);
	});
	return {
		fetchImpl,
		setVolume: (next: number) => {
			volume = next;
		},
		setPrice: (next: number) => {
			price = next;
		},
	};
}
const now = () => new Date((H + 1800) * 1000);
const read = (db: Awaited<ReturnType<typeof openDatabase>>, query = {}) =>
	readBoard({
		db,
		rpcSource: METEORA_SOURCE,
		chainRpcSources: [{ chain: "solana", evmChainId: null, rpcSource: METEORA_SOURCE }],
		query: { includeWindows: "all", ...query },
	});

it("uses only observations at or before each window target and leaves unavailable windows empty", async () => {
	const db = createClient({ url: ":memory:" });
	try {
		await migrate(db);
		const api = source();
		const refreshAt = (seconds: number, price: number) => {
			api.setPrice(price);
			return runMeteoraRefresh({
				db,
				config: {
					fetchImpl: api.fetchImpl,
					now: () => new Date((H + seconds) * 1000),
					historyPoolBudget: 0,
				},
			});
		};
		await refreshAt(-3600 - 301, 900);
		await refreshAt(-180, 100);
		await refreshAt(30, 200);
		await refreshAt(300, 125);
		const board = await read(db);
		if (!board.ok) throw new Error(board.error);
		expect(board.rows[0]?.priceChange).toMatchObject({
			value: "0.25",
			asOf: new Date((H + 300) * 1000).toISOString(),
			reason: "meteora_sampled_pool_price",
		});
		expect(board.rows[0]?.windows?.["2h"].priceChange.value).toBeNull();
		expect(board.rows[0]?.feesUsd.value).toBe("7");
		expect(api.fetchImpl).toHaveBeenCalledTimes(8);
		await refreshAt(600, 100);
		const flat = await read(db);
		expect(flat.ok && flat.rows[0]?.priceChange.value).toBe("0");
		await db.execute({
			sql: "UPDATE meteora_price_observations SET token_x = token_y WHERE observed_at_ms = ?",
			args: [(H - 180) * 1000],
		});
		const mismatch = await read(db);
		expect(mismatch.ok && mismatch.rows[0]?.priceChange.value).toBeNull();
	} finally {
		db.close();
	}
});

it("publishes official metrics when optional price storage or reading fails", async () => {
	const db = createClient({ url: ":memory:" });
	try {
		await migrate(db);
		await db.execute("DROP TABLE meteora_price_observations");
		const api = source();
		const result = await runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } });
		expect(result.warnings).toContain("Meteora 池价样本未保存");
		const board = await read(db);
		if (!board.ok) throw new Error(board.error);
		expect(board.rows[0]?.priceChange.value).toBeNull();
		expect(board.rows[0]?.feesUsd.value).toBe("7");
		expect(board.rows[0]?.volumeUsd.value).toBe("200");
	} finally {
		db.close();
	}
});

it("publishes official candidates through the existing hourly tables, with six reported-fee windows while preserving net LP storage", async () => {
	const db = await database();
	try {
		const api = source();
		const result = await runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } });
		expect(result.blockNumber).toBeNull();
		expect(api.fetchImpl).toHaveBeenCalledTimes(3);
		const board = await read(db);
		if (!board.ok) throw new Error(board.error);
		expect(board.rows).toHaveLength(1);
		const row = board.rows[0];
		expect(row).toMatchObject({
			chainId: null,
			chain: "solana",
			poolId: pool.address,
			feeTierPips: null,
			feesUsd: { value: "7", feeBasis: "reported_fees" },
			feesApr: { feeBasis: "reported_fees" },
		});
		for (const [id, hours] of [
			["1h", 1],
			["2h", 2],
			["4h", 4],
			["6h", 6],
			["24h", 24],
			["3d", 72],
		] as const)
			expect(row?.windows?.[id].volumeUsd.value).toBe(String(hours * 200));
		expect(row?.officialPool?.metadata.reserveX).toBe(pool.reserve_x);
		expect((await listWindowsInRange(db, H, H + 3600, "solana"))[0]).toMatchObject({
			complete: false,
			volumeUsd: "200",
			reportedFeesUsd: "7",
			reportedProtocolFeesUsd: "1",
			lpFeesUsd: null,
			sourceObservation: { coverage: "reported_hour", finality: "unverified", dataCutoff: null },
		});
		const revision = await latestPublicationRevision(db, ["solana"]);
		api.setVolume(150);
		await runMeteoraRefresh({
			db,
			config: { fetchImpl: api.fetchImpl, now: () => new Date((H + 1900) * 1000) },
		});
		expect(api.fetchImpl).toHaveBeenCalledTimes(5);
		expect(await latestPublicationRevision(db, ["solana"])).not.toBe(revision);
		const revised = await read(db);
		if (!revised.ok) throw new Error(revised.error);
		expect(revised.rows[0]?.volumeUsd.value).toBe("150");
		expect(revised.rows[0]?.windows?.["3d"].volumeUsd.value).toBe(String(72 * 200 - 3 * 50));
		const hidden = await read(db, {
			metricConditions: [{ field: "feesApr", operator: ">", value: "1", window: "1h" }],
		});
		expect(hidden.ok && hidden.rows.length).toBe(0);
	} finally {
		db.close();
	}
});

it("uses official fees only and elapsed-time annualization without changing stored LP fees", async () => {
	const db = await database();
	try {
		const api = source();
		await runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } });
		const board = await read(db);
		if (!board.ok) throw new Error(board.error);
		const row = board.rows[0]!;
		for (const [id, count] of [
			["1h", 1],
			["2h", 2],
			["4h", 4],
			["6h", 6],
			["24h", 24],
			["3d", 72],
		] as const) {
			const metrics = row.windows![id];
			expect(metrics.feesUsd.value).toBe(String(count * 7));
			expect(metrics.feesApr.feeBasis).toBe("reported_fees");
			expect(new Decimal(metrics.feesApr.value!).toNumber()).toBeCloseTo(
				(((count * 7) / Number(row.tvlUsd.value)) * 31536000) / (count * 3600 - 1800),
				10,
			);
			expect(new Decimal(metrics.capitalEfficiency.value!).toNumber()).toBeCloseTo(
				(count * 200) / Number(row.tvlUsd.value),
				10,
			);
			expect(metrics.changeVsPrevWindow.value).toBe(id === "3d" ? null : "0");
			expect(metrics.priceChange.value).toBeNull();
		}
		const match = await read(db, {
			metricConditions: [{ field: "fees", operator: ">", value: "6", window: "1h" }],
		});
		expect(match.ok && match.rows.length).toBe(1);
		await db.execute({
			sql: "UPDATE window_aggregates SET reported_protocol_fees_usd=NULL WHERE window_start=?",
			args: [H],
		});
		const missing = await read(db);
		if (!missing.ok) throw new Error(missing.error);
		expect(missing.rows[0]!.feesUsd.value).toBe("7");
		expect(missing.rows[0]!.feesApr.value).toBe(row.feesApr.value);
		await db.execute({
			sql: "UPDATE window_aggregates SET reported_fees_usd=NULL WHERE window_start=?",
			args: [H],
		});
		const noFees = await read(db);
		if (!noFees.ok) throw new Error(noFees.error);
		expect(noFees.rows[0]!.feesUsd.value).toBeNull();
		expect(noFees.rows[0]!.feesApr.value).toBeNull();
		expect(missing.rows[0]!.volumeUsd.value).toBe("200");
		await db.execute({
			sql: "UPDATE window_aggregates SET reported_fees_usd='0', reported_protocol_fees_usd='0' WHERE window_start IN (?,?)",
			args: [H, H - 3600],
		});
		const zero = await read(db);
		if (!zero.ok) throw new Error(zero.error);
		expect(zero.rows[0]!.feesUsd.value).toBe("0");
		expect(zero.rows[0]!.feesApr.value).toBe("0");
		expect(zero.rows[0]!.changeVsPrevWindow.value).toBeNull();
		expect(zero.rows[0]!.changeVsPrevWindow.reason).toBe("previous_zero");
		await db.execute({
			sql: "UPDATE window_aggregates SET source_observation=json_set(source_observation,'$.schemaVersion','other-version') WHERE window_start=?",
			args: [H - 3600],
		});
		const mixed = await read(db);
		if (!mixed.ok) throw new Error(mixed.error);
		expect(mixed.rows[0]!.windows!["2h"].feesUsd.value).toBeNull();
		expect((await listWindowsInRange(db, H, H + 3600, "solana"))[0]!.lpFeesUsd).toBeNull();
	} finally {
		db.close();
	}
});

it("keeps a current admitted candidate when cold history is deferred and its long window is missing", async () => {
	const db = await database();
	try {
		const api = source();
		await runMeteoraRefresh({
			db,
			config: { fetchImpl: api.fetchImpl, now, historyPoolBudget: 0 },
		});
		const board = await read(db, { window: "3d" });
		if (!board.ok) throw new Error(board.error);
		expect(board.rows).toHaveLength(1);
		expect(board.rows[0]?.volumeUsd.value).toBeNull();
		expect(board.rows[0]?.windows?.["1h"].volumeUsd.value).toBe("200");
		expect(board.rows[0]?.windows?.["4h"].volumeUsd.value).toBeNull();
	} finally {
		db.close();
	}
});

it("resumes across the hour and rejects a late directory response after reopening storage", async () => {
	let db = await database();
	const location = path.join(dirs[dirs.length - 1]!, "test.db");
	const api = source();
	try {
		await runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } });
		db.close();
		db = await openDatabase(location);
		await runMeteoraRefresh({
			db,
			config: { fetchImpl: api.fetchImpl, now: () => new Date((H + 3700) * 1000) },
		});
		const board = await read(db);
		if (!board.ok) throw new Error(board.error);
		expect(board.rows[0]?.windows?.["2h"].volumeUsd.value).toBe("400");
		expect(api.fetchImpl).toHaveBeenCalledTimes(5);
		const revision = await latestPublicationRevision(db, ["solana"]);
		api.setVolume(900);
		await expect(
			runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } }),
		).rejects.toThrow("older than publication");
		expect(await latestPublicationRevision(db, ["solana"])).toBe(revision);
		const retained = await read(db);
		expect(retained.ok && retained.rows[0]?.windows?.["1h"].volumeUsd.value).toBe("200");
	} finally {
		db.close();
	}
});

it("rolls back directory, hours and publication together, then publishes a genuine empty directory", async () => {
	// Native statements retained after an injected SQL error must not pin a Windows test file.
	const db = createClient({ url: ":memory:" });
	await migrate(db);
	const api = source();
	try {
		await db.execute(
			"CREATE TRIGGER reject_official_hour BEFORE INSERT ON window_aggregates BEGIN SELECT RAISE(ABORT, 'injected hour failure'); END",
		);
		await expect(
			runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } }),
		).rejects.toThrow("injected hour failure");
		for (const table of [
			"pools",
			"tokens",
			"window_aggregates",
			"scanned_hours",
			"chain_publications",
		])
			expect((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n).toBe(0);
		await db.execute("DROP TRIGGER reject_official_hour");
		await runMeteoraRefresh({ db, config: { fetchImpl: api.fetchImpl, now } });
		const revision = await latestPublicationRevision(db, ["solana"]);
		await runMeteoraRefresh({
			db,
			config: {
				now: () => new Date((H + 1900) * 1000),
				fetchImpl: async () =>
					new Response(
						JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 1000, data: [] }),
					),
			},
		});
		expect(await latestPublicationRevision(db, ["solana"])).not.toBe(revision);
		const board = await read(db);
		expect(board.ok && board.rows.length).toBe(0);
	} finally {
		db.close();
	}
});

it("retains the previous publication on discovery failure without writing a fake empty snapshot", async () => {
	const db = await database();
	try {
		const api = source();
		await runMeteoraRefresh({
			db,
			config: { fetchImpl: api.fetchImpl, now, historyPoolBudget: 0 },
		});
		const revision = await latestPublicationRevision(db, ["solana"]);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response("bad", { status: 400 }));
		await expect(runMeteoraRefresh({ db, config: { fetchImpl, now } })).rejects.toThrow();
		expect(await latestPublicationRevision(db, ["solana"])).toBe(revision);
		const board = await read(db);
		expect(board.ok && board.rows.length).toBe(1);
	} finally {
		db.close();
	}
});

it("uses the existing HTTP refresh, health, pagination and pool-detail query without enabling Solana by default", async () => {
	const db = await database();
	const api = source();
	const app = buildApp({
		db,
		rpc: resolveRpcConfig({}),
		solanaDlmm: { fetchImpl: api.fetchImpl, now, historyPoolBudget: 1 },
	});
	try {
		const accepted = await app.inject({
			method: "POST",
			url: "/api/v1/refresh",
			payload: { chain: "solana", protocol: "meteora_dlmm" },
		});
		expect(accepted.statusCode).toBe(202);
		await vi.waitFor(
			async () => {
				const health = (await app.inject("/api/v1/health")).json();
				expect(
					health.chainRpcSources.find((s: { chain: string }) => s.chain === "solana").refresh
						.status,
				).toBe("ok");
			},
			{ timeout: 3000 },
		);
		const board = (
			await app.inject("/api/v2/board?chain=solana&includeWindows=all&pageSize=50")
		).json();
		expect(board.rows).toHaveLength(1);
		expect(board.pagination.total).toBe(1);
		expect(board.appliedFilters.dlmmFilters).toEqual({});
		expect(board.rows[0].windows["3d"].volumeUsd.value).toBe("14400");
		const dlmm = (filters: Record<string, string>) =>
			`&dlmmFilters=${encodeURIComponent(JSON.stringify(filters))}`;
		const bin = String(pool.pool_config.bin_step);
		const matching = dlmm({ binStepMin: bin, binStepMax: bin, farm: "false" });
		const all = (
			await app.inject(`/api/v2/board?includeWindows=all&pageSize=50${matching}`)
		).json();
		const sol = (
			await app.inject(`/api/v2/board?chain=solana&includeWindows=all&pageSize=50${matching}`)
		).json();
		expect(sol.pagination.total).toBe(1);
		expect(sol.appliedFilters.dlmmFilters).toEqual({
			binStepMin: bin,
			binStepMax: bin,
			farm: "false",
		});
		expect(all.rows.filter((row: { chain: string }) => row.chain === "solana")).toEqual(sol.rows);
		const filtered = (
			await app.inject(
				`/api/v2/board?chain=solana&pageSize=50${dlmm({ binStepMin: String(Number(bin) + 1) })}`,
			)
		).json();
		expect(filtered.pagination.total).toBe(0);
		expect(
			(await app.inject(`/api/v2/board?chain=solana${dlmm({ farmAprMin: "0" })}`)).statusCode,
		).toBe(400);
		expect(
			(await app.inject(`/api/v2/board?chain=solana${dlmm({ binStepMin: "5", binStepMax: "4" })}`))
				.statusCode,
		).toBe(400);
		const key = JSON.stringify(["solana", "meteora_dlmm", pool.address]);
		const detail = (
			await app.inject(
				`/api/v2/board?chain=solana&includeWindows=all&snapshotId=${board.pagination.snapshotId}&poolKeys=${encodeURIComponent(key)}`,
			)
		).json();
		expect(detail.rows[0].officialPool.metadata.tokenX.address).toBe(pool.token_x.address);
		expect(api.fetchImpl).toHaveBeenCalledTimes(3);
	} catch (error) {
		await app.close();
		db.close();
		throw error;
	} finally {
		await app.close();
	}
	const disabled = buildApp({ db, rpc: resolveRpcConfig({}) });
	try {
		expect(
			(
				await disabled.inject({
					method: "POST",
					url: "/api/v1/refresh",
					payload: { chain: "solana" },
				})
			).statusCode,
		).toBe(400);
	} finally {
		await disabled.close();
		db.close();
	}
});

it.each([
	["warm", H - 3600, 0],
	["cold", H - 12 * 3600, 128],
] as const)(
	"reports a missing %s closed hour while retaining current publication",
	async (_, missing, historyPoolBudget) => {
		const db = await database();
		try {
			const api = source({ missingHours: [missing] });
			const result = await runMeteoraRefresh({
				db,
				config: { fetchImpl: api.fetchImpl, now, historyPoolBudget },
			});
			expect(result.gaps.some((gap) => gap.includes("官方小时缺档 1 条"))).toBe(true);
			const run = (
				await db.execute("SELECT status, gaps FROM refresh_runs ORDER BY id DESC LIMIT 1")
			).rows[0];
			expect(run?.status).toBe("partial");
			expect(String(run?.gaps)).toContain("官方小时缺档");
			const board = await read(db);
			if (!board.ok) throw new Error(board.error);
			expect(board.rows[0]?.windows?.["1h"].volumeUsd.value).toBe("200");
			expect(
				board.rows[0]?.windows?.[missing === H - 3600 ? "2h" : "24h"].volumeUsd.value,
			).toBeNull();
		} finally {
			db.close();
		}
	},
);

it("records unattempted backfill as pending without claiming source gaps", async () => {
	const db = await database();
	try {
		const api = source();
		const result = await runMeteoraRefresh({
			db,
			config: { fetchImpl: api.fetchImpl, now, historyPoolBudget: 0 },
		});
		expect(result.gaps).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("pending_backfill: 1")]);
		expect(
			(await db.execute("SELECT status, warnings FROM refresh_runs ORDER BY id DESC LIMIT 1"))
				.rows[0],
		).toMatchObject({ status: "ok", warnings: JSON.stringify(result.warnings) });
	} finally {
		db.close();
	}
});

it.each([false, true])(
	"exempts pre-creation missing hours only with known creation: unknown=%s",
	async (unknown) => {
		const db = await database();
		try {
			const api = source({
				missingHours: [H - 3600, H - 7200],
				createdAt: unknown ? null : (H + 600) * 1000,
			});
			const result = await runMeteoraRefresh({
				db,
				config: { fetchImpl: api.fetchImpl, now, historyPoolBudget: 0 },
			});
			expect(result.gaps.length > 0).toBe(unknown);
			const board = await read(db);
			if (!board.ok) throw new Error(board.error);
			expect(board.rows[0]?.volumeUsd.value).toBe("200");
		} finally {
			db.close();
		}
	},
);
