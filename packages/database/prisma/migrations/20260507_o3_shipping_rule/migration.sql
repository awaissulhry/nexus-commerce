-- O.3 — Outbound rebuild: ShippingRule.
--
-- WHEN <conditions> THEN <actions>, walked in priority order. Conditions
-- and actions are JSONB (not normalized) because the rule taxonomy
-- expands fast and reads are always whole-rule — the applier (O.16)
-- loads the active rule set into TS, matches in-process, and applies
-- the first hit's actions to the shipment.
--
-- Empty on creation. Consumers land in O.16 (rules engine UI +
-- applyShippingRules service called from shipment-create), and the
-- rules-list UI uses lastFiredAt / triggerCount for analytics.

CREATE TABLE IF NOT EXISTS "ShippingRule" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "description"   TEXT,
  -- Lower number = higher priority. Applier walks ASC.
  "priority"      INTEGER NOT NULL DEFAULT 100,
  -- Inactive rules don't fire but stay visible for editing/cloning.
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  -- See ShippingRuleCondition / ShippingRuleAction TS types alongside
  -- the applier (O.16). Empty {} on creation = "match nothing /
  -- do nothing"; the UI requires at least one condition + one action
  -- before saving.
  "conditions"    JSONB NOT NULL DEFAULT '{}',
  "actions"       JSONB NOT NULL DEFAULT '{}',
  -- Audit + analytics. Cheap counter incremented in the same tx as
  -- shipment-create when the rule matches.
  "lastFiredAt"   TIMESTAMP(3),
  "triggerCount"  INTEGER NOT NULL DEFAULT 0,
  -- Free-form operator id (no User model yet — matches rest of schema).
  "createdBy"     TEXT,
  "updatedBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Applier's primary read: active rules in priority order.
CREATE INDEX IF NOT EXISTS "ShippingRule_isActive_priority_idx"
  ON "ShippingRule"("isActive", "priority");
-- Rules-list UI: "most recently fired" / "stale rules" sorts.
CREATE INDEX IF NOT EXISTS "ShippingRule_lastFiredAt_idx"
  ON "ShippingRule"("lastFiredAt");
