// AX-IE.1 evidence probe — READ ONLY. Row census across the two model
// generations so the canonical-model decision rests on data, not line numbers.
const { default: p } = await import('../src/db.js')

const TABLES = [
  // Generation A — Amazon Ads cockpit
  'Campaign', 'AdGroup', 'AdTarget', 'AdProductAd',
  'BudgetPool', 'BudgetPoolAllocation', 'BudgetPoolRebalance',
  'AmazonAdsDailyPerformance', 'AmazonAdsHourlyPerformance',
  // Generation B — Unified Marketing OS
  'MarketingCampaign', 'MarketingCampaignLink', 'AmazonAdsCampaignDetail',
  'CampaignTarget', 'CampaignBudget', 'CampaignBudgetAllocation',
  'CampaignBudgetRebalance', 'CampaignMetric',
]

const out: Record<string, string> = {}
for (const t of TABLES) {
  try {
    const r = await p.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${t}"`)
    out[t] = String(r[0]?.n ?? 0)
  } catch (e) {
    out[t] = `ERR ${(e as Error).message.split('\n')[0].slice(0, 60)}`
  }
}
console.log('CENSUS', JSON.stringify(out, null, 2))

// Freshness of the Gen-B Amazon shadow vs the Gen-A source it mirrors.
try {
  const a = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT max("updatedAt")::text AS newest, count(*)::bigint AS n FROM "Campaign"`)
  const b = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT max("updatedAt")::text AS newest, count(*)::bigint AS n FROM "MarketingCampaign" WHERE channel = 'AMAZON'`)
  console.log('GENA_Campaign', JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
  console.log('GENB_MarketingCampaign_AMAZON', JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
} catch (e) {
  console.log('FRESHNESS ERR', (e as Error).message.split('\n')[0])
}

// Does Campaign carry a real targeting-type signal anywhere? (bug E4)
try {
  const tt = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT g."targetingType", count(DISTINCT c.id)::bigint AS campaigns
     FROM "Campaign" c JOIN "AdGroup" g ON g."campaignId" = c.id
     GROUP BY 1 ORDER BY 2 DESC`)
  console.log('ADGROUP_TARGETINGTYPE', JSON.stringify(tt, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
  const mixed = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT count(*)::bigint AS campaigns_with_mixed_adgroup_targeting FROM (
       SELECT c.id FROM "Campaign" c JOIN "AdGroup" g ON g."campaignId" = c.id
       GROUP BY c.id HAVING count(DISTINCT g."targetingType") > 1) x`)
  console.log('MIXED_TARGETING', JSON.stringify(mixed, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
  // How often would the name-regex disagree with the ad-group truth?
  const regex = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       sum(CASE WHEN name_auto AND NOT ag_auto THEN 1 ELSE 0 END)::bigint AS false_auto,
       sum(CASE WHEN NOT name_auto AND ag_auto THEN 1 ELSE 0 END)::bigint AS false_manual,
       count(*)::bigint AS total
     FROM (
       SELECT c.id,
         (c.name ~* '\\yauto|close match|loose match|substitute|complement') AS name_auto,
         bool_or(g."targetingType" = 'AUTO') AS ag_auto
       FROM "Campaign" c JOIN "AdGroup" g ON g."campaignId" = c.id
       GROUP BY c.id, c.name) x`)
  console.log('REGEX_VS_TRUTH', JSON.stringify(regex, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
} catch (e) {
  console.log('TARGETING ERR', (e as Error).message.split('\n')[0])
}

await p.$disconnect()
