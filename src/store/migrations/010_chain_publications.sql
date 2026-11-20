BEGIN;

CREATE TABLE chain_publications (
    chain TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    block_number TEXT NOT NULL,
    block_time TEXT NOT NULL,
    published_at TEXT NOT NULL
);

INSERT INTO chain_publications (chain, revision, run_id, block_number, block_time, published_at)
SELECT COALESCE(scope_chain, 'elysium'), 0, id, COALESCE(block_number, '0'), block_time,
    COALESCE(finished_at, started_at)
FROM refresh_runs r
WHERE id = (SELECT MAX(id) FROM refresh_runs latest
    WHERE COALESCE(latest.scope_chain, 'elysium') = COALESCE(r.scope_chain, 'elysium')
    AND latest.status IN ('ok', 'partial') AND COALESCE(latest.windows_built, 0) > 0
    AND latest.block_time IS NOT NULL);

COMMIT;
