-- P0 #27 follow-up: flip the seeded Italian terminology preferences
-- from brand='Xavia Racing' to brand=NULL so they apply to every
-- product in the IT marketplace.
--
-- Why: real Xavia products in the catalog have brand=NULL because
-- they were imported from Amazon SP-API without a brand attribute
-- populated. The brand-scoped seeds therefore never matched at
-- generation time, and the AI prompt got no terminology block.
-- For a single-seller platform, brand=NULL defaults are the right
-- semantic anyway.
--
-- Idempotent: running the UPDATE twice is a no-op.
UPDATE "TerminologyPreference"
SET "brand" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
  'seed_xavia_giacca',
  'seed_xavia_pantaloni',
  'seed_xavia_casco',
  'seed_xavia_stivali',
  'seed_xavia_protezioni',
  'seed_xavia_pelle',
  'seed_xavia_rete'
);
