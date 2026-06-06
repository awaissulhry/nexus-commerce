-- RTPL — named, reusable rank schedule templates (account-global). Additive.
CREATE TABLE IF NOT EXISTS "RankScheduleTemplate" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "windows" JSONB NOT NULL DEFAULT '[]',
  "defaultTargetKey" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RankScheduleTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RankScheduleTemplate_name_idx" ON "RankScheduleTemplate"("name");
