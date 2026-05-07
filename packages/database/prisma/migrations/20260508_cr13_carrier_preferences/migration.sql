-- CR.13 — operator-tunable preferences per carrier.
--
-- One JSONB column rather than per-feature columns so future toggles
-- (rate-shop opt-out, prefer-fastest, label-format default, signature
-- default, etc.) land without schema migrations. Schema migrations
-- on a hot table are expensive on Neon; JSONB churn is free.
--
-- Documented keys (all optional):
--   includeInRateShop      boolean  — false = skip in /shipments/:id/rates
--   preferCheapest         boolean  — pick cheapest auto-rate (default)
--   preferFastest          boolean  — pick fastest auto-rate; overrides preferCheapest
--   defaultLabelFormat     string   — "label_printer" | "normal_printer" (Sendcloud)
--   requireSignature       boolean  — default-on signature for this carrier
--
-- Reader: services/sendcloud/index.ts + the rate-shop endpoint will
-- consult these in CR.13's wire-up and later commits as toggles ship.

ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "preferences" JSONB;
