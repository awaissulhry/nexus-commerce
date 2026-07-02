-- CreateTable
CREATE TABLE "RankScheduleGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "targetOverrides" JSONB NOT NULL DEFAULT '{}',
    "portfolioId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "RankScheduleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RankScheduleGroup_marketplace_idx" ON "RankScheduleGroup"("marketplace");

-- AlterTable
ALTER TABLE "AdSchedule" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE INDEX "AdSchedule_groupId_idx" ON "AdSchedule"("groupId");

-- AddForeignKey
ALTER TABLE "AdSchedule" ADD CONSTRAINT "AdSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
