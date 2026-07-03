/**
 * ER3.3 — dashboard aggregate: the Recommendations panel (Teika-style
 * transparent eligibility — every row states its criteria and carries real
 * counts/samples from live queries) + the budget-pacing block. Read-only;
 * every CTA lands on an existing surface where writes are already gated.
 */
import prisma from '../../db.js'
import { checkSpendCeilings } from './ebay-ads-automation.service.js'

export interface RecommendationRow {
  type: 'unmatched_listings' | 'missing_costs' | 'unpromoted_listings' | 'campaigns_without_rules' | 'rates_above_breakeven'
  count: number
  title: string
  criteria: string
  samples: string[] // ≤3 entity names/ids
  cta: { label: string; href: string }
}

export interface PacingPayload {
  ceilings: Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number; projectedCents: number }>
  cpc: { campaigns: number; dailyBudgetCents: number; ydayFeesCents: number; utilizationPct: number | null; limitedCount: number }
  asOf: string
}

/** Pure — straight-line month-end projection from month-to-date spend. */
export function projectMonthEnd(mtdCents: number, now = new Date()): number {
  const dayOfMonth = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  if (dayOfMonth <= 0) return mtdCents
  return Math.round((mtdCents / dayOfMonth) * daysInMonth)
}

/** Pure — yesterday's CPC fees as % of the summed daily budgets. */
export function budgetUtilizationPct(ydayFeesCents: number, dailyBudgetCents: number): number | null {
  if (dailyBudgetCents <= 0) return null
  return Math.round((ydayFeesCents / dailyBudgetCents) * 1000) / 10
}

export async function getEbayAdsDashboard(): Promise<{ recommendations: RecommendationRow[]; pacing: PacingPayload }> {
  const yday = new Date(); yday.setUTCDate(yday.getUTCDate() - 1); yday.setUTCHours(0, 0, 0, 0)

  const [promotedAds, liveCount, runningCampaigns, enabledRules, coverageProposal, ceilings] = await Promise.all([
    // non-stale ads of active CPS/CPC campaigns — the "promoted" universe
    prisma.ebayAd.findMany({
      where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { status: { in: ['RUNNING', 'PAUSED'] } } },
      select: { listingId: true, bidPercentage: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, fundingModel: true, bidPercentage: true } } },
    }),
    prisma.ebayListingIndex.count({ where: { endedAt: null } }),
    prisma.ebayCampaign.findMany({ where: { status: 'RUNNING' }, select: { id: true, externalCampaignId: true, name: true, marketplace: true, fundingModel: true, dailyBudget: true } }),
    prisma.ebayAdsRule.findMany({ where: { enabled: true }, select: { marketplace: true, scope: true } }),
    prisma.ebayAdsProposal.findFirst({ where: { proposedKey: 'coverage:enroll-catch-all', status: 'PENDING' }, select: { id: true } }),
    checkSpendCeilings(),
  ])

  const promotedListingIds = [...new Set(promotedAds.map((a) => a.listingId!))]
  const [idx, eco] = await Promise.all([
    prisma.ebayListingIndex.findMany({ where: { itemId: { in: promotedListingIds } }, select: { itemId: true, title: true, productIds: true, matchStatus: true } }),
    prisma.ebayListingEconomics.findMany({ where: { itemId: { in: promotedListingIds } }, select: { itemId: true, dataStatus: true, breakEvenAdRatePct: true } }),
  ])
  const idxBy = new Map(idx.map((l) => [l.itemId, l]))
  const ecoBy = new Map(eco.map((e) => [e.itemId, e]))
  const titleOf = (listingId: string) => idxBy.get(listingId)?.title ?? listingId

  // 1 · unmatched promoted listings (no product linked → no margin substrate)
  const unmatched = promotedListingIds.filter((id) => { const l = idxBy.get(id); return l != null && (l.productIds ?? []).length === 0 })

  // 2 · promoted listings without product cost (break-even unknown)
  const missingCost = promotedListingIds.filter((id) => ecoBy.get(id)?.dataStatus === 'MISSING_COGS')

  // 3 · live listings not promoted in any active General campaign
  const promotedCps = new Set(promotedAds.filter((a) => a.campaign.fundingModel === 'COST_PER_SALE').map((a) => a.listingId!))
  const unpromotedCount = Math.max(0, liveCount - promotedCps.size)

  // 4 · RUNNING campaigns no enabled rule covers (ER3.1 scope semantics)
  const ruleCountFor = (id: string, marketplace: string) => enabledRules.filter((r0) => {
    const scoped = ((r0.scope as { campaignIds?: string[] } | null)?.campaignIds ?? []).filter(Boolean)
    return scoped.length ? scoped.includes(id) : (!r0.marketplace || r0.marketplace === marketplace)
  }).length
  const withoutRules = runningCampaigns.filter((c) => ruleCountFor(c.id, c.marketplace) === 0)

  // 5 · effective ad rate above the listing's break-even (margin-losing)
  const overBe: Array<{ listingId: string; campaignName: string; rate: number; be: number }> = []
  for (const a of promotedAds) {
    if (a.campaign.fundingModel !== 'COST_PER_SALE' || a.campaign.status !== 'RUNNING') continue
    const rate = a.bidPercentage != null ? Number(a.bidPercentage.toString()) : a.campaign.bidPercentage != null ? Number(a.campaign.bidPercentage.toString()) : null
    const be = ecoBy.get(a.listingId!)?.breakEvenAdRatePct
    if (rate == null || be == null) continue
    const beN = Number(be.toString())
    if (rate > beN + 0.05) overBe.push({ listingId: a.listingId!, campaignName: a.campaign.name, rate, be: beN })
  }

  const recommendations: RecommendationRow[] = [
    {
      type: 'unmatched_listings', count: unmatched.length,
      title: 'Promoted listings without a product match',
      criteria: 'Listings in active campaigns whose index row links to no Nexus product — no cost, no break-even, no margin telemetry.',
      samples: unmatched.slice(0, 3).map(titleOf),
      cta: { label: 'Match products', href: '/marketing/ads/ebay/products' },
    },
    {
      type: 'missing_costs', count: missingCost.length,
      title: 'Promoted listings without product cost',
      criteria: 'Matched listings in active campaigns with no costPrice/WAC — break-even unknown, automation stays manual-only for them.',
      samples: missingCost.slice(0, 3).map(titleOf),
      cta: { label: 'Enter costs', href: '/marketing/ads/ebay/products' },
    },
    {
      type: 'unpromoted_listings', count: unpromotedCount,
      title: 'Live listings not promoted anywhere',
      criteria: 'Live inventory in no active General campaign — zero ad coverage; the coverage guard can enroll them at break-even-anchored rates.',
      samples: [],
      cta: coverageProposal
        ? { label: 'Review enrollment suggestion', href: '/marketing/ads/ebay/automation' }
        : { label: 'Start a catch-all campaign', href: '/marketing/ads/ebay/campaigns/new/general' },
    },
    {
      type: 'campaigns_without_rules', count: withoutRules.length,
      title: 'Running campaigns with no automation rule',
      criteria: 'RUNNING campaigns no enabled rule covers (globally or by binding) — fee creep and bleeders go unwatched.',
      samples: withoutRules.slice(0, 3).map((c) => c.name),
      cta: { label: 'Add a rule', href: '/marketing/ads/ebay/automation/rules/new' },
    },
    {
      type: 'rates_above_breakeven', count: overBe.length,
      title: 'Ad rates above break-even',
      criteria: 'ACTIVE ads in running CPS campaigns whose effective rate exceeds the listing break-even — every attributed sale loses margin.',
      samples: overBe.slice(0, 3).map((o) => `${titleOf(o.listingId)} (${o.rate}% vs BE ${o.be}%)`),
      cta: { label: 'Repair via rule', href: '/marketing/ads/ebay/automation/rules/new?template=Rate%20above%20break-even%20%E2%80%94%20repair%20(CPS)' },
    },
  ]

  // ── pacing ──────────────────────────────────────────────────────────────────
  const cpcRunning = runningCampaigns
    .filter((c) => c.fundingModel === 'COST_PER_CLICK' && c.dailyBudget != null)
    .map((c) => ({ ...c, budgetCents: Math.round(Number(c.dailyBudget!.toString()) * 100) }))
  const cpcExtIds = cpcRunning.map((c) => c.externalCampaignId)
  const ydayFacts = cpcExtIds.length
    ? await prisma.ebayAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', entityId: { in: cpcExtIds }, date: yday }, _sum: { adFeesCents: true } })
    : []
  const ydayBy = new Map(ydayFacts.map((f) => [f.entityId, f._sum.adFeesCents ?? 0]))
  const dailyBudgetCents = cpcRunning.reduce((s, c) => s + c.budgetCents, 0)
  const ydayFeesCents = cpcRunning.reduce((s, c) => s + (ydayBy.get(c.externalCampaignId) ?? 0), 0)
  const limitedCount = cpcRunning.filter((c) => (ydayBy.get(c.externalCampaignId) ?? 0) >= c.budgetCents * 0.9).length

  return {
    recommendations,
    pacing: {
      ceilings: ceilings.map((cl) => ({ marketplace: cl.marketplace, mtdCents: cl.mtdCents, capCents: cl.capCents, pct: cl.pct, projectedCents: projectMonthEnd(cl.mtdCents) })),
      cpc: { campaigns: cpcRunning.length, dailyBudgetCents, ydayFeesCents, utilizationPct: budgetUtilizationPct(ydayFeesCents, dailyBudgetCents), limitedCount },
      asOf: new Date().toISOString(),
    },
  }
}
