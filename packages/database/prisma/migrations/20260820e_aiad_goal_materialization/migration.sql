-- AIAD.1 — AdProductGoal materialization linkage (additive).
-- campaignIds: [{ id, role: AUTO|RESEARCH|PERF|PAT, label }]; planId → AutopilotPlan.
ALTER TABLE "AdProductGoal" ADD COLUMN "campaignIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AdProductGoal" ADD COLUMN "planId" TEXT;
ALTER TABLE "AdProductGoal" ADD COLUMN "materializedAt" TIMESTAMP(3);
