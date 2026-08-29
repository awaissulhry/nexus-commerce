-- CX.1 — connection core (docs/2026-08-29-cx1-connection-core.md §1).
--
-- ADDITIVE ONLY. No column is dropped, no unique key changes; MAP's
-- ChannelConnection_active_account_key and _channelType_primary_key are untouched.
-- Every statement is idempotent (IF [NOT] EXISTS) so a half-applied run can be
-- re-run (reference_prisma_migration_p3009_blocks_deploys).
--
-- Credentials are NOT moved here: the envelope needs KMS, so the one-shot job
-- `cx1-credentials-backfill` encrypts each row and nulls the plaintext columns in
-- the same UPDATE, after a verified round-trip. Everything SQL can derive safely
-- (authStatus, identity, refreshTokenExpiresAt, ConnectionScope rows) is derived
-- below, with a gate that RAISEs if an active row ends up with no scope.

-- ── §1.1 ChannelConnection columns ─────────────────────────────────────────────
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "authStatus"            TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "region"                TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "credentialsEnc"        TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "credentialsKeyId"      TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "grantedScopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt"  TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastRefreshAt"         TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastHeartbeatAt"       TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastInboundAt"         TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastOutboundAt"        TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastErrorAt"           TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "lastError"             TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "consecutiveFailures"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "refreshLeaseUntil"     TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "refreshLeaseOwner"     TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "identity"              JSONB;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "apiVersion"            TEXT;

CREATE INDEX IF NOT EXISTS "ChannelConnection_authStatus_idx"            ON "ChannelConnection"("authStatus");
CREATE INDEX IF NOT EXISTS "ChannelConnection_accessTokenExpiresAt_idx"  ON "ChannelConnection"("accessTokenExpiresAt");
CREATE INDEX IF NOT EXISTS "ChannelConnection_refreshTokenExpiresAt_idx" ON "ChannelConnection"("refreshTokenExpiresAt");

-- ── §1.2 new tables ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ConnectionScope" (
  "id"           TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "externalId"   TEXT NOT NULL,
  "label"        TEXT,
  "region"       TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "metadata"     JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectionScope_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectionScope_connectionId_kind_externalId_key" ON "ConnectionScope"("connectionId", "kind", "externalId");
CREATE INDEX IF NOT EXISTS "ConnectionScope_kind_externalId_idx" ON "ConnectionScope"("kind", "externalId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConnectionScope_connectionId_fkey') THEN
    ALTER TABLE "ConnectionScope" ADD CONSTRAINT "ConnectionScope_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ChannelApp" (
  "id"              TEXT NOT NULL,
  "channelKey"      TEXT NOT NULL,
  "environment"     TEXT NOT NULL DEFAULT 'production',
  "clientId"        TEXT NOT NULL,
  "clientSecretEnc" TEXT,
  "redirectUris"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "extra"           JSONB,
  "signingKeyEnc"   TEXT,
  "signingKeyId"    TEXT,
  "secretExpiresAt" TIMESTAMP(3),
  "rotatedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelApp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelApp_channelKey_environment_key" ON "ChannelApp"("channelKey", "environment");

CREATE TABLE IF NOT EXISTS "OAuthSession" (
  "id"                 TEXT NOT NULL,
  "channelKey"         TEXT NOT NULL,
  "intent"             TEXT NOT NULL,
  "targetConnectionId" TEXT,
  "startedByUserId"    TEXT,
  "codeVerifier"       TEXT,
  "redirectUri"        TEXT NOT NULL,
  "cookieNonce"        TEXT NOT NULL,
  "region"             TEXT,
  "expiresAt"          TIMESTAMP(3) NOT NULL,
  "consumedAt"         TIMESTAMP(3),
  "resultConnectionId" TEXT,
  "error"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OAuthSession_expiresAt_idx" ON "OAuthSession"("expiresAt");

CREATE TABLE IF NOT EXISTS "ConnectionEvent" (
  "id"           TEXT NOT NULL,
  "connectionId" TEXT,
  "channelKey"   TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "actorUserId"  TEXT,
  "detail"       JSONB,
  "archivedRef"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ConnectionEvent_connectionId_createdAt_idx" ON "ConnectionEvent"("connectionId", "createdAt");
CREATE INDEX IF NOT EXISTS "ConnectionEvent_type_createdAt_idx"         ON "ConnectionEvent"("type", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConnectionEvent_connectionId_fkey') THEN
    ALTER TABLE "ConnectionEvent" ADD CONSTRAINT "ConnectionEvent_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── §1.3 derived backfill (idempotent: only touches rows still at defaults) ───
-- authStatus from what the row already says.
UPDATE "ChannelConnection"
SET "authStatus" = CASE
  WHEN "isActive" = false THEN 'disconnected'
  WHEN "managedBy" = 'env' THEN 'unknown'            -- the heartbeat decides within 15 min
  WHEN COALESCE("accessToken", "ebayAccessToken") IS NOT NULL
    OR "credentialsEnc" IS NOT NULL THEN 'connected'
  ELSE 'unknown' END
WHERE "authStatus" = 'unknown';

-- eBay refresh tokens live 47,304,000 s (~547 d) from consent; the grant cannot be
-- older than the row, so createdAt + 547 d is a conservative floor until re-consent.
UPDATE "ChannelConnection"
SET "refreshTokenExpiresAt" = "createdAt" + INTERVAL '547 days'
WHERE "channelType" = 'EBAY' AND "managedBy" = 'oauth' AND "isActive" = true
  AND "refreshTokenExpiresAt" IS NULL;

-- accessTokenExpiresAt mirrors the legacy expiry so the cron can query cheaply.
UPDATE "ChannelConnection"
SET "accessTokenExpiresAt" = COALESCE("tokenExpiresAt", "ebayTokenExpiresAt")
WHERE "accessTokenExpiresAt" IS NULL AND COALESCE("tokenExpiresAt", "ebayTokenExpiresAt") IS NOT NULL;

-- identity from the legacy eBay display columns / Amazon merchant id.
UPDATE "ChannelConnection"
SET "identity" = jsonb_strip_nulls(jsonb_build_object(
  'userId',    "externalAccountId",
  'username',  COALESCE("displayName", "ebaySignInName"),
  'storeName', "ebayStoreName",
  'storeUrl',  "ebayStoreFrontUrl"
))
WHERE "identity" IS NULL
  AND ("externalAccountId" IS NOT NULL OR "displayName" IS NOT NULL OR "ebaySignInName" IS NOT NULL);

UPDATE "ChannelConnection" SET "region" = 'GLOBAL' WHERE "channelType" = 'EBAY' AND "region" IS NULL;
UPDATE "ChannelConnection" SET "region" = 'EU'     WHERE "channelType" = 'AMAZON' AND "region" IS NULL;

-- ConnectionScope: eBay = its activeMarketplaces, or ONE honest "GLOBAL" scope when
-- nothing configured them (an eBay grant reaches every site; the five EU codes
-- would be an assumption — reference_fleet_stale_constant_class);
-- Amazon env row = every participating Marketplace row.
INSERT INTO "ConnectionScope" ("id", "connectionId", "kind", "externalId", "label", "region", "isActive", "createdAt", "updatedAt")
SELECT md5(c."id" || ':marketplace:' || m.code), c."id", 'marketplace', m.code,
       CASE WHEN m.code = 'GLOBAL' THEN 'All eBay sites' ELSE m.code END, 'GLOBAL', true, now(), now()
FROM "ChannelConnection" c
CROSS JOIN LATERAL (
  SELECT code, code AS label FROM (
    SELECT jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(c."connectionMetadata"->'activeMarketplaces') = 'array'
             AND jsonb_array_length(c."connectionMetadata"->'activeMarketplaces') > 0
           THEN c."connectionMetadata"->'activeMarketplaces'
           ELSE '["GLOBAL"]'::jsonb END) AS code
  ) s
) m
WHERE c."channelType" = 'EBAY' AND c."isActive" = true
ON CONFLICT ("connectionId", "kind", "externalId") DO NOTHING;

INSERT INTO "ConnectionScope" ("id", "connectionId", "kind", "externalId", "label", "region", "isActive", "metadata", "createdAt", "updatedAt")
SELECT md5(c."id" || ':marketplace:' || mp."code"), c."id", 'marketplace', mp."code", mp."name", mp."region",
       COALESCE(mp."isParticipating", false),
       jsonb_build_object('marketplaceId', mp."marketplaceId", 'participationStatus', mp."participationStatus"),
       now(), now()
FROM "ChannelConnection" c
JOIN "Marketplace" mp ON mp."channel" = 'AMAZON' AND mp."marketplaceId" IS NOT NULL
WHERE c."channelType" = 'AMAZON' AND c."isActive" = true
ON CONFLICT ("connectionId", "kind", "externalId") DO NOTHING;

-- Gate: every active oauth/env connection must now own at least one scope.
DO $$
DECLARE missing INTEGER;
BEGIN
  SELECT count(*) INTO missing
  FROM "ChannelConnection" c
  WHERE c."isActive" = true AND c."managedBy" IN ('oauth', 'env')
    AND c."channelType" IN ('EBAY', 'AMAZON')
    AND NOT EXISTS (SELECT 1 FROM "ConnectionScope" s WHERE s."connectionId" = c."id");
  IF missing > 0 THEN
    RAISE EXCEPTION 'CX.1 backfill gate: % active connection(s) have no ConnectionScope — refusing', missing;
  END IF;
END $$;
