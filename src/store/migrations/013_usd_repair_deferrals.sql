CREATE TABLE IF NOT EXISTS usd_repair_deferrals (
 pool_id TEXT NOT NULL,
 window_start INTEGER NOT NULL,
 to_block TEXT NOT NULL,
 window_as_of TEXT NOT NULL,
 window_input TEXT NOT NULL,
 catalog_rowid INTEGER NOT NULL,
 valuation_version INTEGER NOT NULL,
 reason TEXT NOT NULL,
 evidence TEXT NOT NULL,
 PRIMARY KEY (pool_id, window_start)
);
