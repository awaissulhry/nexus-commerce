-- Phase 1 fix — the Brand Metrics grain includes the CATEGORY NODE.
--
-- The initial key (profileId, brandName, computationDate, lookbackPeriod) was
-- wrong. Verified live against the IT profile on 2026-07-29: Amazon returns the
-- same brand-week at SIX category-node depths — the root
-- "/Categorie/Moto, accessori e componenti" plus five sub-nodes — each carrying
-- its own category median and top-performer benchmark.
--
-- Measured impact of the wrong key: a 5-week IT report produced 28 records that
-- collapsed into 5 stored rows. 23 of 28 (~82%) were overwritten. Across all
-- four production profiles, 73 upserts became 20 rows.
--
-- categoryNodeName becomes NOT NULL DEFAULT '' rather than staying nullable
-- because Postgres treats NULLs as DISTINCT inside a unique index — a nullable
-- column in the key would silently re-admit the exact duplicates this migration
-- exists to prevent.
--
-- The DELETE below removes only the partial rows written by this morning's
-- verification run of the pipeline (the table was created earlier today and is
-- not yet read by any feature). They are re-fetched in full on the next cycle,
-- so this discards no user data and no data that cannot be re-derived.

DELETE FROM "AmazonAdsBrandBuildingMetric";

ALTER TABLE "AmazonAdsBrandBuildingMetric"
  ALTER COLUMN "categoryNodeName" SET DEFAULT '';

UPDATE "AmazonAdsBrandBuildingMetric"
  SET "categoryNodeName" = '' WHERE "categoryNodeName" IS NULL;

ALTER TABLE "AmazonAdsBrandBuildingMetric"
  ALTER COLUMN "categoryNodeName" SET NOT NULL;

DROP INDEX IF EXISTS "AmazonAdsBrandBuildingMetric_profile_brand_date_lookback_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AmazonAdsBrandBuildingMetric_profile_brand_date_lookback_cat_key"
  ON "AmazonAdsBrandBuildingMetric" ("profileId", "brandName", "computationDate", "lookbackPeriod", "categoryNodeName");
