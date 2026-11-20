CREATE TABLE IF NOT EXISTS schema_migrations (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
	address TEXT PRIMARY KEY,
	symbol TEXT NOT NULL,
	decimals INTEGER NOT NULL,
	name TEXT
);

CREATE TABLE IF NOT EXISTS pools (
	pool_id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	protocol TEXT NOT NULL,
	token0 TEXT NOT NULL,
	token1 TEXT NOT NULL,
	fee_pips INTEGER NOT NULL,
	tick_spacing INTEGER NOT NULL,
	hooks TEXT,
	pool_address TEXT,
	created_block INTEGER NOT NULL,
	created_at_unix INTEGER,
	discovered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);

CREATE TABLE IF NOT EXISTS window_aggregates (
	pool_id TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	window_end INTEGER NOT NULL,
	complete INTEGER NOT NULL,
	volume0 TEXT NOT NULL,
	volume1 TEXT NOT NULL,
	lp_fees0 TEXT NOT NULL,
	lp_fees1 TEXT NOT NULL,
	swap_count INTEGER NOT NULL,
	volume_usd TEXT,
	lp_fees_usd TEXT,
	tvl_usd TEXT,
	sqrt_price_start TEXT,
	sqrt_price_end TEXT,
	source TEXT NOT NULL,
	as_of TEXT NOT NULL,
	gap_reason TEXT,
	PRIMARY KEY (pool_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_windows_start ON window_aggregates(window_start);

CREATE TABLE IF NOT EXISTS refresh_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL,
	rpc_source_kind TEXT NOT NULL,
	rpc_source_label TEXT NOT NULL,
	block_number TEXT,
	block_time TEXT,
	error TEXT,
	gaps TEXT,
	warnings TEXT,
	pools_v3 INTEGER,
	pools_v4 INTEGER,
	windows_built INTEGER,
	duration_ms INTEGER
);
