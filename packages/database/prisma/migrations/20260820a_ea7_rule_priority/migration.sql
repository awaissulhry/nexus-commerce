-- EA7 — rule execution order.
--
-- Additive and defaulted, so every existing rule keeps identical behaviour on deploy: they all
-- share priority 100 and the evaluator's tie-break is createdAt, which is the order they already
-- ran in. Nothing reorders until an operator sets a value.
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100;

-- The evaluator selects by (domain, trigger, enabled) then orders by (priority, createdAt).
CREATE INDEX IF NOT EXISTS "AutomationRule_priority_idx" ON "AutomationRule" ("priority");
