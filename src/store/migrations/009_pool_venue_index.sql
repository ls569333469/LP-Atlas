-- Keep directory counts on a covering index as additional chains grow.
CREATE INDEX IF NOT EXISTS idx_pools_chain_protocol ON pools(chain_id, protocol);
