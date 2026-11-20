-- Hour-level scan coverage, so longer determined windows can be composed
-- from self-built hourly aggregates without inventing missing hours.
-- Existing window_aggregates rows are recorded as already scanned.

BEGIN;

CREATE TABLE scanned_hours (
	chain_id INTEGER NOT NULL,
	protocol TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	window_end INTEGER NOT NULL,
	complete INTEGER NOT NULL,
	from_block TEXT NOT NULL,
	to_block TEXT NOT NULL,
	as_of TEXT NOT NULL,
	gap_reason TEXT,
	PRIMARY KEY (chain_id, protocol, window_start)
);

INSERT INTO scanned_hours (
	chain_id, protocol, window_start, window_end, complete, from_block, to_block, as_of, gap_reason
)
SELECT
	p.chain_id,
	p.protocol,
	w.window_start,
	w.window_end,
	MIN(w.complete),
	'0',
	'0',
	MAX(w.as_of),
	NULL
FROM window_aggregates w
JOIN pools p ON p.pool_id = w.pool_id
GROUP BY p.chain_id, p.protocol, w.window_start, w.window_end;

COMMIT;
