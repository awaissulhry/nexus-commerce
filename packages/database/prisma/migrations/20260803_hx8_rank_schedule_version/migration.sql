-- HX.8 — plan-edit history for rank schedules.
-- Purely additive: one new table + its indexes. No existing table, column or row is touched, so
-- this is safe to apply ahead of the code that reads it.

CREATE TABLE "RankScheduleVersion" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "campaignCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankScheduleVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RankScheduleVersion_groupId_createdAt_idx" ON "RankScheduleVersion"("groupId", "createdAt" DESC);

-- Cascade: a deleted schedule takes its history with it. The activity trail
-- (CampaignBidHistory / AdvertisingActionLog) is deliberately NOT cascaded — that records what
-- happened to Amazon and must outlive the plan that caused it.
ALTER TABLE "RankScheduleVersion"
  ADD CONSTRAINT "RankScheduleVersion_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
