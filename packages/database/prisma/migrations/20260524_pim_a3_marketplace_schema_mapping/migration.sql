-- PIM A.3 — Marketplace schema mapping foundation.
--
-- Adds a JSONB column on Marketplace to hold the field-mapping
-- definition (how internal PIM data flows into the marketplace's
-- external API payload). This is the Phase D drag-drop mapping
-- canvas substrate — no callers yet, populated by operators or by
-- the Phase D.1 live-schema fetcher.
--
-- Shape (validated by schema-mapping.service.ts):
--   {
--     "version": 1,
--     "fields": {
--       "title": { "source": "localizedContent.{locale}.title",
--                  "fallback": "name",
--                  "transforms": [{ "type": "truncate", "max": 200 }],
--                  "required": true },
--       ...
--     },
--     "lastSyncedAt": null,
--     "schemaSnapshotVersion": null
--   }
--
-- Rollback:
--   DROP INDEX "Marketplace_schemaMapping_gin_idx";
--   ALTER TABLE "Marketplace" DROP COLUMN "schemaMapping";

ALTER TABLE "Marketplace"
  ADD COLUMN "schemaMapping" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- jsonb_path_ops keeps the index small + makes @> containment queries
-- fast (e.g. "find marketplaces whose mapping references field X").
CREATE INDEX "Marketplace_schemaMapping_gin_idx"
  ON "Marketplace" USING GIN ("schemaMapping" jsonb_path_ops);
