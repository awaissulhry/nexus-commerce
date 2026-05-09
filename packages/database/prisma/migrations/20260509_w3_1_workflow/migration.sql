-- W3.1 — ProductWorkflow + WorkflowStage + WorkflowTransition +
-- WorkflowComment.
--
-- Salesforce-parity content-quality pipeline (simplified for the
-- single-operator MVP). A Workflow is a configurable named pipeline
-- of stages — DRAFT → REVIEW → APPROVED → PUBLISHED. Each
-- ProductFamily can OPTIONALLY reference one workflow; products
-- joining such a family land on the workflow's initial stage and
-- progress through transitions logged in WorkflowTransition.
--
-- Distinct from Product.status — status is the operational
-- ACTIVE/INACTIVE/DRAFT lifecycle that cascades to marketplaces.
-- workflowStage is the internal content-quality gate before the
-- operator flips status to ACTIVE. Workflow service does NOT
-- mutate status (cascade stays explicit).
--
-- Cascade rules:
--   ProductWorkflow → WorkflowStage    : CASCADE (stages have no
--                                        meaning without their
--                                        workflow)
--   WorkflowStage → Product            : SET NULL (delete a stage,
--                                        products fall off the
--                                        workflow but keep data)
--   Product → WorkflowTransition       : CASCADE (transitions
--                                        owned by the product)
--   WorkflowStage(from) → Transition   : SET NULL (preserve history
--                                        if a stage is renamed/
--                                        removed)
--   WorkflowStage(to) → Transition     : RESTRICT (refuse to delete
--                                        a stage products are
--                                        sitting in / passed
--                                        through)
--   WorkflowStage → Comment            : CASCADE (comments are
--                                        scoped to a stage)
--   Product → Comment                  : CASCADE
--   ProductFamily → Workflow           : SET NULL (detaching the
--                                        workflow from a family is
--                                        non-destructive)
--
-- Idempotent: every CREATE uses IF NOT EXISTS; FK creates guarded
-- by pg_constraint lookups so re-runs are no-ops.

-- ── ProductWorkflow ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductWorkflow" (
  "id"          TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "ProductWorkflow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductWorkflow_code_key"
  ON "ProductWorkflow"("code");

-- ── WorkflowStage ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkflowStage" (
  "id"             TEXT NOT NULL,
  "workflowId"     TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "description"    TEXT,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "slaHours"       INTEGER,
  "isPublishable"  BOOLEAN NOT NULL DEFAULT FALSE,
  "isInitial"      BOOLEAN NOT NULL DEFAULT FALSE,
  "isTerminal"     BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP NOT NULL,

  CONSTRAINT "WorkflowStage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowStage_workflowId_code_key"
  ON "WorkflowStage"("workflowId", "code");

CREATE INDEX IF NOT EXISTS "WorkflowStage_workflowId_idx"
  ON "WorkflowStage"("workflowId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowStage_workflowId_fkey'
  ) THEN
    ALTER TABLE "WorkflowStage"
      ADD CONSTRAINT "WorkflowStage_workflowId_fkey"
      FOREIGN KEY ("workflowId") REFERENCES "ProductWorkflow"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── WorkflowTransition ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkflowTransition" (
  "id"          TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "fromStageId" TEXT,
  "toStageId"   TEXT NOT NULL,
  "userId"      TEXT,
  "comment"     TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkflowTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WorkflowTransition_productId_createdAt_idx"
  ON "WorkflowTransition"("productId", "createdAt");

CREATE INDEX IF NOT EXISTS "WorkflowTransition_toStageId_idx"
  ON "WorkflowTransition"("toStageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowTransition_productId_fkey'
  ) THEN
    ALTER TABLE "WorkflowTransition"
      ADD CONSTRAINT "WorkflowTransition_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowTransition_fromStageId_fkey'
  ) THEN
    ALTER TABLE "WorkflowTransition"
      ADD CONSTRAINT "WorkflowTransition_fromStageId_fkey"
      FOREIGN KEY ("fromStageId") REFERENCES "WorkflowStage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowTransition_toStageId_fkey'
  ) THEN
    ALTER TABLE "WorkflowTransition"
      ADD CONSTRAINT "WorkflowTransition_toStageId_fkey"
      FOREIGN KEY ("toStageId") REFERENCES "WorkflowStage"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── WorkflowComment ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkflowComment" (
  "id"        TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "stageId"   TEXT NOT NULL,
  "userId"    TEXT,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL,

  CONSTRAINT "WorkflowComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WorkflowComment_productId_createdAt_idx"
  ON "WorkflowComment"("productId", "createdAt");

CREATE INDEX IF NOT EXISTS "WorkflowComment_stageId_idx"
  ON "WorkflowComment"("stageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowComment_productId_fkey'
  ) THEN
    ALTER TABLE "WorkflowComment"
      ADD CONSTRAINT "WorkflowComment_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowComment_stageId_fkey'
  ) THEN
    ALTER TABLE "WorkflowComment"
      ADD CONSTRAINT "WorkflowComment_stageId_fkey"
      FOREIGN KEY ("stageId") REFERENCES "WorkflowStage"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Product.workflowStageId + index + FK ──────────────────────
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "workflowStageId" TEXT;

CREATE INDEX IF NOT EXISTS "Product_workflowStageId_idx"
  ON "Product"("workflowStageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Product_workflowStageId_fkey'
  ) THEN
    ALTER TABLE "Product"
      ADD CONSTRAINT "Product_workflowStageId_fkey"
      FOREIGN KEY ("workflowStageId") REFERENCES "WorkflowStage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── ProductFamily.workflowId + index + FK ─────────────────────
ALTER TABLE "ProductFamily"
  ADD COLUMN IF NOT EXISTS "workflowId" TEXT;

CREATE INDEX IF NOT EXISTS "ProductFamily_workflowId_idx"
  ON "ProductFamily"("workflowId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProductFamily_workflowId_fkey'
  ) THEN
    ALTER TABLE "ProductFamily"
      ADD CONSTRAINT "ProductFamily_workflowId_fkey"
      FOREIGN KEY ("workflowId") REFERENCES "ProductWorkflow"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
