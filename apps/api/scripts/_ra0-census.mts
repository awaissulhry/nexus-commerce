/** RA.0 — read-only census of everything the /marketing/ads/rules-automation tabs claim to govern. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const q = async (label: string, sql: string) => {
  try {
    const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql)
    console.log(label, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
  } catch (e) {
    console.log(label, 'ERR', (e as Error).message.slice(0, 160))
  }
}

await q('AutomationRule by domain/enabled/level:', `
  SELECT domain, enabled, "dryRun", "autonomyLevel", COUNT(*)::int AS n
  FROM "AutomationRule" GROUP BY 1,2,3,4 ORDER BY 1,5 DESC`)

await q('AutomationRule advertising — action types:', `
  SELECT a->>'type' AS action, COUNT(*)::int AS n
  FROM "AutomationRule" r, LATERAL jsonb_array_elements(r.actions::jsonb) a
  WHERE r.domain='advertising' GROUP BY 1 ORDER BY 2 DESC`)

await q('AutomationRule advertising — scope binding:', `
  SELECT (CASE WHEN "scopeCampaignId" IS NOT NULL THEN 'campaign'
               WHEN "scopePortfolioId" IS NOT NULL THEN 'portfolio' ELSE 'account' END) AS scope,
         COUNT(*)::int AS n
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1`)

await q('AutomationRule — triggers:', `
  SELECT trigger, COUNT(*)::int AS n FROM "AutomationRule" GROUP BY 1 ORDER BY 2 DESC LIMIT 40`)

await q('RankScheduleGroup:', `SELECT enabled, COUNT(*)::int n FROM "RankScheduleGroup" GROUP BY 1`)
await q('RankScheduleEvent:', `SELECT COUNT(*)::int n FROM "RankScheduleEvent"`)
await q('RankTarget:', `SELECT COUNT(*)::int n FROM "RankTarget"`)
await q('ProductRankPlan:', `SELECT COUNT(*)::int n FROM "ProductRankPlan"`)
await q('RankScheduleTemplate:', `SELECT COUNT(*)::int n FROM "RankScheduleTemplate"`)
await q('BudgetSchedule:', `SELECT COUNT(*)::int n FROM "BudgetSchedule"`)
await q('KeywordCoverageSet:', `SELECT status, COUNT(*)::int n FROM "KeywordCoverageSet" GROUP BY 1`)
await q('KeywordCoverageTerm:', `SELECT COUNT(*)::int n FROM "KeywordCoverageTerm"`)
await q('KeywordRank (tracker):', `SELECT COUNT(*)::int n, COUNT(DISTINCT keyword)::int kw, MAX("createdAt") latest FROM "KeywordRank"`)
await q('AdKeywordProtection:', `SELECT COUNT(*)::int n FROM "AdKeywordProtection"`)
await q('AdsRuleSuggestion by status:', `SELECT status, COUNT(*)::int n FROM "AdsRuleSuggestion" GROUP BY 1`)
await q('BudgetPool:', `SELECT COUNT(*)::int n FROM "BudgetPool"`)
await q('AutomationRuleExecution 30d:', `
  SELECT status, COUNT(*)::int n FROM "AutomationRuleExecution"
  WHERE "createdAt" > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`)
await q('Campaigns:', `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE status='ENABLED')::int enabled FROM "Campaign"`)
await q('AmazonAdsPortfolio:', `SELECT COUNT(*)::int n FROM "AmazonAdsPortfolio"`)
await q('AdsAutomationState:', `SELECT * FROM "AdsAutomationState" LIMIT 2`)

await prisma.$disconnect()
