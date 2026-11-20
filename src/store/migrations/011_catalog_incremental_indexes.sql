-- The chain-only index also orders rowids, so warm catalog reads seek past the watermark.
CREATE INDEX IF NOT EXISTS idx_pools_chain ON pools(chain_id);
-- Reuse exact creation timestamps without scanning the full chain catalog.
CREATE INDEX IF NOT EXISTS idx_pools_chain_created_time ON pools(chain_id, created_block, created_at_unix);
