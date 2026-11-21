import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";
import { loadCatalog } from "../src/normalize/catalog-cache.ts";
import { migrate, migrationBody, openDatabase } from "../src/store/db.ts";
import {
	deferUsdRepair,
	listDeferredUsdRepairs,
	listPoolAdditions,
	listPools,
	listTokens,
	listWindowsInRange,
	upsertPool,
	upsertScannedHour,
	upsertWindow,
} from "../src/store/repositories.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/store/migrations");
const dirs: string[] = [];
function temp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-migrate-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function migrationDir(before14 = false) {
	const dir = temp();
	for (const f of fs.readdirSync(root))
		if (f.endsWith(".sql") && (!before14 || f < "014"))
			fs.copyFileSync(path.join(root, f), path.join(dir, f));
	return dir;
}
async function legacy() {
	const filename = path.join(temp(), "fixture.db");
	const db = createClient({ url: `file:${filename}` });
	await migrate(db, migrationDir(true));
	for (const [rowid, chainId, poolId] of [
		[3, 99901, "same"],
		[19, 4663, "4663:uniswap_v3:same"],
	] as const) {
		await db.execute({
			sql: `INSERT INTO pools(rowid,pool_id,chain_id,protocol,token0,token1,fee_pips,tick_spacing,created_block,discovered_at)
   VALUES (?,?,?,'uniswap_v3','0x01','0x02',3000,60,100,'2026-11-20T00:00:00Z')`,
			args: [rowid, poolId, chainId],
		});
		await db.execute({
			sql: "INSERT INTO tokens(chain_id,address,symbol,decimals) VALUES (?,'0x01','T',18)",
			args: [chainId],
		});
		await db.execute({
			sql: `INSERT INTO window_aggregates(pool_id,window_start,window_end,complete,volume0,volume1,lp_fees0,lp_fees1,swap_count,volume_usd,lp_fees_usd,source,as_of,fee_status)
   VALUES (?,3600,7200,1,'100000000000000001','20','3','4',2,'123.456789','10.000001','self_built','2026-11-20T00:00:00Z','estimated')`,
			args: [poolId],
		});
		await db.execute({
			sql: `INSERT INTO scanned_hours(chain_id,protocol,window_start,window_end,complete,from_block,to_block,as_of,usd_valuation_version)
   VALUES (?,'uniswap_v3',3600,7200,1,'10','100','2026-11-20T00:00:00Z',2)`,
			args: [chainId],
		});
	}
	for (const [key, value] of [
		["v3_discover_block", "101"],
		["v4_discover_block", "102"],
		["4663:v3_discover_block", "201"],
		["4663:v4_discover_block", "202"],
	] as const) {
		await db.execute({ sql: "INSERT INTO meta VALUES (?,?)", args: [key, value] });
	}
	await db.execute(
		`INSERT INTO chain_publications VALUES ('elysium',7,1,'100','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z')`,
	);
	// Historical deferral snapshot is persisted in the old schema's exact input shape.
	await db.execute(`INSERT INTO usd_repair_deferrals VALUES ('same',3600,'100','2026-11-20T00:00:00Z',
  json_array('100000000000000001','20','3','4',2,'123.456789','10.000001',NULL,'estimated',NULL,NULL,NULL),19,2,'no_historical_path','fixture')`);
	return { db, filename };
}
async function durable(db: Client) {
	const values: Record<string, unknown> = {};
	for (const table of ["meta", "chain_publications", "usd_repair_deferrals"])
		values[table] = (
			await db.execute(
				`SELECT ${table === "chain_publications" ? "chain,revision,run_id,block_number,block_time,published_at" : "*"} FROM ${table} ORDER BY 1`,
			)
		).rows;
	values.publicationRowIds = (
		await db.execute("SELECT rowid,chain FROM chain_publications ORDER BY rowid")
	).rows;
	values.poolRows = (
		await db.execute("SELECT rowid,pool_id,chain_id,protocol FROM pools ORDER BY rowid")
	).rows;
	values.windows = (
		await db.execute(
			"SELECT pool_id,volume0,volume1,lp_fees0,lp_fees1,swap_count,volume_usd,lp_fees_usd,fee_status FROM window_aggregates ORDER BY pool_id",
		)
	).rows;
	return JSON.stringify(values);
}

it("preserves sparse pool rowids, exact amounts, deferrals, publication and all four discovery keys across upgrade/reopen", async () => {
	const { db, filename } = await legacy();
	const before = await durable(db);
	await migrate(db);
	expect(await durable(db)).toBe(before);
	expect((await db.execute("PRAGMA integrity_check")).rows[0]?.integrity_check).toBe("ok");
	expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
	expect(await listTokens(db)).toHaveLength(2);
	expect((await listPools(db, 4663))[0]?.nativePoolId).toBe("same");
	expect((await listPoolAdditions(db, 99901, 0)).rowIds).toEqual([3]);
	expect(await listDeferredUsdRepairs(db, 99901)).toEqual(new Map([[3600, new Set(["same"])]]));
	await migrate(db);
	expect(await durable(db)).toBe(before);
	db.close();
	const reopened = await openDatabase(filename);
	try {
		expect(await durable(reopened)).toBe(before);
		const windows = await listWindowsInRange(reopened, 0, 10000, 99901);
		const hour = windows[0];
		if (!hour) throw new Error("fixture");
		const existingPool = (await listPools(reopened, 99901))[0];
		if (!existingPool) throw new Error("missing pool fixture");
		// Cache's watermark sees an inserted late-created bridge once, without invalidating a historical deferral.
		const cached = await loadCatalog(reopened, 99901);
		expect(cached.lastRowId).toBe(3);
		await upsertPool(
			reopened,
			{
				...existingPool,
				poolId: "after",
				nativePoolId: "after",
				createdBlock: 101,
			},
			"2026-11-21T00:00:00Z",
		);
		expect((await loadCatalog(reopened, 99901)).pools.map((p) => p.poolId)).toEqual([
			"same",
			"after",
		]);
		expect((await listPoolAdditions(reopened, 99901, 19)).pools.map((p) => p.poolId)).toEqual([
			"after",
		]);
		expect(await listDeferredUsdRepairs(reopened, 99901)).toEqual(
			new Map([[3600, new Set(["same"])]]),
		);
		await upsertPool(
			reopened,
			{
				...existingPool,
				poolId: "before",
				nativePoolId: "before",
				createdBlock: 99,
			},
			"2026-11-21T00:00:00Z",
		);
		expect(await listDeferredUsdRepairs(reopened, 99901)).toEqual(new Map());
		// Only the affected chain is reconsidered; no clearing of meta or entire queues.
		expect(
			(await reopened.execute("SELECT COUNT(*) AS n FROM usd_repair_deferrals")).rows[0]?.n,
		).toBe(1);
		expect(
			(await reopened.execute("SELECT value FROM meta WHERE key='4663:v3_discover_block'")).rows[0]
				?.value,
		).toBe("201");
		// Existing EVM raw upsert and coverage still work on the expanded schema.
		await upsertWindow(reopened, hour);
		await upsertScannedHour(reopened, {
			chainId: 99901,
			protocol: "uniswap_v3",
			windowStart: 3600,
			windowEnd: 7200,
			complete: true,
			fromBlock: "10",
			toBlock: "100",
			asOf: hour.asOf,
			gapReason: null,
		});
		await deferUsdRepair(reopened, {
			poolId: "same",
			windowStart: 3600,
			toBlock: "100",
			windowAsOf: hour.asOf,
			window: hour,
			catalogRowId: 21,
			reason: "no_historical_path",
			evidence: "test",
		});
	} finally {
		reopened.close();
	}
});

it("rejects conflicting native aliases and nullable legacy physical IDs instead of merging/dropping pools", async () => {
	for (const invalid of ["NULL", "'prefix:same'"]) {
		const { db } = await legacy();
		try {
			await db.execute(
				`INSERT INTO pools(pool_id,chain_id,protocol,token0,token1,fee_pips,tick_spacing,created_block,discovered_at) VALUES (${invalid},99901,'uniswap_v3','0x01','0x02',3000,60,100,'fixture')`,
			);
			const before = await durable(db);
			await expect(migrate(db)).rejects.toThrow();
			expect(await durable(db)).toBe(before);
		} finally {
			db.close();
		}
	}
});

it("rejects unknown legacy chain IDs atomically rather than dropping rows or inventing an identity", async () => {
	const { db } = await legacy();
	try {
		await db.execute("UPDATE tokens SET chain_id=123456 WHERE chain_id=4663");
		const before = await durable(db);
		await expect(migrate(db)).rejects.toThrow();
		expect(await durable(db)).toBe(before);
		expect(
			(await db.execute("SELECT name FROM schema_migrations WHERE name LIKE '014%'")).rows,
		).toEqual([]);
		expect(
			(await db.execute("PRAGMA table_info(tokens)")).rows.some((row) => row.name === "chain_key"),
		).toBe(false);
	} finally {
		db.close();
	}
});

it("rolls schema AND registration back when the version INSERT fails after all DDL, then safely retries", async () => {
	const { db } = await legacy();
	try {
		const before = await durable(db);
		await db.executeMultiple(`CREATE TRIGGER fail_version BEFORE INSERT ON schema_migrations WHEN NEW.name='014_chain_identity.sql'
   BEGIN SELECT RAISE(ABORT,'injected registration failure'); END;`);
		await expect(migrate(db)).rejects.toThrow("injected registration failure");
		expect(await durable(db)).toBe(before);
		expect(
			(await db.execute("PRAGMA table_info(pools)")).rows.some((row) => row.name === "chain_key"),
		).toBe(false);
		await db.execute("DROP TRIGGER fail_version");
		await migrate(db);
		expect(await durable(db)).toBe(before);
	} finally {
		db.close();
	}
});

it("rolls every partial 014 statement prefix back with no table/data/version residue", async () => {
	const { db } = await legacy();
	try {
		const before = await durable(db);
		const source = fs.readFileSync(path.join(root, "014_chain_identity.sql"), "utf8");
		const statements = source
			.replace(/^\s*--.*$/gm, "")
			.split(";")
			.filter((s) => s.trim());
		const custom = temp();
		for (let count = 1; count <= statements.length; count++) {
			fs.writeFileSync(
				path.join(custom, "014_chain_identity.sql"),
				`${statements.slice(0, count).join(";")}; SELECT * FROM intentional_missing_fault_table;`,
			);
			await expect(migrate(db, custom)).rejects.toThrow();
			expect(await durable(db)).toBe(before);
			expect(
				(
					await db.execute(
						"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%014%'",
					)
				).rows,
			).toEqual([]);
			expect(
				(await db.execute("PRAGMA table_info(pools)")).rows.some((row) => row.name === "chain_key"),
			).toBe(false);
		}
		await migrate(db);
		expect(await durable(db)).toBe(before);
	} finally {
		db.close();
	}
}, 30000);

it.each(["before", "after"])(
	"recovers after abrupt process exit %s version registration but before commit",
	async (breakpoint) => {
		const { db, filename } = await legacy();
		const before = await durable(db);
		db.close();
		const moduleUrl = pathToFileURL(path.resolve(root, "../db.ts")).href;
		const script = `import {createClient} from '@libsql/client'; import {migrate} from ${JSON.stringify(moduleUrl)};
 const db=createClient({url:${JSON.stringify(`file:${filename}`)}}); const transaction=db.transaction.bind(db);
 db.transaction=async (...args)=>{const tx=await transaction(...args); const execute=tx.execute.bind(tx);
 tx.execute=async stmt=>{if(typeof stmt==='object' && stmt.sql.startsWith('INSERT INTO schema_migrations')) {
 if(${JSON.stringify(breakpoint)}==='before') process.exit(91); const result=await execute(stmt); process.exit(91); return result;
 } return execute(stmt);};return tx;}; await migrate(db); process.exit(92);`;
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ cwd: path.resolve(root, "../../.."), encoding: "utf8", timeout: 15000 },
		);
		expect(child.status, child.stderr).toBe(91);
		const retry = createClient({ url: `file:${filename}` });
		try {
			expect(await durable(retry)).toBe(before);
			expect(
				(await retry.execute("SELECT name FROM schema_migrations WHERE name LIKE '014%'")).rows,
			).toEqual([]);
			await migrate(retry);
			expect(await durable(retry)).toBe(before);
		} finally {
			retry.close();
		}
	},
	20000,
);

it("unwraps only known outer transaction wrappers and refuses nested controls", () => {
	expect(migrationBody("-- existing\nBEGIN;\nCREATE TABLE t(x);\nCOMMIT;\n")).toContain(
		"CREATE TABLE t",
	);
	expect(() => migrationBody("BEGIN;\nBEGIN;\nCOMMIT;")).toThrow();
	expect(() => migrationBody("CREATE TABLE t(x); COMMIT;")).toThrow();
	expect(() => migrationBody("PRAGMA foreign_keys=OFF;")).toThrow();
});
