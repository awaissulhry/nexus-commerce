-- Claude's changes need no approval (2026-10-20): one switch per business. When a person turns it on, every change
-- Claude asks for is approved in the name of the person who asked (AgentApproval.decisionVia 'no-approval') and runs
-- after the normal 20-second stop window; off, every change follows its kind's level exactly as before. Additive only:
-- two nullable columns on the existing business-owned "AgentAutonomy" (its row-level security already covers them);
-- no row and null both mean off. Code: apps/api/src/services/agents/claude-trust.service.ts (`setNoApproval`).
--
-- Rollback: ALTER TABLE "AgentAutonomy" DROP COLUMN "claudeNoApprovalAt", DROP COLUMN "claudeNoApprovalBy";

-- AlterTable
ALTER TABLE "AgentAutonomy" ADD COLUMN     "claudeNoApprovalAt" TIMESTAMP(3),
ADD COLUMN     "claudeNoApprovalBy" TEXT;
