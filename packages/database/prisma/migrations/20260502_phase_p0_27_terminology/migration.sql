-- P0 #27: TerminologyPreference — per-brand / per-marketplace AI
-- title-generation glossary. Idempotent CREATE TABLE so re-runs are
-- safe; seed inserts use ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS "TerminologyPreference" (
  "id"          TEXT PRIMARY KEY,
  "brand"       TEXT,
  "marketplace" TEXT NOT NULL,
  "language"    TEXT NOT NULL,
  "preferred"   TEXT NOT NULL,
  "avoid"       TEXT[] NOT NULL DEFAULT '{}',
  "context"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "TerminologyPreference_brand_marketplace_idx"
  ON "TerminologyPreference" ("brand", "marketplace");

CREATE INDEX IF NOT EXISTS "TerminologyPreference_marketplace_idx"
  ON "TerminologyPreference" ("marketplace");

-- Seed: Xavia Italian motorcycle-gear glossary. The user explicitly
-- approved Giacca/Giubbotto on 2026-05-03 and asked the assistant to
-- "do its best" for the rest. Each entry's `context` documents the
-- reasoning so a human can audit + refine via /settings/terminology.
INSERT INTO "TerminologyPreference"
  ("id", "brand", "marketplace", "language", "preferred", "avoid", "context", "createdAt", "updatedAt")
VALUES
  ('seed_xavia_giacca',
   'Xavia Racing', 'IT', 'it',
   'Giacca',
   ARRAY['Giubbotto','Bomber'],
   'motorcycle jacket — user-confirmed; Giubbotto implies padded/winter, Bomber is a specific style',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_pantaloni',
   'Xavia Racing', 'IT', 'it',
   'Pantaloni',
   ARRAY['Brache'],
   'motorcycle pants — Brache is dated/regional; Pantaloni is the standard modern term',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_casco',
   'Xavia Racing', 'IT', 'it',
   'Casco',
   ARRAY['Elmetto'],
   'motorcycle helmet — Elmetto means military/construction helmet, wrong register',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_stivali',
   'Xavia Racing', 'IT', 'it',
   'Stivali',
   ARRAY['Scarpe','Scarponi'],
   'motorcycle boots — Scarpe = shoes (wrong category), Scarponi = hiking boots',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_protezioni',
   'Xavia Racing', 'IT', 'it',
   'Protezioni',
   ARRAY['Armatura'],
   'body armour / impact protection — Armatura sounds medieval, Protezioni is the gear-industry term',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_pelle',
   'Xavia Racing', 'IT', 'it',
   'Pelle',
   ARRAY['Cuoio'],
   'leather garment material — Cuoio reads as tanned hide / saddlery, Pelle is the garment-leather word',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_xavia_rete',
   'Xavia Racing', 'IT', 'it',
   'Rete',
   ARRAY['Maglia'],
   'mesh / breathable fabric — Maglia means knit (wrong for AIR-MESH style); Rete = mesh',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
