-- W2.3 — FamilyAttribute join (Akeneo-flat shape, user-confirmed).
--
-- Declares which CustomAttribute belongs to a ProductFamily plus
-- required-vs-optional + per-channel scoping. Semantics:
--   required=false              → optional everywhere
--   required=true, channels=[]  → required on every channel
--   required=true, channels=[X] → required only on listed channels
--
-- Inheritance is Akeneo-strict additive (user-confirmed): child
-- family inherits ALL parent rows; can ADD more but never remove or
-- downgrade. Resolved at read time by the FamilyHierarchy service
-- (W2.4).
--
-- CASCADE on both family + attribute deletes: a row only makes sense
-- in the context of its family AND its attribute, so deleting either
-- end orphans the row. Safe because FamilyAttribute carries no
-- product-side data; it's pure metadata.
--
-- Idempotent: IF NOT EXISTS on table + indexes; pg_constraint guards
-- on FK creation.

CREATE TABLE IF NOT EXISTS "FamilyAttribute" (
  "id"          TEXT NOT NULL,
  "familyId"    TEXT NOT NULL,
  "attributeId" TEXT NOT NULL,
  "required"    BOOLEAN NOT NULL DEFAULT FALSE,
  "channels"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "FamilyAttribute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FamilyAttribute_familyId_attributeId_key"
  ON "FamilyAttribute"("familyId", "attributeId");

CREATE INDEX IF NOT EXISTS "FamilyAttribute_familyId_idx"
  ON "FamilyAttribute"("familyId");

CREATE INDEX IF NOT EXISTS "FamilyAttribute_attributeId_idx"
  ON "FamilyAttribute"("attributeId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FamilyAttribute_familyId_fkey'
  ) THEN
    ALTER TABLE "FamilyAttribute"
      ADD CONSTRAINT "FamilyAttribute_familyId_fkey"
      FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FamilyAttribute_attributeId_fkey'
  ) THEN
    ALTER TABLE "FamilyAttribute"
      ADD CONSTRAINT "FamilyAttribute_attributeId_fkey"
      FOREIGN KEY ("attributeId") REFERENCES "CustomAttribute"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
