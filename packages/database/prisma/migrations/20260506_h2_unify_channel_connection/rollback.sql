-- =====================================================================
-- ROLLBACK for 20260506_h2_unify_channel_connection
--
-- Use only if Commit 3a fails post-migration verification and we need
-- to undo before deploying Commit 3b. Order is reverse of forward.
--
-- All operations are reversible without data loss because:
--   - MarketplaceCredential was empty when dropped (audited 2026-05-06).
--   - Channel.credentials was empty when dropped (Channel table has
--     0 rows; audited 2026-05-06).
--   - Generic columns on ChannelConnection are pure additions; legacy
--     ebay* columns still hold the canonical data.
-- =====================================================================

BEGIN;

-- 1. Drop the partial unique index (must drop BEFORE re-adding any
--    NOT NULL columns that might be re-evaluated).
DROP INDEX IF EXISTS "ChannelConnection_channelType_marketplace_active_key";
DROP INDEX IF EXISTS "ChannelConnection_managedBy_idx";

-- 2. Drop the generic columns. Legacy ebay* columns remain untouched,
--    so eBay-specific service code keeps working end-to-end.
ALTER TABLE "ChannelConnection"
  DROP COLUMN IF EXISTS "displayName",
  DROP COLUMN IF EXISTS "tokenExpiresAt",
  DROP COLUMN IF EXISTS "refreshToken",
  DROP COLUMN IF EXISTS "accessToken",
  DROP COLUMN IF EXISTS "managedBy",
  DROP COLUMN IF EXISTS "marketplace";

-- 3. Restore Channel.credentials. Original was TEXT NOT NULL with no
--    default; that fails on existing rows, but Channel is empty.
--    Add as nullable first to avoid lock-vs-default games, then set
--    NOT NULL.
ALTER TABLE "Channel" ADD COLUMN "credentials" TEXT;
UPDATE "Channel" SET "credentials" = '' WHERE "credentials" IS NULL;
ALTER TABLE "Channel" ALTER COLUMN "credentials" SET NOT NULL;

-- 4. Restore MarketplaceCredential.
CREATE TABLE "MarketplaceCredential" (
  "id"             TEXT PRIMARY KEY,
  "channel"        TEXT NOT NULL,
  "credentialType" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3),
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MarketplaceCredential_channel_credentialType_key"
  ON "MarketplaceCredential" ("channel", "credentialType");
CREATE INDEX "MarketplaceCredential_channel_idx"
  ON "MarketplaceCredential" ("channel");

COMMIT;
