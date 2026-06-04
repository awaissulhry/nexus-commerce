-- Root-cause fix for a silently-failing schema sync.
--
-- The CE.1 migration (20260516_ce1_feed_transform) created the ChannelSchema
-- unique as an EXPRESSION index on (channel, COALESCE(marketplace,''),
-- fieldKey). Postgres will not use an expression index as the arbiter for
-- Prisma's `upsert … ON CONFLICT (channel, marketplace, fieldKey)`, so every
-- syncSchemaToChannelSchema upsert failed with 42P10 ("there is no unique or
-- exclusion constraint matching the ON CONFLICT specification"). The result:
-- ChannelSchema stayed EMPTY on prod, the field catalog never seeded, and the
-- whole field-mapping engine (console, matrix, rule editor) had nothing to map.
--
-- Replace it with the plain unique index that schema.prisma already declares
-- via @@unique([channel, marketplace, fieldKey]) — which IS a valid ON CONFLICT
-- arbiter, so the upsert (and every schema sync) works. Safe: ChannelSchema is
-- empty (no upsert ever succeeded), so there are no duplicate rows to block the
-- new index.

DROP INDEX IF EXISTS "ChannelSchema_channel_marketplace_fieldKey_key";

CREATE UNIQUE INDEX "ChannelSchema_channel_marketplace_fieldKey_key"
  ON "ChannelSchema"("channel", "marketplace", "fieldKey");
