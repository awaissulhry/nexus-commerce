-- NAF.SB.AS — assignments: one worker, one target, one job.
-- Additive only. Nothing is dropped, nothing is made NOT NULL on a live table.

-- CreateTable
CREATE TABLE "AgentAssignment" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetKind" TEXT,
    "targetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wantBack" TEXT,
    "dueAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'not_started',
    "closeNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAssignment_state_createdAt_idx" ON "AgentAssignment"("state", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAssignment_charterKey_createdAt_idx" ON "AgentAssignment"("charterKey", "createdAt");

-- AlterTable: the assignment that caused a run. Nullable — every existing row
-- is legitimately null (not from an assignment).
ALTER TABLE "AgentRun" ADD COLUMN "assignmentId" TEXT;

-- CreateIndex
CREATE INDEX "AgentRun_assignmentId_idx" ON "AgentRun"("assignmentId");
