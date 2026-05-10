-- WT.1 (list-wizard) — wizard templates.
--
-- Operator productivity multiplier. Awa publishing 50 SKUs/day
-- shouldn't have to walk all 9 wizard steps from defaults each time
-- — apply a matching template (Motorcycle Helmet → Amazon EU + eBay
-- IT + CE pre-flagged) and skip ahead to the first incomplete step.
--
-- 5 built-in seeds shipped with the migration. Operator-created
-- rows land via the WT.2+ apply / save endpoints.

CREATE TABLE "WizardTemplate" (
  "id"           TEXT PRIMARY KEY,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "channels"     JSONB NOT NULL,
  "defaults"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "builtIn"      BOOLEAN NOT NULL DEFAULT false,
  "categoryHint" TEXT,
  "usageCount"   INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "createdBy"    TEXT
);

CREATE INDEX "WizardTemplate_builtIn_idx" ON "WizardTemplate"("builtIn");
CREATE INDEX "WizardTemplate_usageCount_idx" ON "WizardTemplate"("usageCount");
CREATE INDEX "WizardTemplate_lastUsedAt_idx" ON "WizardTemplate"("lastUsedAt");

-- ── Built-in seeds ───────────────────────────────────────────────────
-- Stable IDs so subsequent migrations can ALTER specific seeds (e.g.
-- when Amazon's referral fee changes the template's defaults).
-- Rows seeded as builtIn=true; the operator-facing API treats those
-- as read-only.

INSERT INTO "WizardTemplate" (
  "id", "name", "description", "channels", "defaults",
  "builtIn", "categoryHint", "createdAt", "updatedAt", "createdBy"
) VALUES (
  'wt_seed_helmet_eu',
  'Motorcycle Helmet — EU multi-marketplace',
  'Amazon IT/DE/FR/ES + eBay IT. Pre-selects shared SKU strategy + reminds operator to attach CE / ECE-22.06 cert before submit (PPE Cat III).',
  '[{"platform":"AMAZON","marketplace":"IT"},{"platform":"AMAZON","marketplace":"DE"},{"platform":"AMAZON","marketplace":"FR"},{"platform":"AMAZON","marketplace":"ES"},{"platform":"EBAY","marketplace":"IT"}]'::jsonb,
  '{"skuStrategy":{"parentSku":"shared","childSku":"shared","fbaFbm":"same"}}'::jsonb,
  true,
  'helmet',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'system'
);

INSERT INTO "WizardTemplate" (
  "id", "name", "description", "channels", "defaults",
  "builtIn", "categoryHint", "createdAt", "updatedAt", "createdBy"
) VALUES (
  'wt_seed_jacket_cross_channel',
  'Motorcycle Jacket — Cross-Channel Standard',
  'Amazon IT + eBay IT + Shopify. Default mix for new gear launches that need brand storytelling on Shopify alongside marketplace reach.',
  '[{"platform":"AMAZON","marketplace":"IT"},{"platform":"EBAY","marketplace":"IT"},{"platform":"SHOPIFY","marketplace":"GLOBAL"}]'::jsonb,
  '{"skuStrategy":{"parentSku":"shared","childSku":"shared","fbaFbm":"same"}}'::jsonb,
  true,
  'jacket',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'system'
);

INSERT INTO "WizardTemplate" (
  "id", "name", "description", "channels", "defaults",
  "builtIn", "categoryHint", "createdAt", "updatedAt", "createdBy"
) VALUES (
  'wt_seed_amazon_fba_eu',
  'Amazon FBA — EU Tier 1',
  'Amazon IT + DE + FR + ES + UK. FBA-suffixed SKUs so Pan-EU FBA inventory routing stays clean.',
  '[{"platform":"AMAZON","marketplace":"IT"},{"platform":"AMAZON","marketplace":"DE"},{"platform":"AMAZON","marketplace":"FR"},{"platform":"AMAZON","marketplace":"ES"},{"platform":"AMAZON","marketplace":"UK"}]'::jsonb,
  '{"skuStrategy":{"parentSku":"shared","childSku":"shared","fbaFbm":"suffixed"}}'::jsonb,
  true,
  null,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'system'
);

INSERT INTO "WizardTemplate" (
  "id", "name", "description", "channels", "defaults",
  "builtIn", "categoryHint", "createdAt", "updatedAt", "createdBy"
) VALUES (
  'wt_seed_ebay_italy',
  'eBay Italy Only',
  'eBay IT solo — fastest publish path for SKUs that match eBay buyer demographics but don''t fit Amazon catalog rules.',
  '[{"platform":"EBAY","marketplace":"IT"}]'::jsonb,
  '{"skuStrategy":{"parentSku":"shared","childSku":"shared","fbaFbm":"same"}}'::jsonb,
  true,
  null,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'system'
);

INSERT INTO "WizardTemplate" (
  "id", "name", "description", "channels", "defaults",
  "builtIn", "categoryHint", "createdAt", "updatedAt", "createdBy"
) VALUES (
  'wt_seed_shopify_d2c',
  'Shopify D2C Only',
  'Shopify GLOBAL solo — direct-to-consumer brand-storytelling launches before going wide on marketplaces.',
  '[{"platform":"SHOPIFY","marketplace":"GLOBAL"}]'::jsonb,
  '{"skuStrategy":{"parentSku":"shared","childSku":"shared","fbaFbm":"same"}}'::jsonb,
  true,
  null,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'system'
);
