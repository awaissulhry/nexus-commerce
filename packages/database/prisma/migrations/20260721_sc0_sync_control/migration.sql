-- SC.0 — Sync Control foundation (additive only; defaults = current behavior).
ALTER TABLE "ChannelListing" ADD COLUMN "syncPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChannelListing" ADD COLUMN "sourceLocationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SharedListingMembership" ADD COLUMN "followPool" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SharedListingMembership" ADD COLUMN "stockBuffer" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SyncChannelPolicy" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "pushesPaused" BOOLEAN NOT NULL DEFAULT false,
    "newListingDefaultMode" TEXT NOT NULL DEFAULT 'FOLLOW',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncChannelPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SyncChannelPolicy_channel_marketplace_key" ON "SyncChannelPolicy"("channel", "marketplace");

CREATE TABLE "SyncControlAudit" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "scopeName" TEXT,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncControlAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SyncControlAudit_scopeType_scopeId_createdAt_idx" ON "SyncControlAudit"("scopeType", "scopeId", "createdAt");
CREATE INDEX "SyncControlAudit_createdAt_idx" ON "SyncControlAudit"("createdAt");
