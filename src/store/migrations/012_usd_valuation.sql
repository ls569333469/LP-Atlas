ALTER TABLE scanned_hours ADD COLUMN usd_valuation_version INTEGER;
ALTER TABLE scanned_hours ADD COLUMN usd_quote_json TEXT;
ALTER TABLE window_aggregates ADD COLUMN usd_valuation_version INTEGER;
