-- P2 (docs/attributes/PLAN.md §4.7) — readiness rebuilt after a big bulk edit instead of inside it.
-- Additive only: one nullable column and one index. Existing rows read NULL = current, which is what they are.
ALTER TABLE "ReadinessIndex" ADD COLUMN "pendingSince" TIMESTAMP(3);

CREATE INDEX "ReadinessIndex_workspaceId_pendingSince_idx" ON "ReadinessIndex"("workspaceId", "pendingSince");
