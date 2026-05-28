-- T3.1 / FL.5b — per-variant CHILD link groups.
--
-- Adds a nullable variantId to FieldLinkGroup so a CHILD group can pin a
-- single variant's field across coordinates, distinct from the PARENT
-- (product-level) group. A fieldKey can now have one PARENT group
-- (variantId NULL) + many CHILD groups (one per variant), keyed by
-- (productId, fieldKey, variantId).
--
-- Pure additive: one nullable column + one index. No existing row
-- altered (all current rows keep variantId NULL = PARENT), no NOT NULL,
-- so it applies online with no backfill and is safe under migrate deploy.
--
-- Rollback:
--   DROP INDEX "FieldLinkGroup_productId_fieldKey_variantId_idx";
--   ALTER TABLE "FieldLinkGroup" DROP COLUMN "variantId";

ALTER TABLE "FieldLinkGroup" ADD COLUMN "variantId" TEXT;

CREATE INDEX "FieldLinkGroup_productId_fieldKey_variantId_idx"
  ON "FieldLinkGroup"("productId", "fieldKey", "variantId");
