-- Replayable migration: tokens PK becomes (chain_id, address);
-- refresh_runs counts become per-venue JSON instead of pools_v3 / pools_v4.
-- Existing rows are treated as Elysium mainnet (chain id 99901).
-- Do not rewrite 001_init.sql; already-applied databases must reach this state via 002.

BEGIN;

CREATE TABLE tokens_002 (
	chain_id INTEGER NOT NULL,
	address TEXT NOT NULL,
	symbol TEXT NOT NULL,
	decimals INTEGER NOT NULL,
	name TEXT,
	PRIMARY KEY (chain_id, address)
);

INSERT INTO tokens_002 (chain_id, address, symbol, decimals, name)
SELECT 99901, address, symbol, decimals, name FROM tokens;

DROP TABLE tokens;
ALTER TABLE tokens_002 RENAME TO tokens;

CREATE TABLE refresh_runs_002 (
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
	pool_counts TEXT,
	windows_built INTEGER,
	duration_ms INTEGER,
	scope_chain TEXT,
	scope_protocol TEXT
);

INSERT INTO refresh_runs_002 (
	id, started_at, finished_at, status, rpc_source_kind, rpc_source_label,
	block_number, block_time, error, gaps, warnings, pool_counts,
	windows_built, duration_ms, scope_chain, scope_protocol
)
SELECT
	id,
	started_at,
	finished_at,
	status,
	rpc_source_kind,
	rpc_source_label,
	block_number,
	block_time,
	error,
	gaps,
	warnings,
	CASE
		WHEN pools_v3 IS NULL AND pools_v4 IS NULL THEN NULL
		ELSE json_array(
			json_object(
				'chain', 'elysium',
				'evmChainId', 99901,
				'protocol', 'uniswap_v3',
				'count', COALESCE(pools_v3, 0)
			),
			json_object(
				'chain', 'elysium',
				'evmChainId', 99901,
				'protocol', 'uniswap_v4',
				'count', COALESCE(pools_v4, 0)
			)
		)
	END,
	windows_built,
	duration_ms,
	NULL,
	NULL
FROM refresh_runs;

DROP TABLE refresh_runs;
ALTER TABLE refresh_runs_002 RENAME TO refresh_runs;

DELETE FROM sqlite_sequence WHERE name IN ('refresh_runs', 'refresh_runs_002');
INSERT INTO sqlite_sequence (name, seq)
SELECT 'refresh_runs', IFNULL((SELECT MAX(id) FROM refresh_runs), 0);

COMMIT;
