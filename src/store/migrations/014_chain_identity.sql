-- Compatibility expansion. Execute only through the atomic migration runner.
-- All old rowids and physical pool keys survive. Unknown chain IDs fail NOT NULL.
-- Preflight cannot silently discard a NULL physical key or an orphaned logical reference.
CREATE TABLE migration_014_preflight(valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO migration_014_preflight(valid)
 SELECT CASE WHEN
 EXISTS(SELECT 1 FROM pools WHERE pool_id IS NULL OR pool_id='') OR
 EXISTS(SELECT 1 FROM window_aggregates w WHERE NOT EXISTS(SELECT 1 FROM pools p WHERE p.pool_id=w.pool_id)) OR
 EXISTS(SELECT 1 FROM usd_repair_deferrals d WHERE NOT EXISTS(SELECT 1 FROM pools p WHERE p.pool_id=d.pool_id))
 THEN 0 ELSE 1 END;
DROP TABLE migration_014_preflight;
CREATE TABLE tokens_014 (
 chain_key TEXT NOT NULL, chain_id INTEGER, address TEXT NOT NULL COLLATE BINARY,
 symbol TEXT NOT NULL, decimals INTEGER NOT NULL, name TEXT,
 PRIMARY KEY(chain_key,address), CHECK ((chain_key = 'solana' AND chain_id IS NULL) OR (chain_id IS NOT NULL AND chain_key = CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' ELSE '' END))
);
INSERT INTO tokens_014(rowid,chain_key,chain_id,address,symbol,decimals,name)
 SELECT rowid,CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' END,chain_id,address,symbol,decimals,name FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_014 RENAME TO tokens;
CREATE INDEX idx_tokens_legacy_chain ON tokens(chain_id,address);

CREATE TABLE pools_014 (
 pool_id TEXT PRIMARY KEY NOT NULL, chain_key TEXT NOT NULL, chain_id INTEGER,
 native_pool_id TEXT NOT NULL COLLATE BINARY, protocol TEXT NOT NULL,
 token0 TEXT NOT NULL, token1 TEXT NOT NULL, fee_pips INTEGER, tick_spacing INTEGER,
 hooks TEXT, pool_address TEXT, created_block INTEGER, created_at_unix INTEGER,
 discovered_at TEXT NOT NULL,
 UNIQUE(chain_key,protocol,native_pool_id), CHECK ((chain_key = 'solana' AND chain_id IS NULL) OR (chain_id IS NOT NULL AND chain_key = CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' ELSE '' END)),
 CHECK(chain_key != 'solana' OR (tick_spacing IS NULL AND created_block IS NULL)),
 CHECK(chain_id IS NULL OR (fee_pips IS NOT NULL AND tick_spacing IS NOT NULL AND created_block IS NOT NULL))
);
WITH RECURSIVE native_ids(pool_id,tail) AS (
 SELECT pool_id,pool_id FROM pools
 UNION ALL SELECT pool_id,substr(tail,instr(tail,':')+1) FROM native_ids WHERE instr(tail,':')>0
)
INSERT INTO pools_014(rowid,pool_id,chain_key,chain_id,native_pool_id,protocol,token0,token1,
 fee_pips,tick_spacing,hooks,pool_address,created_block,created_at_unix,discovered_at)
SELECT p.rowid,p.pool_id,CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' END,p.chain_id,n.tail,p.protocol,p.token0,p.token1,
 p.fee_pips,p.tick_spacing,p.hooks,p.pool_address,p.created_block,p.created_at_unix,p.discovered_at
FROM pools p JOIN native_ids n ON n.pool_id=p.pool_id AND instr(n.tail,':')=0;
DROP TABLE pools;
ALTER TABLE pools_014 RENAME TO pools;
CREATE INDEX idx_pools_protocol ON pools(protocol);
CREATE INDEX idx_pools_chain_protocol ON pools(chain_id,protocol);
CREATE INDEX idx_pools_chain ON pools(chain_id);
CREATE INDEX idx_pools_chain_created_time ON pools(chain_id,created_block,created_at_unix);
CREATE INDEX idx_pools_chain_key ON pools(chain_key);
CREATE INDEX idx_pools_chain_key_protocol ON pools(chain_key,protocol);

CREATE TABLE scanned_hours_014 (
 chain_key TEXT NOT NULL, chain_id INTEGER, protocol TEXT NOT NULL,
 window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, complete INTEGER NOT NULL,
 from_block TEXT, to_block TEXT, as_of TEXT NOT NULL, gap_reason TEXT,
 state_block_number TEXT, price_boundary_version INTEGER, usd_bridge_version INTEGER,
 usd_valuation_version INTEGER, usd_quote_json TEXT,
 coverage_scope TEXT NOT NULL DEFAULT 'venue', source_observation TEXT,
 PRIMARY KEY(chain_key,protocol,window_start,coverage_scope), CHECK ((chain_key = 'solana' AND chain_id IS NULL) OR (chain_id IS NOT NULL AND chain_key = CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' ELSE '' END)),
 CHECK(chain_id IS NULL OR (from_block IS NOT NULL AND to_block IS NOT NULL AND coverage_scope='venue')),
 CHECK(chain_key != 'solana' OR (coverage_scope != 'venue' AND source_observation IS NOT NULL
 AND state_block_number IS NULL AND from_block IS NULL AND to_block IS NULL
 AND price_boundary_version IS NULL AND usd_bridge_version IS NULL AND usd_valuation_version IS NULL AND usd_quote_json IS NULL))
);
INSERT INTO scanned_hours_014(rowid,chain_key,chain_id,protocol,window_start,window_end,
 complete,from_block,to_block,as_of,gap_reason,state_block_number,price_boundary_version,
 usd_bridge_version,usd_valuation_version,usd_quote_json,coverage_scope)
SELECT rowid,CASE chain_id WHEN 99901 THEN 'elysium' WHEN 4663 THEN 'robinhood' WHEN 56 THEN 'bsc' WHEN 1 THEN 'ethereum' WHEN 8453 THEN 'base' END,chain_id,protocol,window_start,window_end,complete,from_block,to_block,
 as_of,gap_reason,state_block_number,price_boundary_version,usd_bridge_version,
 usd_valuation_version,usd_quote_json,'venue' FROM scanned_hours;
DROP TABLE scanned_hours;
ALTER TABLE scanned_hours_014 RENAME TO scanned_hours;
CREATE INDEX idx_scanned_hours_start ON scanned_hours(window_start);
CREATE INDEX idx_scanned_hours_legacy ON scanned_hours(chain_id,protocol,window_start);

CREATE TABLE window_aggregates_014 (
 pool_id TEXT NOT NULL, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
 complete INTEGER NOT NULL, volume0 TEXT, volume1 TEXT, lp_fees0 TEXT, lp_fees1 TEXT,
 swap_count INTEGER, volume_usd TEXT, lp_fees_usd TEXT, tvl_usd TEXT,
 sqrt_price_start TEXT, sqrt_price_end TEXT, source TEXT NOT NULL, as_of TEXT NOT NULL,
 gap_reason TEXT, fee_status TEXT NOT NULL DEFAULT 'legacy_unverified', usd_valuation_version INTEGER,
 representation TEXT NOT NULL DEFAULT 'native_amounts', source_observation TEXT,
 PRIMARY KEY(pool_id,window_start),
 CHECK((representation='native_amounts' AND volume0 IS NOT NULL AND volume1 IS NOT NULL
  AND lp_fees0 IS NOT NULL AND lp_fees1 IS NOT NULL AND swap_count IS NOT NULL)
 OR (representation='official_usd' AND usd_valuation_version IS NULL AND source_observation IS NOT NULL AND volume0 IS NULL AND volume1 IS NULL
  AND lp_fees0 IS NULL AND lp_fees1 IS NULL AND swap_count IS NULL))
);
INSERT INTO window_aggregates_014(rowid,pool_id,window_start,window_end,complete,
 volume0,volume1,lp_fees0,lp_fees1,swap_count,volume_usd,lp_fees_usd,tvl_usd,
 sqrt_price_start,sqrt_price_end,source,as_of,gap_reason,fee_status,usd_valuation_version)
SELECT rowid,pool_id,window_start,window_end,complete,volume0,volume1,lp_fees0,lp_fees1,
 swap_count,volume_usd,lp_fees_usd,tvl_usd,sqrt_price_start,sqrt_price_end,source,as_of,
 gap_reason,fee_status,usd_valuation_version FROM window_aggregates;
DROP TABLE window_aggregates;
ALTER TABLE window_aggregates_014 RENAME TO window_aggregates;
CREATE INDEX idx_windows_start ON window_aggregates(window_start);
-- Publications already use catalog chain strings; do not duplicate that identity.
-- Keep legacy block fields for EVM, allow an unknown non-EVM cutoff without a fake block 0.
CREATE TABLE chain_publications_014 (
 chain TEXT PRIMARY KEY CHECK(chain IN ('elysium','robinhood','bsc','ethereum','base','solana')),
 revision INTEGER NOT NULL, run_id INTEGER NOT NULL, block_number TEXT, block_time TEXT,
 published_at TEXT NOT NULL, source_observation TEXT,
 CHECK((chain != 'solana' AND block_number IS NOT NULL AND block_time IS NOT NULL)
 OR (chain='solana' AND block_number IS NULL AND source_observation IS NOT NULL))
);
INSERT INTO chain_publications_014(rowid,chain,revision,run_id,block_number,block_time,published_at)
 SELECT rowid,chain,revision,run_id,block_number,block_time,published_at FROM chain_publications;
DROP TABLE chain_publications;
ALTER TABLE chain_publications_014 RENAME TO chain_publications;
-- meta and usd_repair_deferrals are deliberately untouched; deferrals reference preserved physical IDs/rowids.
