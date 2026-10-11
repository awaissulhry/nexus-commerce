-- Negative Targeting page (2026-10-11) — AutomationRule.scopeAdGroupId: a rule may be scoped to ONE ad group (local
-- AdGroup.id). The ads rule evaluator lets such a rule act only on contexts of that ad group.
-- Additive only: one nullable column on an existing business-owned table; every existing rule keeps null and runs
-- exactly as before. The table's row-level security already covers the new column.

-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN "scopeAdGroupId" TEXT;
