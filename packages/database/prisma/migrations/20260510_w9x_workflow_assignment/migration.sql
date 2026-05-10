-- W9.x: WorkflowAssignment — per-product reviewer/approver tracking.
-- Operators can delegate content review to named team members with role
-- (REVIEWER / APPROVER / OWNER), optional stage context, and due date.

CREATE TABLE IF NOT EXISTS "WorkflowAssignment" (
  "id"           TEXT        NOT NULL,
  "productId"    TEXT        NOT NULL,
  "stageId"      TEXT,
  "assigneeId"   TEXT        NOT NULL,
  "role"         TEXT        NOT NULL DEFAULT 'REVIEWER',
  "assignedById" TEXT,
  "dueAt"        TIMESTAMP(3),
  "note"         TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowAssignment_productId_assigneeId_role_key"
  ON "WorkflowAssignment"("productId", "assigneeId", "role");

CREATE INDEX IF NOT EXISTS "WorkflowAssignment_productId_idx"
  ON "WorkflowAssignment"("productId");

CREATE INDEX IF NOT EXISTS "WorkflowAssignment_stageId_idx"
  ON "WorkflowAssignment"("stageId");

CREATE INDEX IF NOT EXISTS "WorkflowAssignment_assigneeId_idx"
  ON "WorkflowAssignment"("assigneeId");

ALTER TABLE "WorkflowAssignment"
  ADD CONSTRAINT "WorkflowAssignment_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowAssignment"
  ADD CONSTRAINT "WorkflowAssignment_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "WorkflowStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkflowAssignment"
  ADD CONSTRAINT "WorkflowAssignment_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
