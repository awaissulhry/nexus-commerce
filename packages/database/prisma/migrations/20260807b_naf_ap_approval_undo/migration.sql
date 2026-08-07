-- NAF.AP.4/AP.5 — the approval undo window and the single expiry clock.
-- Additive only: one nullable column and two indexes. No existing row or
-- object is altered, and every existing status keeps its meaning.

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN "executeAfter" TIMESTAMP(3);

-- CreateIndex — the maintenance sweep's two queries.
CREATE INDEX "AgentApproval_status_executeAfter_idx" ON "AgentApproval"("status", "executeAfter");
CREATE INDEX "AgentApproval_status_expiresAt_idx" ON "AgentApproval"("status", "expiresAt");
