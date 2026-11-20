import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const root = process.cwd();
const db = createClient({ url: `file:${path.resolve(root, "data/lp-atlas.db")}` });
await db.execute("PRAGMA query_only=ON");

const sh = (unix) =>
	new Date((Number(unix) + 8 * 3600) * 1000).toISOString().replace("T", " ").slice(0, 16);
const H = 3600;
const START = Date.parse("2026-11-09T14:00:00.000Z") / 1000;

const meta = await db.execute(`
  SELECT
    MIN(window_start) AS min_start,
    MAX(window_start) AS max_start,
    COUNT(*) AS n,
    SUM(complete) AS complete_n,
    COUNT(DISTINCT pool_id) AS pools
  FROM window_aggregates
`);
const cols = await db.execute("PRAGMA table_info(window_aggregates)");
const scan = await db.execute(`
  SELECT chain_id, protocol, MIN(window_start) AS min_start, MAX(window_start) AS max_start,
         COUNT(*) AS n, SUM(complete) AS complete_n, SUM(CASE WHEN gap_reason IS NOT NULL AND gap_reason != '' THEN 1 ELSE 0 END) AS gapped
  FROM scanned_hours GROUP BY chain_id, protocol
`);
const last = await db.execute(
	"SELECT id, status, block_time, started_at, finished_at, rpc_source_kind, rpc_source_label, windows_built FROM refresh_runs ORDER BY id DESC LIMIT 5",
);
const feeCols = await db.execute(
	"SELECT fee_status, COUNT(*) n FROM window_aggregates GROUP BY fee_status",
);

console.log(
	JSON.stringify(
		{
			meta: meta.rows,
			columns: cols.rows.map((r) => r.name),
			scanned: scan.rows,
			lastRefresh: last.rows,
			feeStatus: feeCols.rows,
			start: START,
			startLabel: sh(START),
		},
		(_, v) => (typeof v === "bigint" ? Number(v) : v),
		2,
	),
);

db.close();
