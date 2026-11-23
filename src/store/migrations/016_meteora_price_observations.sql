CREATE TABLE meteora_price_observations (
	pool_id TEXT NOT NULL REFERENCES pools(pool_id),
	observed_at_ms INTEGER NOT NULL,
	token_x TEXT NOT NULL,
	token_y TEXT NOT NULL,
	price_y_per_x TEXT,
	PRIMARY KEY (observed_at_ms, pool_id)
) WITHOUT ROWID;
