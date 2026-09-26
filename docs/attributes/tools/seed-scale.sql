-- P0 scale fixture — clones ONE real family (GALE-JACKET: parent + 20 children, their translations, listings and
-- listing translations) :clones times. Every cloned row's id ends in `_p0_<k>` and every SKU in `-P0-<k>`, so the
-- cleanup below removes exactly what this added.
--
-- Run ONLY against a private copy whose name contains "test":
--   docker exec -i nexus-development-postgres-20260908 psql -U postgres -d nexus_attributes_test -v clones=476 < seed-scale.sql
-- 476 clones × 21 products = 9,996 products (+ the 355 already there).
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'refusing: % is not a test copy', current_database(); END IF;
END $$;

BEGIN;
CREATE TEMP TABLE p0_root AS SELECT id FROM "Product" WHERE sku = 'GALE-JACKET' AND "parentId" IS NULL;
CREATE TEMP TABLE p0_products AS SELECT p.* FROM "Product" p, p0_root r WHERE p.id = r.id OR p."parentId" = r.id;
CREATE TEMP TABLE p0_listings AS SELECT l.* FROM "ChannelListing" l JOIN p0_products p ON p.id = l."productId";

-- Parents first, then children: the business-profile reference guard is a BEFORE INSERT row trigger, so a child's
-- parent must already exist when the child row is checked.
INSERT INTO "Product"
SELECT (jsonb_populate_record(NULL::"Product", to_jsonb(p) || jsonb_build_object(
  'id', p.id || '_p0_' || k, 'sku', p.sku || '-P0-' || k))).*
FROM p0_products p CROSS JOIN generate_series(1, :clones) k WHERE p."parentId" IS NULL;
INSERT INTO "Product"
SELECT (jsonb_populate_record(NULL::"Product", to_jsonb(p) || jsonb_build_object(
  'id', p.id || '_p0_' || k, 'sku', p.sku || '-P0-' || k, 'parentId', p."parentId" || '_p0_' || k))).*
FROM p0_products p CROSS JOIN generate_series(1, :clones) k WHERE p."parentId" IS NOT NULL;

INSERT INTO "ProductTranslation"
SELECT (jsonb_populate_record(NULL::"ProductTranslation", to_jsonb(t) || jsonb_build_object(
  'id', t.id || '_p0_' || k, 'productId', t."productId" || '_p0_' || k))).*
FROM "ProductTranslation" t JOIN p0_products p ON p.id = t."productId" CROSS JOIN generate_series(1, :clones) k;

INSERT INTO "ChannelListing"
SELECT (jsonb_populate_record(NULL::"ChannelListing", to_jsonb(l) || jsonb_build_object(
  'id', l.id || '_p0_' || k, 'productId', l."productId" || '_p0_' || k))).*
FROM p0_listings l CROSS JOIN generate_series(1, :clones) k;

INSERT INTO "ChannelListingTranslation"
SELECT (jsonb_populate_record(NULL::"ChannelListingTranslation", to_jsonb(t) || jsonb_build_object(
  'id', t.id || '_p0_' || k, 'channelListingId', t."channelListingId" || '_p0_' || k))).*
FROM "ChannelListingTranslation" t JOIN p0_listings l ON l.id = t."channelListingId" CROSS JOIN generate_series(1, :clones) k;
COMMIT;

SELECT 'products' AS what, count(*) FROM "Product" WHERE sku LIKE '%-P0-%'
UNION ALL SELECT 'listings', count(*) FROM "ChannelListing" WHERE id LIKE '%\_p0\_%'
UNION ALL SELECT 'all products', count(*) FROM "Product";

-- Cleanup (run by hand):
-- DELETE FROM "ChannelListingTranslation" WHERE id LIKE '%\_p0\_%';
-- DELETE FROM "ChannelListing" WHERE id LIKE '%\_p0\_%';
-- DELETE FROM "ProductTranslation" WHERE id LIKE '%\_p0\_%';
-- DELETE FROM "Product" WHERE sku LIKE '%-P0-%' AND "parentId" IS NOT NULL;
-- DELETE FROM "Product" WHERE sku LIKE '%-P0-%';
