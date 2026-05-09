-- W7.7 — BulkAutomationApproval: approval queue for high-blast-
-- radius bulk-ops automation actions.

CREATE TABLE "BulkAutomationApproval" (
  "id"                     TEXT PRIMARY KEY,

  "ruleId"                 TEXT NOT NULL,
  "ruleName"               TEXT NOT NULL,

  "triggerPayload"         JSONB NOT NULL,
  "actionPlan"             JSONB NOT NULL,

  "threshold"              TEXT NOT NULL,
  "estimatedValueCentsEur" INTEGER,

  "status"                 TEXT NOT NULL DEFAULT 'PENDING',

  "expiresAt"              TIMESTAMP(3) NOT NULL,

  "approvedBy"             TEXT,
  "approvedAt"             TIMESTAMP(3),
  "rejectedBy"             TEXT,
  "rejectedAt"             TIMESTAMP(3),
  "rejectedReason"         TEXT,

  "resolvedActionResults"  JSONB,
  "resolvedExecutionId"    TEXT,

  "createdBy"              TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL
);

CREATE INDEX "BulkAutomationApproval_status_expiresAt_idx"
  ON "BulkAutomationApproval"("status", "expiresAt");
CREATE INDEX "BulkAutomationApproval_ruleId_createdAt_idx"
  ON "BulkAutomationApproval"("ruleId", "createdAt" DESC);
