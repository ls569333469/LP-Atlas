CREATE TABLE evm_token_supply (
	chain TEXT NOT NULL,
	address TEXT NOT NULL,
	raw_supply TEXT,
	observed_at TEXT,
	retry_at TEXT NOT NULL,
	PRIMARY KEY (chain, address)
) WITHOUT ROWID;

CREATE TABLE evm_fdv_publication (
	chain TEXT PRIMARY KEY,
	as_of TEXT NOT NULL,
	candidates TEXT NOT NULL,
	valuations TEXT NOT NULL
) WITHOUT ROWID;
