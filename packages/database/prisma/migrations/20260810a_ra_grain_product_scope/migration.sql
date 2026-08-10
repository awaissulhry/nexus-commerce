-- RA.GRAIN — the fourth grain: scope a rule to a product line, or to one variation.
--
-- Additive only: one nullable column and one index. No existing row is altered and every
-- existing rule keeps the scope it had (all 51 stay account-wide except the 8 already pinned
-- to IT). Nothing is backfilled, because "no product scope" is the correct value for every
-- rule that exists today.
--
-- Why a plain String and not a foreign key: deleting a product must never cascade a rule out
-- of existence, and a dangling id is not a crash — it resolves to zero campaigns, which the
-- reach line states out loud ("0 of 220 — this combination can never fire").
--
-- Why ONE column rather than an array: the operator's four grains are symmetrical — one
-- campaign, one portfolio, one market, one product line — and a single id delivers that with
-- the same number of clicks at every grain. It holds either a PARENT `Product.id` (the whole
-- line, expanded to its children by the evaluator) or one child id. Multi-select is a later
-- extension and `AdProductSet` already exists for it.
--
-- Measured on prod 2026-08-10 (scripts/_ra9–_ra14, read-only): all 223 advertised products are
-- children of exactly 13 parents, so the line grain needed no new entity and the picker needs
-- 13 rows. `ProductVariation` has 0 rows and `ProductFamily` has 0 rows — neither is the line.

-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN "scopeProductId" TEXT;

-- CreateIndex — the evaluator loads rules per trigger and filters by scope; this keeps the
-- product-scoped subset cheap to find, matching the existing scope columns' access pattern.
CREATE INDEX "AutomationRule_scopeProductId_idx" ON "AutomationRule"("scopeProductId");
