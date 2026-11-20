-- Speed up expiry deletes on scanned_hours.window_start.
-- The primary key is (chain_id, protocol, window_start), which does not
-- help a global cutoff on window_start alone.
CREATE INDEX IF NOT EXISTS idx_scanned_hours_start ON scanned_hours(window_start);