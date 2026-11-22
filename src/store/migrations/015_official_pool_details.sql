ALTER TABLE pools ADD COLUMN official_metadata TEXT;
ALTER TABLE pools ADD COLUMN official_metadata_as_of TEXT;
ALTER TABLE window_aggregates ADD COLUMN reported_fees_usd TEXT;
ALTER TABLE window_aggregates ADD COLUMN reported_protocol_fees_usd TEXT;

ALTER TABLE chain_publications ADD COLUMN official_discovery_as_of TEXT;
