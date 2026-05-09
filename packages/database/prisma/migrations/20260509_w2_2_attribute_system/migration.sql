-- W2.2 — Custom attribute system foundation (Magento EAV + Akeneo
-- groups + Akeneo type system).
--
-- Three tables introduced together because they're a single concept:
--   AttributeGroup    : organisational bucket ('Sizing', 'Safety')
--   CustomAttribute   : the typed field itself
--   AttributeOption   : choice list for select / multiselect types
--
-- Wave 2 follow-up:
--   W2.3: FamilyAttribute (joins ProductFamily ↔ CustomAttribute
--         with required/optional + per-channel rules)
--   W2.x: reference-entity tables (currently embedded in
--         AttributeOption.metadata for swatches/materials)
--
-- Idempotent: every CREATE uses IF NOT EXISTS; FK creates are
-- guarded by pg_constraint lookups so re-runs are no-ops.

-- ── AttributeGroup ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AttributeGroup" (
  "id"          TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "AttributeGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttributeGroup_code_key"
  ON "AttributeGroup"("code");

-- ── CustomAttribute ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CustomAttribute" (
  "id"           TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "description"  TEXT,
  "groupId"      TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "validation"   JSONB,
  "defaultValue" JSONB,
  "localizable"  BOOLEAN NOT NULL DEFAULT FALSE,
  "scope"        TEXT NOT NULL DEFAULT 'global',
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP NOT NULL,

  CONSTRAINT "CustomAttribute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomAttribute_code_key"
  ON "CustomAttribute"("code");

CREATE INDEX IF NOT EXISTS "CustomAttribute_groupId_idx"
  ON "CustomAttribute"("groupId");

-- RESTRICT on delete: refuse to drop a group that still has
-- attributes attached. Operator must move/delete the attributes
-- first — protects against silent data loss when groups are reorged.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomAttribute_groupId_fkey'
  ) THEN
    ALTER TABLE "CustomAttribute"
      ADD CONSTRAINT "CustomAttribute_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "AttributeGroup"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── AttributeOption ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AttributeOption" (
  "id"          TEXT NOT NULL,
  "attributeId" TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "metadata"    JSONB,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "AttributeOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttributeOption_attributeId_code_key"
  ON "AttributeOption"("attributeId", "code");

CREATE INDEX IF NOT EXISTS "AttributeOption_attributeId_idx"
  ON "AttributeOption"("attributeId");

-- CASCADE on attribute delete: an option only makes sense in the
-- context of its attribute, so deleting the attribute drops its
-- options.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AttributeOption_attributeId_fkey'
  ) THEN
    ALTER TABLE "AttributeOption"
      ADD CONSTRAINT "AttributeOption_attributeId_fkey"
      FOREIGN KEY ("attributeId") REFERENCES "CustomAttribute"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
