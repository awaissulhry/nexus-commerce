-- D1 (2026-08-20) — per-campaign rule assignment.
--
-- Operator study of Helium 10's Budget Rule column: a campaign carries an assigned rule, chosen
-- from a dropdown, and a rule does nothing until it is assigned.
--
-- Purely ADDITIVE. Nothing reads this table until the resolver is taught about it and the backfill
-- has run, so applying this migration alone changes no behaviour at all.
--
-- Why a table and not a column: `AutomationRule.scopeCampaignId` points rule -> campaign and is
-- SINGLE-VALUED, so assigning a rule to a second campaign moves it off the first. Assignment points
-- campaign -> rule and is many-to-many. The two coexist; scopeCampaignId is untouched.
--
-- The unique key is (campaignId, ruleId) and NOT (campaignId, kind): four enabled budget rules act
-- on every campaign today, so a strict one-per-campaign key would admit no faithful backfill.
-- Narrowing it later would break Prisma upserts at RUNTIME via ON CONFLICT — do not tidy it.
CREATE TABLE IF NOT EXISTS "CampaignRuleAssignment" (
    "id"         TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "ruleId"     TEXT NOT NULL,
    "kind"       TEXT NOT NULL DEFAULT 'budget',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"  TEXT,

    CONSTRAINT "CampaignRuleAssignment_pkey" PRIMARY KEY ("id")
);

-- One row per (campaign, rule). Re-assigning the same rule to the same campaign is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRuleAssignment_campaignId_ruleId_key"
    ON "CampaignRuleAssignment" ("campaignId", "ruleId");

-- "which campaigns does this rule govern" (the evaluator's read) and "what governs this campaign"
-- (the grid's read). Both are hot enough to earn an index.
CREATE INDEX IF NOT EXISTS "CampaignRuleAssignment_ruleId_kind_idx"
    ON "CampaignRuleAssignment" ("ruleId", "kind");
CREATE INDEX IF NOT EXISTS "CampaignRuleAssignment_campaignId_kind_idx"
    ON "CampaignRuleAssignment" ("campaignId", "kind");

-- Cascade both ways: an assignment to a deleted campaign or a deleted rule is not a fact worth
-- keeping, and a dangling row would make the column claim a rule that no longer exists.
-- 🔴 Guarded, because `ADD CONSTRAINT` has no IF NOT EXISTS: a retry after a partial apply would
-- raise 42710 and leave the migration FAILED, which blocks every later deploy service-wide
-- (P3009). Every statement in this file is re-runnable.
DO $$ BEGIN
    ALTER TABLE "CampaignRuleAssignment"
        ADD CONSTRAINT "CampaignRuleAssignment_campaignId_fkey"
        FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CampaignRuleAssignment"
        ADD CONSTRAINT "CampaignRuleAssignment_ruleId_fkey"
        FOREIGN KEY ("ruleId") REFERENCES "AutomationRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── BACKFILL — today's reach, made explicit ───────────────────────────────────────────────────
--
-- 🔴 ORDER IS LOAD-BEARING. Once the resolver honours assignment, a budget rule assigned to
-- nothing reaches nothing. If the evaluator shipped before these rows existed, every budget rule
-- would silently stop acting. Doing the backfill HERE, inside the same transaction that creates
-- the table, makes that window impossible: the table is never both read and empty.
--
-- Measured on prod 2026-08-20: 6 budget rules, ALL account-wide (no marketplace, portfolio,
-- campaign or product scope), reaching all 220 campaigns. So this reproduces today's behaviour
-- exactly, and the operator's approved plan — "backfilled first, so day one behaves identically".
--
-- Disabled rules are included on purpose. Under assignment-as-reach, a disabled rule re-enabled
-- later would otherwise wake up governing nothing, which is a silent change nobody asked for.
--
-- ⚠️ Product scope is NOT expanded here: `scopeProductId` may hold a PARENT that resolves to many
-- children, which needs application code. Zero budget rules are product-scoped today, and the
-- guard below simply excludes any that are rather than guessing at their reach — such a rule keeps
-- its old scope-driven behaviour until someone assigns it deliberately.
INSERT INTO "CampaignRuleAssignment" ("id", "campaignId", "ruleId", "kind", "createdBy")
SELECT
    gen_random_uuid()::text,
    c."id",
    r."id",
    'budget',
    'migration:20260820b_d1'
FROM "AutomationRule" r
JOIN "Campaign" c ON TRUE
WHERE r."domain" = 'advertising'
  AND r."scopeProductId" IS NULL
  AND jsonb_typeof(r."actions"::jsonb) = 'array'
  AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r."actions"::jsonb) AS a
      WHERE a->>'type' = 'adjust_ad_budget'
  )
  -- The scope columns still bind: a market- or portfolio-scoped budget rule is backfilled only
  -- onto the campaigns it already reached, never widened.
  AND (r."scopeMarketplace" IS NULL OR r."scopeMarketplace" = c."marketplace")
  AND (r."scopePortfolioId" IS NULL OR r."scopePortfolioId" = c."portfolioId")
  AND (r."scopeCampaignId" IS NULL OR r."scopeCampaignId" = c."id")
ON CONFLICT ("campaignId", "ruleId") DO NOTHING;
