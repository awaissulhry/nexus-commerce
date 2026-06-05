-- RS.1 — Rank Plans: reusable rank-goal presets + per-schedule baseline.
-- Fully additive (new table + one nullable column). Back-compatible: existing
-- bid-multiplier windows and schedules with no defaultTargetKey behave exactly
-- as before.

ALTER TABLE "AdSchedule" ADD COLUMN "defaultTargetKey" TEXT;

CREATE TABLE "RankTarget" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'PLACEMENT_TOP',
    "targetISPct" INTEGER,
    "acosCapPct" INTEGER,
    "maxCpcCents" INTEGER,
    "biasPct" INTEGER,
    "pause" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RankTarget_key_key" ON "RankTarget"("key");
