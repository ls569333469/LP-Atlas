ALTER TABLE window_aggregates ADD COLUMN fee_status TEXT NOT NULL DEFAULT 'legacy_unverified';

UPDATE window_aggregates SET fee_status = 'estimated'
WHERE pool_id IN (SELECT pool_id FROM pools WHERE protocol = 'uniswap_v3');

-- Zero LP fee tiers without hooks are unaffected by the V4 input-side correction.
UPDATE window_aggregates SET fee_status = 'verified_zero'
WHERE lp_fees0 = '0' AND lp_fees1 = '0'
AND pool_id IN (
  SELECT pool_id FROM pools WHERE protocol = 'uniswap_v4' AND fee_pips = 0
  AND (hooks IS NULL OR lower(hooks) = '0x0000000000000000000000000000000000000000')
);
