import path from "node:path";
import { createClient } from "@libsql/client";

const db = createClient({ url: `file:${path.resolve("data/lp-atlas.db")}` });
await db.execute("PRAGMA query_only=ON");
const H = 3600;
const START = 1794232800;
const CURRENT = (await db.execute("SELECT MAX(window_start) AS m FROM scanned_hours")).rows[0].m;
const END = Number(CURRENT); // incomplete current hour start; complete hours are < END
const sh = (u) =>
	new Date((Number(u) + 8 * 3600) * 1000).toISOString().replace("T", " ").slice(0, 16);

const q = await db.execute({
	sql: `
    SELECT
      strftime('%Y-%m-%d', datetime(window_start + 8*3600, 'unixepoch')) AS day,
      COUNT(*) AS rows_n,
      SUM(CASE WHEN complete=1 THEN 1 ELSE 0 END) AS complete_n,
      COUNT(DISTINCT pool_id) AS pools_n,
      SUM(CASE WHEN complete=1 AND tvl_usd IS NOT NULL AND CAST(tvl_usd AS REAL) >= 1000
        AND volume_usd IS NOT NULL AND CAST(volume_usd AS REAL) >= 100
        AND lp_fees_usd IS NOT NULL AND CAST(lp_fees_usd AS REAL) >= 10
        AND (fee_status IS NULL OR fee_status IN ('estimated','verified_zero'))
        THEN 1 ELSE 0 END) AS qual_n,
      COUNT(DISTINCT CASE WHEN complete=1 AND tvl_usd IS NOT NULL AND CAST(tvl_usd AS REAL) >= 1000
        AND volume_usd IS NOT NULL AND CAST(volume_usd AS REAL) >= 100
        AND lp_fees_usd IS NOT NULL AND CAST(lp_fees_usd AS REAL) >= 10
        AND (fee_status IS NULL OR fee_status IN ('estimated','verified_zero'))
        THEN pool_id END) AS qual_pools
    FROM window_aggregates
    WHERE window_start >= ? AND window_start < ?
    GROUP BY day
    ORDER BY day
  `,
	args: [START, END],
});

const extremes = await db.execute({
	sql: `
    SELECT pool_id, window_start, complete, volume_usd, lp_fees_usd, tvl_usd, swap_count, fee_status
    FROM window_aggregates
    WHERE window_start >= ? AND window_start < ?
      AND (
        (volume_usd IS NOT NULL AND CAST(volume_usd AS REAL) >= 1e8)
        OR (lp_fees_usd IS NOT NULL AND CAST(lp_fees_usd AS REAL) >= 1e5)
        OR (tvl_usd IS NOT NULL AND CAST(tvl_usd AS REAL) >= 1e9)
        OR (volume_usd IS NOT NULL AND volume_usd NOT GLOB '*[0-9.]*')
      )
    ORDER BY CAST(volume_usd AS REAL) DESC
    LIMIT 40
  `,
	args: [START, END],
});

const dist = await db.execute({
	sql: `
    SELECT
      MIN(CAST(volume_usd AS REAL)) AS vmin, MAX(CAST(volume_usd AS REAL)) AS vmax,
      MIN(CAST(lp_fees_usd AS REAL)) AS fmin, MAX(CAST(lp_fees_usd AS REAL)) AS fmax,
      MIN(CAST(tvl_usd AS REAL)) AS tmin, MAX(CAST(tvl_usd AS REAL)) AS tmax
    FROM window_aggregates
    WHERE window_start >= ? AND window_start < ? AND complete=1
      AND volume_usd IS NOT NULL AND lp_fees_usd IS NOT NULL AND tvl_usd IS NOT NULL
  `,
	args: [START, END],
});

// percentiles among qualifying-threshold rows
const all = await db.execute({
	sql: `
    SELECT CAST(volume_usd AS REAL) AS v, CAST(lp_fees_usd AS REAL) AS f, CAST(tvl_usd AS REAL) AS t
    FROM window_aggregates
    WHERE window_start >= ? AND window_start < ? AND complete=1
      AND tvl_usd IS NOT NULL AND CAST(tvl_usd AS REAL) >= 1000
      AND volume_usd IS NOT NULL AND CAST(volume_usd AS REAL) >= 100
      AND lp_fees_usd IS NOT NULL AND CAST(lp_fees_usd AS REAL) >= 10
  `,
	args: [START, END],
});
const vs = all.rows.map((r) => Number(r.v)).sort((a, b) => a - b);
const fs = all.rows.map((r) => Number(r.f)).sort((a, b) => a - b);
const ts = all.rows.map((r) => Number(r.t)).sort((a, b) => a - b);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];

console.log(
	JSON.stringify(
		{
			currentHour: { unix: END, label: sh(END) },
			byDay: q.rows,
			dist: dist.rows,
			qualifyingN: all.rows.length,
			volumePct: {
				p50: pct(vs, 0.5),
				p90: pct(vs, 0.9),
				p99: pct(vs, 0.99),
				p999: pct(vs, 0.999),
				max: vs.at(-1),
				p99_100x: pct(vs, 0.99) * 100,
			},
			feePct: {
				p50: pct(fs, 0.5),
				p90: pct(fs, 0.9),
				p99: pct(fs, 0.99),
				p999: pct(fs, 0.999),
				max: fs.at(-1),
				p99_100x: pct(fs, 0.99) * 100,
			},
			tvlPct: {
				p50: pct(ts, 0.5),
				p90: pct(ts, 0.9),
				p99: pct(ts, 0.99),
				p999: pct(ts, 0.999),
				max: ts.at(-1),
			},
			extremes: extremes.rows.map((r) => ({ ...r, window_start: sh(r.window_start) })),
		},
		(_, v) => (typeof v === "bigint" ? Number(v) : v),
		2,
	),
);
db.close();
