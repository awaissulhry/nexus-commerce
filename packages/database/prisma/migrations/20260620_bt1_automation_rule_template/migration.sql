-- B3 (Budget rule builder): AutomationRuleTemplate — reusable rule templates.
-- Additive only: a brand-new table + one index. No change to any existing table.
CREATE TABLE IF NOT EXISTS "AutomationRuleTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'advertising',
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    CONSTRAINT "AutomationRuleTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AutomationRuleTemplate_domain_type_idx" ON "AutomationRuleTemplate"("domain", "type");
