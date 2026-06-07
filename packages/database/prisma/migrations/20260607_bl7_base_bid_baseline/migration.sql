-- BL.7 — base-bid deltaPct baseline memory. The STABLE pre-mod bid per entity so a
-- repeated ±% delta is computed from the baseline (never compounds) and is reverted
-- verbatim when the directive clears. Additive + nullable → no behaviour change until used.
ALTER TABLE "AdGroup" ADD COLUMN IF NOT EXISTS "baseBidFromCents" INTEGER;
ALTER TABLE "AdTarget" ADD COLUMN IF NOT EXISTS "baseBidFromCents" INTEGER;
