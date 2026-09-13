-- PR.5 Presence: additive only, no data backfill. Wave 5 schema is separate.
-- Stage outside prisma/migrations until BOTH databases have been applied and verified.
-- Apply this file alone: never migrate deploy (which drags other pending folders).
-- Prod requires the Owner's verbatim approval and a DIRECT Neon URL (strip -pooler).
-- Replay-safe after a direct apply; do not mark applied until verification succeeds.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pr_presence$
BEGIN
  -- Same key as Prisma migrate; no stale backend is killed to acquire it.
  IF NOT pg_try_advisory_xact_lock(72707369) THEN
    RAISE EXCEPTION 'PR presence migration lock is held; retry after the owner releases it';
  END IF;
  -- Never silently ship a grant-less table or weaken the workspace policy.
  IF to_regclass('public."Workspace"') IS NULL
     OR to_regclass('public."WorkspaceMembership"') IS NULL
     OR to_regclass('public."UserProfile"') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
    RAISE EXCEPTION 'PR presence requires the existing workspace-isolation tables and runtime role; apply that separately approved prerequisite first';
  END IF;
END;
$pr_presence$;

-- Nullable and defaultless: null means never stated/UNKNOWN. No derivation is persisted.
ALTER TABLE "ChannelListing"
  ADD COLUMN IF NOT EXISTS "presenceIntent" TEXT,
  ADD COLUMN IF NOT EXISTS "presenceIntentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "presenceIntentBy" TEXT,
  ADD COLUMN IF NOT EXISTS "presenceIntentReason" TEXT,
  ADD COLUMN IF NOT EXISTS "presenceEffectiveFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "presenceUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "channelFact" TEXT,
  ADD COLUMN IF NOT EXISTS "channelFactAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "channelFactVia" TEXT,
  ADD COLUMN IF NOT EXISTS "channelFactDetail" JSONB,
  ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "endedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "saleStopId" TEXT;

-- Registry and tombstone. All identity references are plain strings; no FK may
-- erase the retained external identity/snapshot when its product is purged.
CREATE TABLE IF NOT EXISTS "ListingIdentity" (
  "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "channelConnectionId" TEXT,
  "aliasKey" TEXT NOT NULL DEFAULT '',
  "externalListingId" TEXT NOT NULL,
  "externalParentId" TEXT,
  "fulfillmentMethod" TEXT,
  "offerSku" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMP(3),
  "retiredReason" TEXT,
  "retiredBy" TEXT,
  "doNotRecreate" BOOLEAN NOT NULL DEFAULT false,
  "lastSnapshotId" TEXT,
  "retiredSnapshot" JSONB,
  "supersededByExternalListingId" TEXT,
  CONSTRAINT "ListingIdentity_pkey" PRIMARY KEY ("id")
);

-- Exact unique tuple from the spine. Alias primary key is '', not a null sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS "ListingIdentity_coordinate_external_key"
  ON "ListingIdentity" ("workspaceId", "channel", "marketplace", "channelConnectionId", "aliasKey", "externalListingId");
-- PR.1 product roll-up + coordinate history; the unique index above supplies the
-- workspace/channel/market/account/alias prefix for recreation checks.
CREATE INDEX IF NOT EXISTS "ListingIdentity_product_coordinate_idx"
  ON "ListingIdentity" ("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey");

ALTER TABLE "ListingIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ListingIdentity" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ListingIdentity" TO nexus_workspace_runtime;

DO $pr_presence$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = '"ListingIdentity"'::regclass AND polname = 'nexus_workspace_isolation'
  ) THEN
    CREATE POLICY nexus_workspace_isolation ON "ListingIdentity"
      FOR ALL TO nexus_workspace_runtime
      USING (
    "workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "Workspace" w
      WHERE w.id = "ListingIdentity"."workspaceId" AND w.status = 'active'
        AND (
          NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
          OR EXISTS (
            SELECT 1 FROM "WorkspaceMembership" m
            JOIN "UserProfile" u ON u.id = m."userId"
            WHERE m."workspaceId" = w.id
              AND m."userId" = current_setting('nexus.actor_id', true)
              AND m.status = 'active' AND u.status = 'active'
          )
        )
    )
      )
      WITH CHECK (
    "workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "Workspace" w
      WHERE w.id = "ListingIdentity"."workspaceId" AND w.status = 'active'
        AND (
          NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
          OR EXISTS (
            SELECT 1 FROM "WorkspaceMembership" m
            JOIN "UserProfile" u ON u.id = m."userId"
            WHERE m."workspaceId" = w.id
              AND m."userId" = current_setting('nexus.actor_id', true)
              AND m.status = 'active' AND u.status = 'active'
          )
        )
    )
      );
  END IF;
END;
$pr_presence$;
COMMIT;
