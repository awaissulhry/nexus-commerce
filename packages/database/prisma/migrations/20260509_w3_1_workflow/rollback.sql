-- Rollback for W3.1 — drop workflow tables + remove the two new
-- columns from Product and ProductFamily. Order matters: drop the
-- FKs that reference the workflow tables first, then the tables
-- themselves. CASCADE on the DROP TABLE handles internal FKs.

ALTER TABLE "Product"
  DROP CONSTRAINT IF EXISTS "Product_workflowStageId_fkey";
DROP INDEX IF EXISTS "Product_workflowStageId_idx";
ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "workflowStageId";

ALTER TABLE "ProductFamily"
  DROP CONSTRAINT IF EXISTS "ProductFamily_workflowId_fkey";
DROP INDEX IF EXISTS "ProductFamily_workflowId_idx";
ALTER TABLE "ProductFamily"
  DROP COLUMN IF EXISTS "workflowId";

DROP TABLE IF EXISTS "WorkflowComment" CASCADE;
DROP TABLE IF EXISTS "WorkflowTransition" CASCADE;
DROP TABLE IF EXISTS "WorkflowStage" CASCADE;
DROP TABLE IF EXISTS "ProductWorkflow" CASCADE;
