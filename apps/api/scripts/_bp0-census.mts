/**
 * BP0 — Bid page/builder perfection, Phase 0 census. READ-ONLY.
 *
 * Measures the facts the gap matrix depends on, post-W7 (all 51 legacy rules deleted):
 *  1. advertising rules by shape + bid-tab membership (expect 0)
 *  2. pending suggestions (expect 0) · rule templates
 *  3. AD_TARGET-grain AmazonAdsDailyPerformance coverage in the KEYWORD_HIGH_ACOS settled window
 *     — decides whether a builder Bid rule can match anything today
 *  4. CampaignSection payload sizes: campaigns (limit 500 honest?), ad groups, portfolios,
 *     scope-options product lines with campaigns
 *  5. bid landscape: ENABLED positive targets, at-floor population, campaigns with min/max bid set
 *
 * Run: cd apps/api && NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_bp0-census.mts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // 1 — rules
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: { id: true, name: true, trigger: true, enabled: true, autonomyLevel: true, dryRun: true, actions: true, createdAt: true },
  })
  const bidActionTypes = new Set(['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'bid_apply', 'pause_target', 'enable_target', 'bid'])
  const bidRules = rules.filter((r) => (Array.isArray(r.actions) ? (r.actions as Array<{ type?: string }>) : []).some((a) => bidActionTypes.has(String(a?.type ?? ''))))
  console.log(`advertising rules total: ${rules.length}`)
  console.log(`bid-tab rules: ${bidRules.length}`)
  for (const r of rules) console.log(`  · ${r.name} — trigger=${r.trigger} enabled=${r.enabled} level=${r.autonomyLevel} dryRun=${r.dryRun} actions=${(r.actions as Array<{ type?: string }>).map((a) => a?.type).join(',')}`)

  // 2 — suggestions + templates
  const pending = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
  const templates = await prisma.automationRuleTemplate.groupBy({ by: ['type'], _count: true }).catch(() => [])
  console.log(`\npending suggestions: ${pending}`)
  console.log(`rule templates by type: ${JSON.stringify(templates)}`)

  // 3 — AD_TARGET grain coverage in the settled 14-day window (KEYWORD_HIGH_ACOS shape:
  //     until = now - 2d, since = until - 14d)
  const now = Date.now()
  const until = new Date(now - 2 * 86400_000)
  const since = new Date(until.getTime() - 14 * 86400_000)
  const grain = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['entityType'],
    where: { date: { gte: since, lt: until } },
    _count: true,
  })
  console.log(`\nAmazonAdsDailyPerformance rows by grain, settled 14d [${since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)}):`)
  for (const g of grain) console.log(`  · ${g.entityType}: ${g._count}`)
  const tgt = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'AD_TARGET', date: { gte: since, lt: until } },
    _sum: { clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
  })
  const withClicks = tgt.filter((t) => (t._sum.clicks ?? 0) > 0)
  const withSpendNoSales = tgt.filter((t) => (t._sum.costMicros ?? 0) > 0 && (t._sum.sales7dCents ?? 0) === 0)
  const withAcos = tgt.filter((t) => (t._sum.costMicros ?? 0) > 0 && (t._sum.sales7dCents ?? 0) > 0)
  const matchable = tgt.filter((t) => (t._sum.orders7d ?? 0) > 0 && (t._sum.sales7dCents ?? 0) > 0 && Number(t._sum.costMicros ?? 0) / 10000 >= 200)
  console.log(`AD_TARGET grain: ${tgt.length} distinct targets with any row · ${withClicks.length} with ≥1 click · ${withAcos.length} with a computable ACoS · ${withSpendNoSales.length} spend-but-no-sales · ${matchable.length} pass the HIGH_ACOS emit filter (orders>0 · sales>0 · spend≥€2)`)

  // 4 — CampaignSection payloads
  const campaigns = await prisma.campaign.count().catch(() => -1)
  const campEnabled = await prisma.campaign.count({ where: { status: 'ENABLED' } }).catch(() => -1)
  const adGroups = await prisma.adGroup.count().catch(() => -1)
  console.log(`\ncampaigns (AMAZON): ${campaigns} · ENABLED: ${campEnabled} · ad groups: ${adGroups}`)

  // 5 — bid landscape
  const targets = await prisma.adTarget.findMany({
    where: { status: 'ENABLED', isNegative: false },
    select: { bidCents: true, suppressedFromBidCents: true },
  })
  const atFloor = targets.filter((t) => (t.bidCents ?? 0) <= 3)
  const suppressed = targets.filter((t) => t.suppressedFromBidCents != null)
  console.log(`\nENABLED positive targets: ${targets.length} · ≤3¢: ${atFloor.length} · flagged suppressed: ${suppressed.length}`)
  const bounds = await prisma.campaign.findMany({
    select: { minBidCents: true, maxBidCents: true },
  }).catch(() => [] as Array<{ minBidCents: number | null; maxBidCents: number | null }>)
  console.log(`campaigns with minBidCents: ${bounds.filter((b) => b.minBidCents != null).length} · with maxBidCents: ${bounds.filter((b) => b.maxBidCents != null).length}`)
}

main().finally(() => prisma.$disconnect())
