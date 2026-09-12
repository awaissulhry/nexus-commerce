BEGIN;
-- Additive identity change; no Product or ChannelListing values are changed.
-- Run the companion impact preview before deploying this migration. Legacy
-- channel formulas belonged to the then-primary account. Bind that effective
-- destination once, so a future primary-account change cannot move them.
ALTER TABLE "CellFormula" ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CellFormula" ADD COLUMN IF NOT EXISTS "aliasKey" TEXT NOT NULL DEFAULT '';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "CellFormula" f WHERE f.scope = 'channel' AND f."channelConnectionId" = ''
    AND 1 <> (
      SELECT count(*) FROM "ChannelConnection" c WHERE c."workspaceId" = f."workspaceId"
      AND c."channelType" = f.channel AND c."isActive" = true
      AND (c."isPrimary" = true OR (SELECT count(*) FROM "ChannelConnection" a
        WHERE a."workspaceId" = f."workspaceId" AND a."channelType" = f.channel AND a."isActive" = true) = 1)
    )
  ) THEN RAISE EXCEPTION 'Information formula migration requires an unambiguous active account for every legacy channel formula. Review the impact preview.'; END IF;
END $$;

UPDATE "CellFormula" f SET "channelConnectionId" = c.id
FROM "ChannelConnection" c WHERE f.scope = 'channel' AND f."channelConnectionId" = ''
AND c."workspaceId" = f."workspaceId" AND c."channelType" = f.channel AND c."isActive" = true
AND (c."isPrimary" = true OR (SELECT count(*) FROM "ChannelConnection" a
  WHERE a."workspaceId" = f."workspaceId" AND a."channelType" = f.channel AND a."isActive" = true) = 1);

DROP INDEX IF EXISTS "CellFormula_productId_scope_channel_marketplace_local_81ce279a6";
CREATE UNIQUE INDEX "CellFormula_productId_scope_channel_marketplace_local_81ce279a6"
ON "CellFormula" ("workspaceId", "productId", scope, channel, marketplace, locale, "channelConnectionId", "aliasKey", "fieldKey");

COMMIT;
