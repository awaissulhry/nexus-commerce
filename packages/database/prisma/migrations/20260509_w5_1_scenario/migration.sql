-- W5.1 — Scenario + ScenarioRun for what-if planning.
--
-- Idempotent CREATE IF NOT EXISTS so re-runs are no-ops.

CREATE TABLE IF NOT EXISTS "Scenario" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "kind"        TEXT NOT NULL,
  "params"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "horizonDays" INTEGER NOT NULL DEFAULT 90,
  "isSaved"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdBy"   TEXT,

  CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Scenario_kind_idx" ON "Scenario"("kind");
CREATE INDEX IF NOT EXISTS "Scenario_isSaved_updatedAt_idx"
  ON "Scenario"("isSaved", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS "ScenarioRun" (
  "id"                  TEXT NOT NULL,
  "scenarioId"          TEXT NOT NULL,
  "inputs"              JSONB NOT NULL,
  "output"              JSONB NOT NULL,
  "recsAffected"        INTEGER NOT NULL DEFAULT 0,
  "totalUnitsDelta"     INTEGER NOT NULL DEFAULT 0,
  "totalCostDeltaCents" INTEGER NOT NULL DEFAULT 0,
  "status"              TEXT NOT NULL,
  "errorMessage"        TEXT,
  "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"          TIMESTAMP(3),
  "durationMs"          INTEGER,

  CONSTRAINT "ScenarioRun_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ScenarioRun"
    ADD CONSTRAINT "ScenarioRun_scenarioId_fkey"
    FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ScenarioRun_scenarioId_startedAt_idx"
  ON "ScenarioRun"("scenarioId", "startedAt" DESC);

CREATE INDEX IF NOT EXISTS "ScenarioRun_status_startedAt_idx"
  ON "ScenarioRun"("status", "startedAt" DESC);
