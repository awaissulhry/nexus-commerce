-- W2.1 — ProductFamily (Akeneo cornerstone PIM template).
--
-- A Family is the template for a product type that declares which
-- attribute groups + attributes apply. Each Product *optionally*
-- belongs to one Family. Until a Product has a Family, the loose
-- categoryAttributes JSON path is used (legacy / catch-all).
--
-- Hierarchy: a Family can have a parent with attribute inheritance.
-- ON DELETE SET NULL on parent so a deleted parent leaves children
-- as top-level families rather than cascade-deleting them.
--
-- Wave 2 follow-up:
--   W2.2: FamilyAttribute join + required/optional + per-channel
--   W2.3: AttributeSet / AttributeGroup / CustomAttribute
--   W2.4+: services, family-attach UI, completeness recompute
--
-- Migration is idempotent (IF NOT EXISTS on table + columns +
-- indexes + FK constraints) so it's safe to re-run.

CREATE TABLE IF NOT EXISTS "ProductFamily" (
  "id"             TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "description"    TEXT,
  "parentFamilyId" TEXT,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP NOT NULL,

  CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductFamily_code_key"
  ON "ProductFamily"("code");

CREATE INDEX IF NOT EXISTS "ProductFamily_parentFamilyId_idx"
  ON "ProductFamily"("parentFamilyId");

-- Self-FK for hierarchy. SET NULL on delete preserves children as
-- top-level families.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProductFamily_parentFamilyId_fkey'
  ) THEN
    ALTER TABLE "ProductFamily"
      ADD CONSTRAINT "ProductFamily_parentFamilyId_fkey"
      FOREIGN KEY ("parentFamilyId") REFERENCES "ProductFamily"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Add Product.familyId FK (nullable; existing rows stay NULL).
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "familyId" TEXT;

CREATE INDEX IF NOT EXISTS "Product_familyId_idx"
  ON "Product"("familyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Product_familyId_fkey'
  ) THEN
    ALTER TABLE "Product"
      ADD CONSTRAINT "Product_familyId_fkey"
      FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
