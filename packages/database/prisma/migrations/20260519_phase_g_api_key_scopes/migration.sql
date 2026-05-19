-- Phase G — ApiKey upgrade.
--
-- Five new columns, all nullable / defaulted so existing rows keep
-- working without a backfill. The verifier in
-- apps/api/src/lib/api-key-auth.ts treats:
--   scopes=[]     → full access (legacy behaviour)
--   ipAllowlist=[] → any IP (legacy behaviour)
--   expiresAt=NULL → never expires (legacy behaviour)
--   rotatedAt=NULL → not rotated
-- so the change is back-compat.

ALTER TABLE "ApiKey"
  ADD COLUMN "scopes"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ipAllowlist"        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "expiresAt"          TIMESTAMP(3),
  ADD COLUMN "rotatedAt"          TIMESTAMP(3),
  ADD COLUMN "rotatedToId"        TEXT,
  ADD COLUMN "rotationGraceUntil" TIMESTAMP(3);

-- Index on expiresAt so the eventual expiry-sweep cron can find
-- candidates cheaply; index on rotatedToId so the verifier can
-- jump from old key → replacement in one hop when surfacing the
-- "your key was rotated, use this new prefix" hint.
CREATE INDEX "ApiKey_expiresAt_idx" ON "ApiKey"("expiresAt");
CREATE INDEX "ApiKey_rotatedToId_idx" ON "ApiKey"("rotatedToId");
