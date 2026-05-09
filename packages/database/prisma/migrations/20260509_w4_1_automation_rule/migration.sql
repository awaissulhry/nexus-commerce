-- W4.1 — AutomationRule + AutomationRuleExecution.
--
-- The replenishment platform has hardcoded auto-PO logic (R.6) that
-- fires nightly with env-var ceilings. The audit revealed this is
-- the CORNERSTONE feature gap: operators want to compose their own
-- rules (auto-approve below €500, emergency reorder on stockout,
-- alert on demand spike, etc.) without a code change.
--
-- Idempotent CREATE IF NOT EXISTS so re-runs are no-ops.

CREATE TABLE IF NOT EXISTS "AutomationRule" (
  "id"                   TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "description"          TEXT,
  "domain"               TEXT NOT NULL DEFAULT 'replenishment',
  "trigger"              TEXT NOT NULL,
  "conditions"           JSONB NOT NULL DEFAULT '[]'::jsonb,
  "actions"              JSONB NOT NULL DEFAULT '[]'::jsonb,
  "enabled"              BOOLEAN NOT NULL DEFAULT false,
  "dryRun"               BOOLEAN NOT NULL DEFAULT true,
  "maxExecutionsPerDay"  INTEGER DEFAULT 100,
  "maxValueCentsEur"     INTEGER,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  "createdBy"            TEXT,
  "evaluationCount"      INTEGER NOT NULL DEFAULT 0,
  "matchCount"           INTEGER NOT NULL DEFAULT 0,
  "executionCount"       INTEGER NOT NULL DEFAULT 0,
  "lastEvaluatedAt"      TIMESTAMP(3),
  "lastMatchedAt"        TIMESTAMP(3),
  "lastExecutedAt"       TIMESTAMP(3),

  CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AutomationRule_domain_enabled_idx"
  ON "AutomationRule"("domain", "enabled");

CREATE INDEX IF NOT EXISTS "AutomationRule_trigger_idx"
  ON "AutomationRule"("trigger");

CREATE TABLE IF NOT EXISTS "AutomationRuleExecution" (
  "id"            TEXT NOT NULL,
  "ruleId"        TEXT NOT NULL,
  "triggerData"   JSONB NOT NULL,
  "actionResults" JSONB NOT NULL,
  "dryRun"        BOOLEAN NOT NULL,
  "status"        TEXT NOT NULL,
  "errorMessage"  TEXT,
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"    TIMESTAMP(3),
  "durationMs"    INTEGER,

  CONSTRAINT "AutomationRuleExecution_pkey" PRIMARY KEY ("id")
);

-- ON DELETE CASCADE — when a rule is deleted, its execution history
-- goes with it. Soft-delete the rule (toggle enabled=false) if you
-- want to preserve audit history.
DO $$ BEGIN
  ALTER TABLE "AutomationRuleExecution"
    ADD CONSTRAINT "AutomationRuleExecution_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "AutomationRuleExecution_ruleId_startedAt_idx"
  ON "AutomationRuleExecution"("ruleId", "startedAt" DESC);

CREATE INDEX IF NOT EXISTS "AutomationRuleExecution_status_startedAt_idx"
  ON "AutomationRuleExecution"("status", "startedAt" DESC);
