-- G1 — dated event overrides on a rank schedule.
-- Purely additive: one new table, its indexes and FK. No existing table, column or row is touched,
-- and the engine treats an empty table as "no events", so this is inert until an event is created.

CREATE TABLE "RankScheduleEvent" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankScheduleEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RankScheduleEvent_groupId_startsAt_idx" ON "RankScheduleEvent"("groupId", "startsAt");
-- The engine's hot path: "is any event live right now".
CREATE INDEX "RankScheduleEvent_enabled_startsAt_endsAt_idx" ON "RankScheduleEvent"("enabled", "startsAt", "endsAt");

ALTER TABLE "RankScheduleEvent"
  ADD CONSTRAINT "RankScheduleEvent_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
