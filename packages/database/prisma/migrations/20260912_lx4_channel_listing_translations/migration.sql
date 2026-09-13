-- LX.3: new pin store only. No existing data, column, trigger or function changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "ChannelListingTranslation" (
  "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id" TEXT NOT NULL,
  "channelListingId" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "name" TEXT,
  "description" TEXT,
  "bulletPoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attributes" JSONB NOT NULL DEFAULT '{}',
  "follows" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelListingTranslation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChannelListingTranslation_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChannelListingTranslation_workspaceId_channelListingId_langu_key" ON "ChannelListingTranslation"("workspaceId", "channelListingId", "language");
CREATE INDEX "ChannelListingTranslation_channelListingId_idx" ON "ChannelListingTranslation"("channelListingId");
CREATE INDEX "ChannelListingTranslation_workspaceId_idx" ON "ChannelListingTranslation"("workspaceId");
-- The existing local workspace runtime needs access to this new table only.
-- Production has not installed that role; no role or other database object is created.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ChannelListingTranslation" TO nexus_workspace_runtime;
  END IF;
END $$;
COMMIT;
