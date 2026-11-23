import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/db.ts";
import { getToken, latestSuccessfulRefresh, upsertToken } from "../src/store/repositories.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(root, "../src/store/migrations");

const tempDirs: string[] = [];

afterEach(async () => {
	const dirs = tempDirs.splice(0);
	for (const dir of dirs) {
		await rmTempDir(dir);
	}
});

async function rmTempDir(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: true, force: true });
	} catch (error) {
		// libsql can keep a Windows file lock until process exit.
		const busy = error instanceof Error && (error as NodeJS.ErrnoException).code === "EBUSY";
		if (!busy) {
			throw error;
		}
	}
}

async function tempDbPath(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "lp-atlas-mig-"));
	tempDirs.push(dir);
	return path.join(dir, "lp-atlas.db");
}

describe("migration 002_venue_keys", () => {
	it("migrates an already-applied 001 database without rewriting 001", async () => {
		const dbPath = await tempDbPath();
		const bootstrap = createClient({ url: `file:${dbPath}` });
		const initSql = await readFile(path.join(migrationsDir, "001_init.sql"), "utf8");
		await bootstrap.executeMultiple(initSql);
		await bootstrap.execute({
			sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
			args: ["001_init.sql", "2026-11-11T16:49:32.276Z"],
		});
		await bootstrap.execute({
			sql: "INSERT INTO tokens (address, symbol, decimals, name) VALUES (?, ?, ?, ?)",
			args: ["0xabc0000000000000000000000000000000000001", "USDC", 6, "USD Coin"],
		});
		await bootstrap.execute({
			sql: `
				INSERT INTO refresh_runs (
					started_at, finished_at, status, rpc_source_kind, rpc_source_label,
					pools_v3, pools_v4, windows_built, duration_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			args: [
				"2026-11-11T16:51:37.020Z",
				"2026-11-11T16:53:24.674Z",
				"partial",
				"public_temporary",
				"official public rpc",
				251,
				104613,
				980,
				107654,
			],
		});
		bootstrap.close();

		const db = await openDatabase(dbPath);
		const token = await getToken(db, 99901, "0xabc0000000000000000000000000000000000001");
		expect(token).toMatchObject({
			chainId: 99901,
			address: "0xabc0000000000000000000000000000000000001",
			symbol: "USDC",
			decimals: 6,
		});

		await upsertToken(db, {
			chainId: 56,
			address: "0xabc0000000000000000000000000000000000001",
			symbol: "bUSDC",
			decimals: 18,
			name: "BSC USDC",
		});
		const elysium = await getToken(db, 99901, "0xabc0000000000000000000000000000000000001");
		const bsc = await getToken(db, 56, "0xabc0000000000000000000000000000000000001");
		expect(elysium?.symbol).toBe("USDC");
		expect(elysium?.decimals).toBe(6);
		expect(bsc?.symbol).toBe("bUSDC");
		expect(bsc?.decimals).toBe(18);

		const run = await latestSuccessfulRefresh(db);
		expect(run?.poolCounts).toEqual([
			{ chain: "elysium", evmChainId: 99901, protocol: "uniswap_v3", count: 251 },
			{ chain: "elysium", evmChainId: 99901, protocol: "uniswap_v4", count: 104613 },
		]);
		expect(run?.scopeChain).toBeNull();

		const columns = await db.execute("PRAGMA table_info(refresh_runs)");
		const names = columns.rows.map((row) => String(row.name));
		expect(names).toContain("pool_counts");
		expect(names).not.toContain("pools_v3");
		expect(names).not.toContain("pools_v4");

		const tokenCols = await db.execute("PRAGMA table_info(tokens)");
		expect(tokenCols.rows.map((row) => String(row.name))).toEqual([
			"chain_key",
			"chain_id",
			"address",
			"symbol",
			"decimals",
			"name",
		]);

		const applied = await db.execute("SELECT name FROM schema_migrations ORDER BY name");
		expect(applied.rows.map((row) => String(row.name))).toEqual([
			"001_init.sql",
			"002_venue_keys.sql",
			"003_scanned_hours.sql",
			"004_hourly_retention_index.sql",
			"005_fee_quality.sql",
			"006_hour_state_block.sql",
			"007_price_boundary.sql",
			"008_usd_bridge.sql",
			"009_pool_venue_index.sql",
			"010_chain_publications.sql",
			"011_catalog_incremental_indexes.sql",
			"012_usd_valuation.sql",
			"013_usd_repair_deferrals.sql",
			"014_chain_identity.sql",
			"015_official_pool_details.sql",
			"016_meteora_price_observations.sql",
			"017_token_fdv.sql",
		]);
		const venueIndex = await db.execute("PRAGMA index_info(idx_pools_chain_protocol)");
		expect(venueIndex.rows.map((row) => String(row.name))).toEqual(["chain_id", "protocol"]);
		const scanned = await db.execute("PRAGMA table_info(scanned_hours)");
		expect(scanned.rows.map((row) => String(row.name))).toContain("window_start");
		db.close();
	});

	it("applies 001 then 002 on a fresh database", async () => {
		const dbPath = await tempDbPath();
		const db = await openDatabase(dbPath);
		await upsertToken(db, {
			chainId: 99901,
			address: "0x0000000000000000000000000000000000000001",
			symbol: "HYPE",
			decimals: 18,
			name: "HYPE",
		});
		const token = await getToken(db, 99901, "0x0000000000000000000000000000000000000001");
		expect(token?.symbol).toBe("HYPE");
		db.close();
	});
});
