-- FN.9.3 — drop the dead ProductVariation.fnsku column.
--
-- Background: migration 20260515_fnsku_label_templates added
-- "fnsku" to ProductVariation alongside creating FnskuLabelTemplate. But
-- ProductVariation is a deprecated table — variants live as child rows in
-- the Product table (parentId IS NOT NULL) per the comment in
-- products.routes.ts:4110-4111. The actual FNSKU cache is at
-- Product.fnsku (see fnsku-lookup.service.ts). The ProductVariation.fnsku
-- column has never been read by any code.
--
-- Dropping it now closes a tech-debt loose end. The table itself stays
-- (other models still reference it via foreign keys for backward compat).
-- Safe: no application reads or writes this column.

ALTER TABLE "ProductVariation" DROP COLUMN IF EXISTS "fnsku";
