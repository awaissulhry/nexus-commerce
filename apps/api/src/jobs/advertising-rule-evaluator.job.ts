/**
 * AD.3 — Advertising-domain trigger context builders + cron tick.
 *
 * Lives separately from automation-rule-evaluator.job.ts so the
 * replenishment engine stays unchanged. This file owns the four new
 * triggers:
 *
 *   FBA_AGE_THRESHOLD_REACHED
 *     Per FbaStorageAge row where daysToLtsThreshold <= 30 AND aged
 *     quantity (181-270 + 271-365 + 365+) >= 1. Carries product +
 *     fbaAge + marketplace + projectedFee.
 *
 *   AD_SPEND_PROFITABILITY_BREACH
 *     Per Campaign whose 30d ad spend exceeds the sum of trueProfit
 *     across the products it advertises. Carries campaign + profit
 *     aggregate.
 *
 *   CAC_SPIKE
 *     Per Campaign with acos > 1.0 (= ad spend > attributed sales,
 *     break-even or worse) AND spend > €100. The plan's 7d-vs-30d
 *     comparison would need a campaign-day timeseries we don't have
 *     yet — this simpler threshold gives equivalent operator signal
 *     against today's substrate.
 *
 *   AD_TARGET_UNDERPERFORMING
 *     Per AdTarget with spendCents > €20 AND salesCents = 0 over its
 *     accumulated history. (A finer-grained 14d window awaits a
 *     metrics-day timeseries; same trade-off as CAC_SPIKE.)
 *
 * scopeMarketplace filtering happens here so the engine never sees a
 * context the rule explicitly excluded — saves wasted evaluation passes.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { evaluateAllRulesForTrigger } from '../services/automation-rule.service.js'
import { microsToCents } from '../services/advertising/ads-metrics-math.js'
import cron from 'node-cron'

// Trigger thresholds — env-tunable for testing.
const FBA_AGE_DAYS_LTE = Number(process.env.NEXUS_AD_FBA_AGE_DAYS_LTE ?? 30)
const PROFITABILITY_WINDOW_DAYS = Number(
  process.env.NEXUS_AD_PROFITABILITY_WINDOW_DAYS ?? 30,
)
const CAC_SPIKE_SPEND_MIN_CENTS = Number(
  process.env.NEXUS_AD_CAC_SPIKE_SPEND_MIN_CENTS ?? 10000,
) // €100
const CAC_SPIKE_ACOS_THRESHOLD = Number(process.env.NEXUS_AD_CAC_SPIKE_ACOS ?? 1.0)
const UNDERPERFORM_SPEND_MIN_CENTS = Number(
  process.env.NEXUS_AD_UNDERPERFORM_SPEND_MIN_CENTS ?? 2000,
) // €20

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

interface TickSummary {
  fbaAgeContexts: number
  profitabilityContexts: number
  cacSpikeContexts: number
  underperformContexts: number
  campaignBudgetContexts: number
  totalEvaluations: number
  totalMatches: number
  durationMs: number
}

// ── FBA_AGE_THRESHOLD_REACHED ─────────────────────────────────────────

interface FbaAgeContext {
  trigger: 'FBA_AGE_THRESHOLD_REACHED'
  marketplace: string
  product: {
    id: string | null
    sku: string
    asin: string | null
    productType: string | null
  }
  fbaAge: {
    daysToLtsThreshold: number | null
    quantityInAge0_90: number
    quantityInAge91_180: number
    quantityInAge181_270: number
    quantityInAge271_365: number
    quantityInAge365Plus: number
    projectedLtsFee30dCents: number
    projectedLtsFee60dCents: number
    projectedLtsFee90dCents: number
  }
}

async function buildFbaAgeContexts(): Promise<FbaAgeContext[]> {
  // Latest snapshot per (sku, marketplace) — group by + max(polledAt).
  // Cheap in dev (small N); production gains a materialized view later.
  const candidates = await prisma.fbaStorageAge.findMany({
    where: {
      daysToLtsThreshold: { lte: FBA_AGE_DAYS_LTE, not: null },
      OR: [
        { quantityInAge181_270: { gt: 0 } },
        { quantityInAge271_365: { gt: 0 } },
        { quantityInAge365Plus: { gt: 0 } },
      ],
    },
    orderBy: { polledAt: 'desc' },
    take: 1000,
    select: {
      sku: true,
      asin: true,
      marketplace: true,
      productId: true,
      polledAt: true,
      quantityInAge0_90: true,
      quantityInAge91_180: true,
      quantityInAge181_270: true,
      quantityInAge271_365: true,
      quantityInAge365Plus: true,
      projectedLtsFee30dCents: true,
      projectedLtsFee60dCents: true,
      projectedLtsFee90dCents: true,
      daysToLtsThreshold: true,
    },
  })
  // Dedupe: keep only most-recent row per (sku, marketplace).
  const seen = new Set<string>()
  const out: FbaAgeContext[] = []
  for (const row of candidates) {
    const key = `${row.sku}::${row.marketplace}`
    if (seen.has(key)) continue
    seen.add(key)
    let productType: string | null = null
    if (row.productId) {
      const p = await prisma.product.findUnique({
        where: { id: row.productId },
        select: { productType: true },
      })
      productType = p?.productType ?? null
    }
    out.push({
      trigger: 'FBA_AGE_THRESHOLD_REACHED',
      marketplace: row.marketplace,
      product: {
        id: row.productId,
        sku: row.sku,
        asin: row.asin,
        productType,
      },
      fbaAge: {
        daysToLtsThreshold: row.daysToLtsThreshold,
        quantityInAge0_90: row.quantityInAge0_90,
        quantityInAge91_180: row.quantityInAge91_180,
        quantityInAge181_270: row.quantityInAge181_270,
        quantityInAge271_365: row.quantityInAge271_365,
        quantityInAge365Plus: row.quantityInAge365Plus,
        projectedLtsFee30dCents: row.projectedLtsFee30dCents,
        projectedLtsFee60dCents: row.projectedLtsFee60dCents,
        projectedLtsFee90dCents: row.projectedLtsFee90dCents,
      },
    })
  }
  return out
}

// ── AD_SPEND_PROFITABILITY_BREACH ─────────────────────────────────────

interface ProfitabilityContext {
  trigger: 'AD_SPEND_PROFITABILITY_BREACH'
  marketplace: string | null
  campaign: {
    id: string
    externalCampaignId: string | null
    name: string
    spendCents: number
    salesCents: number
    acos: number | null
    trueProfitCents: number
  }
  profit: {
    trueProfitCents30d: number
    netCents: number // trueProfit - adSpend (negative = breach)
  }
}

async function buildProfitabilityContexts(): Promise<ProfitabilityContext[]> {
  const dayStart = new Date()
  dayStart.setUTCDate(dayStart.getUTCDate() - PROFITABILITY_WINDOW_DAYS)

  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ENABLED' },
    select: {
      id: true,
      name: true,
      externalCampaignId: true,
      marketplace: true,
      spend: true,
      sales: true,
      acos: true,
      trueProfitCents: true,
      adGroups: {
        select: { productAds: { select: { productId: true } } },
      },
    },
  })

  const out: ProfitabilityContext[] = []
  for (const c of campaigns) {
    const spendCents = Math.round(Number(c.spend) * 100)
    if (spendCents === 0) continue
    const productIds = Array.from(
      new Set(
        c.adGroups
          .flatMap((ag) => ag.productAds)
          .map((pa) => pa.productId)
          .filter((id): id is string => !!id),
      ),
    )
    if (productIds.length === 0) continue
    const whereProfit: Record<string, unknown> = {
      productId: { in: productIds },
      date: { gte: dayStart },
    }
    if (c.marketplace) whereProfit.marketplace = c.marketplace
    const agg = await prisma.productProfitDaily.aggregate({
      where: whereProfit,
      _sum: { trueProfitCents: true },
    })
    const trueProfitCents30d = agg._sum.trueProfitCents ?? 0
    const netCents = trueProfitCents30d - spendCents
    if (netCents >= 0) continue // ads still profitable; skip
    out.push({
      trigger: 'AD_SPEND_PROFITABILITY_BREACH',
      marketplace: c.marketplace,
      campaign: {
        id: c.id,
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        spendCents,
        salesCents: Math.round(Number(c.sales) * 100),
        acos: c.acos != null ? Number(c.acos) : null,
        trueProfitCents: c.trueProfitCents,
      },
      profit: { trueProfitCents30d, netCents },
    })
  }
  return out
}

// ── CAC_SPIKE ──────────────────────────────────────────────────────────

interface CacSpikeContext {
  trigger: 'CAC_SPIKE'
  marketplace: string | null
  campaign: {
    id: string
    externalCampaignId: string | null
    name: string
    spendCents: number
    salesCents: number
    acos: number | null
  }
}

async function buildCacSpikeContexts(): Promise<CacSpikeContext[]> {
  const rows = await prisma.campaign.findMany({
    where: {
      status: 'ENABLED',
      acos: { gte: CAC_SPIKE_ACOS_THRESHOLD },
    },
    select: {
      id: true,
      name: true,
      marketplace: true,
      externalCampaignId: true,
      spend: true,
      sales: true,
      acos: true,
    },
  })
  return rows
    .filter((c) => Math.round(Number(c.spend) * 100) >= CAC_SPIKE_SPEND_MIN_CENTS)
    .map((c) => ({
      trigger: 'CAC_SPIKE' as const,
      marketplace: c.marketplace,
      campaign: {
        id: c.id,
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        spendCents: Math.round(Number(c.spend) * 100),
        salesCents: Math.round(Number(c.sales) * 100),
        acos: c.acos != null ? Number(c.acos) : null,
      },
    }))
}

// ── AD_TARGET_UNDERPERFORMING ─────────────────────────────────────────

interface UnderperformContext {
  trigger: 'AD_TARGET_UNDERPERFORMING'
  marketplace: string | null
  adTarget: {
    id: string
    externalTargetId: string | null
    kind: string
    expressionValue: string
    bidCents: number
    spendCents: number
    salesCents: number
  }
  adGroup: { id: string; name: string }
  campaign: { id: string; name: string }
}

async function buildUnderperformContexts(): Promise<UnderperformContext[]> {
  const rows = await prisma.adTarget.findMany({
    where: {
      status: 'ENABLED',
      spendCents: { gte: UNDERPERFORM_SPEND_MIN_CENTS },
      salesCents: 0,
    },
    select: {
      id: true,
      externalTargetId: true,
      kind: true,
      expressionValue: true,
      bidCents: true,
      spendCents: true,
      salesCents: true,
      adGroup: {
        select: {
          id: true,
          name: true,
          campaign: { select: { id: true, name: true, marketplace: true } },
        },
      },
    },
  })
  return rows.map((t) => ({
    trigger: 'AD_TARGET_UNDERPERFORMING' as const,
    marketplace: t.adGroup?.campaign?.marketplace ?? null,
    adTarget: {
      id: t.id,
      externalTargetId: t.externalTargetId,
      kind: t.kind,
      expressionValue: t.expressionValue,
      bidCents: t.bidCents,
      spendCents: t.spendCents,
      salesCents: t.salesCents,
    },
    adGroup: { id: t.adGroup.id, name: t.adGroup.name },
    campaign: { id: t.adGroup.campaign.id, name: t.adGroup.campaign.name },
  }))
}

// ── Cron tick ──────────────────────────────────────────────────────────

async function applyMarketplaceScope<C extends { marketplace: string | null }>(
  trigger: string,
  contexts: C[],
  forceDryRun = false,
): Promise<{ evaluations: number; matches: number }> {
  let evaluations = 0
  let matches = 0
  for (const ctx of contexts) {
    // scopeMarketplace filter is enforced when querying the rule list:
    // we pre-fetch rules and skip contexts whose marketplace doesn't
    // match the rule's scopeMarketplace setting.
    const rules = await prisma.automationRule.findMany({
      where: {
        domain: 'advertising',
        trigger,
        enabled: true,
        OR: [{ scopeMarketplace: null }, { scopeMarketplace: ctx.marketplace }],
      },
      select: { id: true },
    })
    if (rules.length === 0) continue
    const results = await evaluateAllRulesForTrigger({
      domain: 'advertising',
      trigger,
      context: ctx,
      forceDryRun,
    })
    evaluations += results.length
    matches += results.filter((r) => r.matched).length
  }
  return { evaluations, matches }
}

// ── CAMPAIGN_PERFORMANCE_BUDGET (AME.12) ──────────────────────────────
// Performance/ROAS-guardrail budget rules. Yields every enabled campaign with
// its windowed ROAS/ACOS (from the daily table — accurate, not the stale stored
// columns) + budget utilisation, so a rule can raise the daily budget on
// winners that are budget-capped and trim losers. The adjust_ad_budget action +
// per-rule guardrails (maxValueCentsEur, dryRun) do the rest.
const BUDGET_RULE_WINDOW_DAYS = 7

interface CampaignBudgetContext {
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET'
  marketplace: string | null
  campaign: {
    id: string; externalCampaignId: string | null; name: string
    dailyBudgetCents: number; spendCents: number; salesCents: number
    acos: number | null; roas: number | null
    avgDailySpendCents: number; budgetUtilization: number | null
  }
}

async function buildCampaignBudgetContexts(): Promise<CampaignBudgetContext[]> {
  const since = new Date(); since.setUTCDate(since.getUTCDate() - BUDGET_RULE_WINDOW_DAYS); since.setUTCHours(0, 0, 0, 0)
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ENABLED' },
    select: { id: true, name: true, externalCampaignId: true, marketplace: true, dailyBudget: true },
  })
  if (campaigns.length === 0) return []
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, date: { gte: since } },
    _sum: { costMicros: true, sales7dCents: true, sales14dCents: true },
  })
  const byId = new Map(perf.map((p) => [p.localEntityId!, p]))
  const out: CampaignBudgetContext[] = []
  for (const c of campaigns) {
    const p = byId.get(c.id)
    const spendCents = microsToCents(p?._sum.costMicros)
    if (spendCents === 0) continue
    const salesCents = (p?._sum.sales7dCents ?? 0) + (p?._sum.sales14dCents ?? 0)
    const dailyBudgetCents = Math.round(Number(c.dailyBudget) * 100)
    const avgDailySpendCents = Math.round(spendCents / BUDGET_RULE_WINDOW_DAYS)
    out.push({
      trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
      marketplace: c.marketplace,
      campaign: {
        id: c.id, externalCampaignId: c.externalCampaignId, name: c.name,
        dailyBudgetCents, spendCents, salesCents,
        acos: salesCents > 0 ? spendCents / salesCents : null,
        roas: spendCents > 0 ? salesCents / spendCents : null,
        avgDailySpendCents,
        budgetUtilization: dailyBudgetCents > 0 ? avgDailySpendCents / dailyBudgetCents : null,
      },
    })
  }
  return out
}

// ── KEYWORD_ZERO_IMPRESSIONS ──────────────────────────────────────────
// ENABLED keywords that spent money but got ZERO impressions in the last 7
// days — signals delivery failure (suppressed listing, bad targeting, etc.)
async function buildZeroImpressionContexts() {
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 7); since.setUTCHours(0, 0, 0, 0)
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'KEYWORD', date: { gte: since }, costMicros: { gt: 0n } },
    _sum: { impressions: true, costMicros: true },
    having: { impressions: { _sum: { equals: 0 } } },
  })
  return perf.slice(0, 500).map((p) => ({
    trigger: 'KEYWORD_ZERO_IMPRESSIONS' as const,
    marketplace: p.marketplace,
    adTarget: { id: p.localEntityId, spendCents: microsToCents(p._sum.costMicros), impressions: 0 },
  }))
}

// ── KEYWORD_LOW_CTR ───────────────────────────────────────────────────
// Keywords with >500 impressions but CTR < 0.2% — poor relevance or bad
// creative. Signal to lower bids (fewer irrelevant impressions = better ACOS).
const LOW_CTR_THRESHOLD = Number(process.env.NEXUS_LOW_CTR_THRESHOLD ?? 0.002)
const LOW_CTR_MIN_IMPRESSIONS = Number(process.env.NEXUS_LOW_CTR_MIN_IMPR ?? 500)
async function buildLowCtrContexts() {
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'KEYWORD', date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true },
  })
  return perf
    .filter((p) => (p._sum.impressions ?? 0) >= LOW_CTR_MIN_IMPRESSIONS && (p._sum.clicks ?? 0) / (p._sum.impressions ?? 1) < LOW_CTR_THRESHOLD)
    .slice(0, 300)
    .map((p) => ({
      trigger: 'KEYWORD_LOW_CTR' as const,
      marketplace: p.marketplace,
      adTarget: {
        id: p.localEntityId,
        impressions: p._sum.impressions ?? 0,
        clicks: p._sum.clicks ?? 0,
        ctr: (p._sum.clicks ?? 0) / Math.max(1, p._sum.impressions ?? 1),
        spendCents: microsToCents(p._sum.costMicros),
      },
    }))
}

// ── CVR_DROP ──────────────────────────────────────────────────────────
// Keywords where conversion rate dropped >40% week-over-week. Could signal
// review score drop, competitor price cut, or listing degradation.
async function buildCvrDropContexts() {
  const thisWeekStart = new Date(); thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - 7); thisWeekStart.setUTCHours(0, 0, 0, 0)
  const prevWeekStart = new Date(thisWeekStart); prevWeekStart.setUTCDate(thisWeekStart.getUTCDate() - 7)
  const [thisWeek, prevWeek] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'marketplace'], where: { entityType: 'KEYWORD', date: { gte: thisWeekStart }, clicks: { gt: 0 } }, _sum: { clicks: true, orders7d: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'marketplace'], where: { entityType: 'KEYWORD', date: { gte: prevWeekStart, lt: thisWeekStart }, clicks: { gt: 0 } }, _sum: { clicks: true, orders7d: true } }),
  ])
  const prevMap = new Map(prevWeek.map((p) => [p.localEntityId, { cvr: (p._sum.orders7d ?? 0) / Math.max(1, p._sum.clicks ?? 1) }]))
  return thisWeek
    .filter((p) => {
      const prev = prevMap.get(p.localEntityId); if (!prev || prev.cvr < 0.005) return false
      const thisCvr = (p._sum.orders7d ?? 0) / Math.max(1, p._sum.clicks ?? 1)
      return thisCvr < prev.cvr * 0.6 // dropped >40%
    })
    .slice(0, 200)
    .map((p) => ({
      trigger: 'CVR_DROP' as const,
      marketplace: p.marketplace,
      adTarget: {
        id: p.localEntityId,
        currentCvr: (p._sum.orders7d ?? 0) / Math.max(1, p._sum.clicks ?? 1),
        previousCvr: prevMap.get(p.localEntityId)?.cvr ?? 0,
        clicks: p._sum.clicks ?? 0,
      },
    }))
}

// ── KEYWORD_WASTED_SPEND ──────────────────────────────────────────────
// Individual ad targets (keywords) with spend above the threshold and ZERO
// orders in the window — more granular and faster than the daily harvest cron.
const WASTE_MIN_SPEND = Number(process.env.NEXUS_WASTE_MIN_SPEND_CENTS ?? 500) // €5 default
async function buildWastedKeywordContexts() {
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'KEYWORD', date: { gte: since } },
    _sum: { costMicros: true, orders7d: true, clicks: true },
  })
  return perf
    .filter((p) => microsToCents(p._sum.costMicros) >= WASTE_MIN_SPEND && (p._sum.orders7d ?? 0) === 0 && (p._sum.clicks ?? 0) >= 5)
    .slice(0, 400)
    .map((p) => ({
      trigger: 'KEYWORD_WASTED_SPEND' as const,
      marketplace: p.marketplace,
      adTarget: { id: p.localEntityId, spendCents: microsToCents(p._sum.costMicros), orders: 0, clicks: p._sum.clicks ?? 0 },
    }))
}

// ── SEARCH_TERM_CONVERTING ────────────────────────────────────────────
// Search terms from auto/broad campaigns with 2+ orders — prime candidates
// for exact-match promotion. Powers the match-type migration automation.
const CONVERTING_MIN_ORDERS = Number(process.env.NEXUS_CONVERTING_MIN_ORDERS ?? 2)
async function buildSearchTermConvertingContexts() {
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)
  const terms = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
    where: { date: { gte: since }, matchType: { in: ['BROAD', 'PHRASE', null] } },
    _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
    having: { orders7d: { _sum: { gte: CONVERTING_MIN_ORDERS } } },
  })
  return terms.slice(0, 300).map((t) => ({
    trigger: 'SEARCH_TERM_CONVERTING' as const,
    marketplace: t.marketplace,
    searchTerm: {
      query: t.query,
      externalCampaignId: t.campaignId,
      externalAdGroupId: t.adGroupId,
      orders: t._sum.orders7d ?? 0,
      clicks: t._sum.clicks ?? 0,
      spendCents: microsToCents(t._sum.costMicros),
      salesCents: t._sum.sales7dCents ?? 0,
    },
  }))
}

// ══════════════════════════════════════════════════════════════════════
// Engine expansion (E-series) — net-new triggers, added additively. Each
// builder is wrapped in try/catch returning [] so a new signal can NEVER
// break the existing evaluator tick. New triggers are inert until an operator
// enables a rule that uses them (applyMarketplaceScope skips a trigger with no
// enabled rules), so adding them is safe by construction.
// ══════════════════════════════════════════════════════════════════════

// ── KEYWORD_HIGH_ACOS (E1) ────────────────────────────────────────────
// Keywords that DO convert but at an inefficient ACOS. Distinct from
// KEYWORD_WASTED_SPEND (zero orders) and CAC_SPIKE (campaign-level): these are
// profitable-but-leaky converters a rule can bid down toward target.
async function buildHighAcosKeywordContexts() {
  try {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'KEYWORD', date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    })
    return perf
      .map((p) => ({ p, spend: microsToCents(p._sum.costMicros), sales: p._sum.sales7dCents ?? 0, orders: p._sum.orders7d ?? 0 }))
      .filter((x) => x.orders > 0 && x.sales > 0 && x.spend >= 200 && x.spend / x.sales >= 0.2)
      .sort((a, b) => (b.spend / b.sales) - (a.spend / a.sales))
      .slice(0, 500)
      .map(({ p, spend, sales, orders }) => ({
        trigger: 'KEYWORD_HIGH_ACOS' as const,
        marketplace: p.marketplace,
        adTarget: { id: p.localEntityId, spendCents: spend, salesCents: sales, orders, acos: spend / sales },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildHighAcosKeywordContexts failed', { error: (e as Error).message }); return [] }
}

// ── KEYWORD_SCALE_OPPORTUNITY (E2) ────────────────────────────────────
// Proven winners (strong ROAS + real orders) with headroom to scale — pair
// with bid_up to win more of a profitable term.
async function buildScaleOpportunityContexts() {
  try {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'KEYWORD', date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true },
    })
    return perf
      .map((p) => ({ p, spend: microsToCents(p._sum.costMicros), sales: p._sum.sales7dCents ?? 0, orders: p._sum.orders7d ?? 0 }))
      .filter((x) => x.orders >= 1 && x.spend > 0 && x.sales / x.spend >= 2)
      .sort((a, b) => (b.sales / b.spend) - (a.sales / a.spend))
      .slice(0, 400)
      .map(({ p, spend, sales, orders }) => ({
        trigger: 'KEYWORD_SCALE_OPPORTUNITY' as const,
        marketplace: p.marketplace,
        adTarget: { id: p.localEntityId, spendCents: spend, salesCents: sales, orders, roas: sales / spend, clicks: p._sum.clicks ?? 0 },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildScaleOpportunityContexts failed', { error: (e as Error).message }); return [] }
}

// ── AD_GROUP_UNDERPERFORMING (E3) ─────────────────────────────────────
// Ad-group-level spend with poor return — a coarser lens than per-keyword,
// for operators who manage at the ad-group level. Pairs with pause_ad_group
// or bid_down (target: ad_group).
async function buildAdGroupUnderperformContexts() {
  try {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'AD_GROUP', date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    })
    return perf
      .map((p) => ({ p, spend: microsToCents(p._sum.costMicros), sales: p._sum.sales7dCents ?? 0, orders: p._sum.orders7d ?? 0 }))
      .filter((x) => x.spend >= 500 && (x.sales === 0 || x.spend / x.sales >= 0.4))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 300)
      .map(({ p, spend, sales, orders }) => ({
        trigger: 'AD_GROUP_UNDERPERFORMING' as const,
        marketplace: p.marketplace,
        adGroup: { id: p.localEntityId, spendCents: spend, salesCents: sales, orders, acos: sales > 0 ? spend / sales : null },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildAdGroupUnderperformContexts failed', { error: (e as Error).message }); return [] }
}

// ── NEW_TO_BRAND_WINNER (E4) ──────────────────────────────────────────
// Campaigns acquiring new-to-brand customers (ntbOrders14d) — worth scaling
// for brand growth, a signal nothing else triggers on. Pairs with adjust_ad_budget.
async function buildNewToBrandWinnerContexts() {
  try {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 14); since.setUTCHours(0, 0, 0, 0)
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
    if (campaigns.length === 0) return []
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, date: { gte: since } },
      _sum: { ntbOrders14d: true, ntbSalesCents14d: true, costMicros: true },
    })
    const byId = new Map(perf.map((p) => [p.localEntityId!, p]))
    return campaigns
      .map((c) => ({ c, p: byId.get(c.id) }))
      .filter((x) => !!x.p && (x.p._sum.ntbOrders14d ?? 0) >= 1)
      .slice(0, 200)
      .map(({ c, p }) => ({
        trigger: 'NEW_TO_BRAND_WINNER' as const,
        marketplace: c.marketplace,
        campaign: { id: c.id, externalCampaignId: c.externalCampaignId, name: c.name, ntbOrders: p!._sum.ntbOrders14d ?? 0, ntbSalesCents: p!._sum.ntbSalesCents14d ?? 0, spendCents: microsToCents(p!._sum.costMicros) },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildNewToBrandWinnerContexts failed', { error: (e as Error).message }); return [] }
}

// ── CAMPAIGN_NO_SALES (E5) ────────────────────────────────────────────
// Campaigns spending over the window with ZERO attributed sales — dead spend
// at the campaign level (coarser than per-target underperformance).
async function buildCampaignNoSalesContexts() {
  try {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
    if (campaigns.length === 0) return []
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true, sales14dCents: true },
    })
    const byId = new Map(perf.map((p) => [p.localEntityId!, p]))
    return campaigns
      .map((c) => ({ c, p: byId.get(c.id) }))
      .filter((x) => { if (!x.p) return false; const spend = microsToCents(x.p._sum.costMicros); const sales = (x.p._sum.sales7dCents ?? 0) + (x.p._sum.sales14dCents ?? 0); return spend >= 1000 && sales === 0 })
      .slice(0, 200)
      .map(({ c, p }) => ({
        trigger: 'CAMPAIGN_NO_SALES' as const,
        marketplace: c.marketplace,
        campaign: { id: c.id, externalCampaignId: c.externalCampaignId, name: c.name, spendCents: microsToCents(p!._sum.costMicros), salesCents: 0 },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildCampaignNoSalesContexts failed', { error: (e as Error).message }); return [] }
}

export async function runAdvertisingRuleEvaluatorOnce(): Promise<TickSummary> {
  const startedAt = Date.now()
  // AME.14 — global kill-switch. When set, NO advertising rule auto-applies
  // (the ultimate safety; per-rule enabled/dryRun guardrails are the finer
  // controls). Operable from Railway env or flipped via /autonomy/pause-all.
  if (process.env.NEXUS_ADS_AUTOMATION_KILL === '1') {
    logger.warn('[ads-rule-evaluator] global kill-switch active — skipping all rule evaluation')
    return { fbaAgeContexts: 0, profitabilityContexts: 0, cacSpikeContexts: 0, underperformContexts: 0, campaignBudgetContexts: 0, totalEvaluations: 0, totalMatches: 0, durationMs: Date.now() - startedAt }
  }
  // TD.0 — runtime halt (circuit-breaker / operator) + OFF autonomy dial, set
  // via AdsAutomationState without a redeploy. Same effect as the env kill.
  // TD.0 — SUGGEST autonomy forces every rule to dry-run (propose only) this
  // tick, regardless of each rule's own dryRun flag.
  let forceDryRun = false
  try {
    const { isAutomationHalted, shouldForceDryRun } = await import('../services/advertising/ads-automation-state.service.js')
    if (await isAutomationHalted()) {
      logger.warn('[ads-rule-evaluator] automation halted (AdsAutomationState) — skipping all rule evaluation')
      return { fbaAgeContexts: 0, profitabilityContexts: 0, cacSpikeContexts: 0, underperformContexts: 0, campaignBudgetContexts: 0, totalEvaluations: 0, totalMatches: 0, durationMs: Date.now() - startedAt }
    }
    forceDryRun = await shouldForceDryRun()
  } catch { /* state unavailable → fall through (env kill remains the backstop) */ }
  const [fbaAge, profitability, cacSpike, underperform, campaignBudget,
    zeroImpression, lowCtr, cvrDrop, wastedKeyword, searchTermConverting,
    highAcosKeyword, scaleOpportunity, adGroupUnderperform,
    newToBrandWinner, campaignNoSales] = await Promise.all([
    buildFbaAgeContexts(),
    buildProfitabilityContexts(),
    buildCacSpikeContexts(),
    buildUnderperformContexts(),
    buildCampaignBudgetContexts(),
    // ── New precision triggers ─────────────────────────────────────────
    buildZeroImpressionContexts(),
    buildLowCtrContexts(),
    buildCvrDropContexts(),
    buildWastedKeywordContexts(),
    buildSearchTermConvertingContexts(),
    // ── Engine expansion (E-series) — net-new triggers ─────────────────
    buildHighAcosKeywordContexts(),
    buildScaleOpportunityContexts(),
    buildAdGroupUnderperformContexts(),
    buildNewToBrandWinnerContexts(),
    buildCampaignNoSalesContexts(),
  ])

  // AU.1/AU.2/AU.4 — SCHEDULE trigger: one context per active marketplace each
  // tick. Includes budget.monthlySpendCents so budget-cap rules can fire.
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
  const marketplaces = [...new Set(conns.map((c) => c.marketplace))]
  const now = new Date(); const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthlySpendByMkt = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['marketplace'],
    where: { entityType: 'CAMPAIGN', date: { gte: monthStart } },
    _sum: { costMicros: true },
  })
  const spendMap = new Map(monthlySpendByMkt.map((r) => [r.marketplace, microsToCents(r._sum.costMicros)]))
  const scheduleContexts = marketplaces.map((mkt) => ({
    trigger: 'SCHEDULE' as const,
    marketplace: mkt,
    budget: { monthlySpendCents: spendMap.get(mkt) ?? 0 },
  }))

  let totalEvaluations = 0
  let totalMatches = 0
  const passes: Array<[string, Array<{ marketplace: string | null }>]> = [
    ['FBA_AGE_THRESHOLD_REACHED', fbaAge],
    ['AD_SPEND_PROFITABILITY_BREACH', profitability],
    ['CAC_SPIKE', cacSpike],
    ['AD_TARGET_UNDERPERFORMING', underperform],
    ['CAMPAIGN_PERFORMANCE_BUDGET', campaignBudget],
    ['KEYWORD_ZERO_IMPRESSIONS', zeroImpression],
    ['KEYWORD_LOW_CTR', lowCtr],
    ['CVR_DROP', cvrDrop],
    ['KEYWORD_WASTED_SPEND', wastedKeyword],
    ['SEARCH_TERM_CONVERTING', searchTermConverting],
    ['KEYWORD_HIGH_ACOS', highAcosKeyword],
    ['KEYWORD_SCALE_OPPORTUNITY', scaleOpportunity],
    ['AD_GROUP_UNDERPERFORMING', adGroupUnderperform],
    ['NEW_TO_BRAND_WINNER', newToBrandWinner],
    ['CAMPAIGN_NO_SALES', campaignNoSales],
    ['SCHEDULE', scheduleContexts],
  ]
  for (const [trigger, contexts] of passes) {
    const r = await applyMarketplaceScope(trigger, contexts, forceDryRun)
    totalEvaluations += r.evaluations
    totalMatches += r.matches
  }

  const summary: TickSummary = {
    fbaAgeContexts: fbaAge.length,
    profitabilityContexts: profitability.length,
    cacSpikeContexts: cacSpike.length,
    underperformContexts: underperform.length,
    campaignBudgetContexts: campaignBudget.length,
    totalEvaluations,
    totalMatches,
    durationMs: Date.now() - startedAt,
  }
  lastRunAt = new Date()
  lastSummary = `fba=${fbaAge.length} prof=${profitability.length} cac=${cacSpike.length} under=${underperform.length} schedule=${scheduleContexts.length} evals=${totalEvaluations} matches=${totalMatches} durationMs=${summary.durationMs}`
  return summary
}

export async function runAdvertisingRuleEvaluatorCron(): Promise<void> {
  try {
    await recordCronRun('advertising-rule-evaluator', async () => {
      const summary = await runAdvertisingRuleEvaluatorOnce()
      logger.info('advertising-rule-evaluator cron: completed', { summary })
      return lastSummary ?? 'no-summary'
    })
  } catch (err) {
    logger.error('advertising-rule-evaluator cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAdvertisingRuleEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('advertising-rule-evaluator cron already started')
    return
  }
  const schedule = process.env.NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*/15 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('advertising-rule-evaluator cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runAdvertisingRuleEvaluatorCron()
  })
  logger.info('advertising-rule-evaluator cron: scheduled', { schedule })
}

export function stopAdvertisingRuleEvaluatorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getAdvertisingRuleEvaluatorStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return { scheduled: scheduledTask != null, lastRunAt, lastSummary }
}
