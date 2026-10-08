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
import { addLeverSkipCounts, leverSkipNote, type LeverSkipCounts } from '../services/advertising/brain/engine-skips.js'
import { evaluateAllRulesForTrigger } from '../services/automation-rule.service.js'
import { contextIdentity, ruleMatchesScope } from '../services/automation-rule-scope.js'
import { microsToCents } from '../services/ads-core/metrics-math.js'
import cron from '../lib/cron/clustered.js'
import { settledWhere } from '../services/advertising/ads-settled-window.js'
import { BID_WINDOW_MAX, BID_WINDOW_MIN, HIGH_ACOS_FLOOR, TARGET_PERFORMANCE_FLOOR, TRIGGER_WINDOW, WASTING_FLOOR } from '@nexus/shared/ads-rule-window'
import type { AdWriteEvidence } from '../services/advertising/ads-evidence.js'
// PLC-P7 — the report-label join and the three lane enums, from the leaf module that owns them.
import { REPORT_LABEL_TO_PLACEMENT, PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } from '../services/advertising/ads-placement-math.js'
import { adSalesCents } from '../services/ads-core/ad-sales.js'
import { KT6_SUPPRESSION_CENTS } from '../services/advertising/kt6-bid-action.js'
import { KEYWORD_RANK_MAX_AGE_DAYS } from '../services/advertising/keyword-rank-feed.service.js'

/**
 * B2 (2026-08-20) — each trigger's window now comes from `@nexus/shared/ads-rule-window`, which
 * is the SAME table the Rules & Automation grid's Lookback column reads.
 *
 * 🔴 The point is the direction. A window map that only the UI consults is a surface rendering
 * what no executor obeys — the failure class this section has shipped repeatedly. Here the engine
 * is the reader: change `TRIGGER_WINDOW.KEYWORD_LOW_CTR.days` and this job's query moves with it,
 * so the number an operator is shown and the number the rule ran on cannot disagree.
 *
 * Every value was transcribed from the literal that used to sit at each call site, then diffed —
 * the day this shipped, all twelve queries covered exactly the same dates as before.
 *
 * Throws rather than defaulting: a silent fallback would let a typo'd trigger key quietly run on
 * some other window, which is the same silent-wrong-number problem one level down.
 */
const WINDOW = (trigger: string): number => {
  const spec = TRIGGER_WINDOW[trigger]
  if (!spec || spec.days == null) {
    throw new Error(
      `[ads-rule-evaluator] no window for trigger "${trigger}" in @nexus/shared/ads-rule-window. ` +
      'Add it there — do not inline a number here, or the grid and the engine will disagree.',
    )
  }
  return spec.days
}

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
  // ADX.1 — outcome counts so a failing engine is visible in the cron summary.
  totalCapped: number
  totalFailed: number
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
    /** KT-P/C1 — OPTIONAL, not nullable: a null ACoS reads as 0 to `applyOperator`. */
    acos?: number
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
        // KT-P/C1 — absent, not null: a null ACoS reads as 0 to `applyOperator` and matches `lte`.
        ...measured({ acos: c.acos != null ? Number(c.acos) : null }),
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
    /** KT-P/C1 — OPTIONAL, not nullable: a null ACoS reads as 0 to `applyOperator`. */
    acos?: number
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
        // KT-P/C1 — absent, not null (see EMPTY_TARGET_PERF).
        ...measured({ acos: c.acos != null ? Number(c.acos) : null }),
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
  /**
   * ADX A2 — the measurement that made this a match, stated by the builder that made it.
   *
   * The trigger knows its own metric, threshold and window; the action handler does not
   * and would have to guess. Declaring it here means a bid cut can be read later as
   * "spend without sales 412 vs 200 over 14d" instead of only "bid_down 20% via rule".
   */
  evidence: AdWriteEvidence
}

async function buildUnderperformContexts(): Promise<UnderperformContext[]> {
  // ADX — this read AdTarget.spendCents / salesCents, which are 0 across all 5,204
  // targets and will stay 0: the only job that wrote them, ads-metrics-ingest, was
  // deliberately retired in H.2e (2026-05-18) when the async report pipeline replaced
  // it. So this trigger could never match, and re-arming that job to feed it would
  // duplicate the modern pipeline and burn Amazon report quota for data we already have.
  //
  // Sourced from AmazonAdsDailyPerformance instead, exactly like its four siblings.
  // The emitted context shape is unchanged, because rule conditions reference
  // adTarget.spendCents and adTarget.salesCents by path and must keep resolving.
  const settled = settledWhere(WINDOW('AD_TARGET_UNDERPERFORMING')) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'AD_TARGET', ...settled, localEntityId: { not: null } },
    _sum: { costMicros: true, sales7dCents: true },
  })
  const candidates = perf.filter((r) =>
    microsToCents(r._sum.costMicros) >= UNDERPERFORM_SPEND_MIN_CENTS
    && (r._sum.sales7dCents ?? 0) === 0)
  if (candidates.length === 0) return []

  const targets = await prisma.adTarget.findMany({
    where: { id: { in: candidates.map((c) => c.localEntityId as string) }, status: 'ENABLED' },
    select: {
      id: true, externalTargetId: true, kind: true, expressionValue: true, bidCents: true,
      adGroup: {
        select: { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true } } },
      },
    },
  })
  const spendBy = new Map(candidates.map((c) => [c.localEntityId as string, microsToCents(c._sum.costMicros)]))

  return targets
    .filter((t) => t.adGroup?.campaign)
    .map((t) => ({
      trigger: 'AD_TARGET_UNDERPERFORMING' as const,
      marketplace: t.adGroup!.campaign!.marketplace ?? null,
      evidence: {
        targetKey: 'AD_TARGET_UNDERPERFORMING',
        metric: 'spendWithoutSales',
        observed: spendBy.get(t.id) ?? 0,
        threshold: UNDERPERFORM_SPEND_MIN_CENTS,
        windowDays: 14,
        sampleUnit: 'days' as const,
        sampleSize: 14,
      },
      adTarget: {
        id: t.id,
        externalTargetId: t.externalTargetId,
        kind: t.kind,
        expressionValue: t.expressionValue,
        bidCents: t.bidCents,
        spendCents: spendBy.get(t.id) ?? 0,
        salesCents: 0, // by construction — these are the zero-sale candidates
      },
      adGroup: { id: t.adGroup!.id, name: t.adGroup!.name },
      campaign: { id: t.adGroup!.campaign!.id, name: t.adGroup!.campaign!.name },
    }))
}

// ── Per-rule lookback ──────────────────────────────────────────────────
// 4a (review 4.14) — hoisted out of the tick so `simulateOneRule` builds a rule's contexts over
// the SAME window the tick does. Simulate used to build every rule over the trigger's default.

/**
 * BP.P4 — per-rule lookback for Bid rules, honoured by the EMITTER.
 *
 * A builder Bid rule may carry its own `actions[0].windowDays` (the builder's Lookback select,
 * clamped 7–90). Contexts are aggregates over a window, so a rule's window can only bind if
 * its contexts are BUILT over it: the default pass keeps the trigger's 14 settled days and
 * excludes window-choosing rules; each distinct chosen window gets its own pass with its own
 * contexts and only its own rules. One extra groupBy per distinct window actually in use.
 *
 * 4f — `trigger` is the rule's own: builder Bid rules ride TARGET_PERFORMANCE now, and "the
 * default" means that trigger's window.
 */
export function bidRuleWindow(actions: unknown, trigger: 'KEYWORD_HIGH_ACOS' | 'TARGET_PERFORMANCE' = 'KEYWORD_HIGH_ACOS'): number | null {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: string; windowDays?: unknown } | undefined) : undefined
  if (a0?.type !== 'bid' || typeof a0.windowDays !== 'number' || !Number.isFinite(a0.windowDays)) return null
  const clamped = Math.max(BID_WINDOW_MIN, Math.min(BID_WINDOW_MAX, Math.round(a0.windowDays)))
  return clamped === WINDOW(trigger) ? null : clamped
}

/**
 * BUD-P3 · PLC-P5 — the per-window mechanism for BOTH `CAMPAIGN_PERFORMANCE_BUDGET` builders.
 *
 * Budget and Placement share this trigger and share `buildCampaignBudgetContexts`, so they share
 * one helper. It used to test `a0.type !== 'budget'`, which meant a `windowDays` stored on a
 * placement rule was read by nobody and every placement rule silently rode the default 7-day
 * pass — the stored-but-unread class, one layer below the UI where it is hardest to see.
 */
const CAMPAIGN_WINDOW_SLUGS = new Set(['budget', 'placement'])
export function campaignRuleWindow(actions: unknown): number | null {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: string; windowDays?: unknown } | undefined) : undefined
  if (!a0 || !CAMPAIGN_WINDOW_SLUGS.has(String(a0.type ?? ''))) return null
  if (typeof a0.windowDays !== 'number' || !Number.isFinite(a0.windowDays)) return null
  const clamped = Math.max(BID_WINDOW_MIN, Math.min(BID_WINDOW_MAX, Math.round(a0.windowDays)))
  return clamped === WINDOW('CAMPAIGN_PERFORMANCE_BUDGET') ? null : clamped
}

// ── Cron tick ──────────────────────────────────────────────────────────

export async function applyMarketplaceScope<C extends { marketplace: string | null }>(
  trigger: string,
  contexts: C[],
  forceDryRun = false,
  /**
   * BP.P4 — restricts WHICH rules this pass may evaluate. The per-rule-lookback passes use it:
   * KEYWORD_HIGH_ACOS now runs once per DISTINCT window among the due Bid rules, each pass
   * carrying contexts built over that window and admitting only the rules that chose it —
   * without the filter, a 30-day rule would also run against the default 14-day contexts.
   */
  ruleFilter?: (r: { id: string; actions: unknown }) => boolean,
): Promise<{ evaluations: number; matches: number; capped: number; failed: number; leverHeld?: LeverSkipCounts }> {
  let evaluations = 0
  let matches = 0
  // ADX.1 — outcome counts, not just volume. The engine ran with a 96% failure
  // rate for months and the cron summary said only "evals=N matches=M", which
  // looks healthy either way. Counting capped/failed is what makes that visible.
  let capped = 0
  let failed = 0

  /**
   * ACR.7 — scope is ENFORCED here now, not merely hinted.
   *
   * The old shape queried a scoped rule list per context and used it only as a skip-check;
   * the evaluation call then ran EVERY enabled rule for the trigger, so a DE-scoped rule
   * still fired on IT contexts whenever any rule passed the check. With drag-to-scope
   * (portfolio/campaign binding) that hole would have made every drop a lie, so the filtered
   * survivors are now passed INTO the evaluator via ruleIds.
   *
   * Rules are fetched once per trigger; identity maps are built once from the contexts; the
   * per-context filter is pure (`ruleMatchesScope`).
   */
  const fetched = await prisma.automationRule.findMany({
    where: { domain: 'advertising', trigger, enabled: true },
    // D1 — `actions` joins the select so a BUDGET rule can be told apart from the rest. It is the
    // same test `loadBudgetRules` uses (an `adjust_ad_budget` action), kept as one definition.
    select: { id: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, actions: true, lastEvaluatedAt: true },
  })
  /**
   * BP.P2 — the stored schedule is HONOURED. A builder rule carries
   * `actions[0].schedule` (Frequency · time · Timezone from the builder's Advanced Settings) and
   * until now nothing read it: every rule ran on this cron's own 15-minute tick while the grid
   * printed "Daily · 3:00 AM" as fact. A rule with a schedule now evaluates only when due —
   * semantics and the lastEvaluatedAt caveat in `ads-rule-schedule.ts`. Engine-native rules
   * store no schedule and keep the trigger cadence unchanged; `simulateOneRule` bypasses this
   * gate on purpose (an explicit Simulate should answer now, not at 3 AM).
   */
  const { ruleStoredSchedule, scheduleIsDue } = await import('../services/advertising/ads-rule-schedule.js')
  const nowForDue = new Date()
  const rules = fetched
    .filter((r) => scheduleIsDue(ruleStoredSchedule(r.actions), r.lastEvaluatedAt, nowForDue))
    .filter((r) => (ruleFilter ? ruleFilter(r) : true))
  if (rules.length === 0) return { evaluations, matches, capped, failed }

  /**
   * D1 · BUD-P2 · 4a — the campaigns each rule is BOUND to: engine-native budget rules by
   * `CampaignRuleAssignment`, builder rules (Budget, Bid, SOV, Keyword Tracker, Placement) by their
   * own picker list. One resolver, shared with `simulateOneRule` and `reachForRules`, so the tick,
   * Simulate and the reach number cannot disagree — the three states are documented there.
   *
   * 🔴 4a (review 4.2) — a Bid/SOV/Keyword Tracker/Placement rule used to reach this matcher
   * ungoverned: every unpicked campaign was evaluated, wrote an execution row (spending the rule's
   * daily cap) and took an arbitration claim before its handler skipped it as "not selected".
   */
  const { resolveAssignedCampaignIds } = await import('../services/advertising/ads-rule-scope-resolver.js')
  const assignedByRule = await resolveAssignedCampaignIds(rules)

  /**
   * RA.GRAIN — product scope, resolved once per trigger and only when some rule asks for it.
   *
   * The column holds one `Product.id`, which may be a PARENT — a whole product line. Expanding a
   * parent to its children is a database read, and `ruleMatchesScope` is pure, so the expansion
   * happens here and the matcher receives ids. Measured: the 13 parents in this account expand to
   * 18–49 children each, and the widest line (GALE) reaches 77 of 220 campaigns across 4 markets.
   *
   * Every map below is built ONLY when a product-scoped rule exists for this trigger, so an
   * account that never uses the grain pays nothing for it.
   */
  const productScoped = rules.filter((r) => r.scopeProductId != null)
  const expandedByRule = new Map<string, string[]>()
  const productsByAdGroup = new Map<string, string[]>()
  const productsByCampaign = new Map<string, string[]>()
  if (productScoped.length > 0) {
    const { expandProductScope } = await import('../services/advertising/ads-scope-reach.js')
    const wanted = new Set<string>()
    for (const r of productScoped) {
      const ids = await expandProductScope(r.scopeProductId!)
      expandedByRule.set(r.id, ids)
      for (const p of ids) wanted.add(p)
    }
    // Only the ad-product rows for products some rule actually cares about — not all 4,485.
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: [...wanted] } },
      select: { productId: true, adGroupId: true, adGroup: { select: { campaignId: true } } },
    })
    for (const a of ads) {
      if (!a.productId) continue
      const ag = productsByAdGroup.get(a.adGroupId) ?? []
      if (!ag.includes(a.productId)) { ag.push(a.productId); productsByAdGroup.set(a.adGroupId, ag) }
      const cid = a.adGroup?.campaignId
      if (cid) {
        const cp = productsByCampaign.get(cid) ?? []
        if (!cp.includes(a.productId)) { cp.push(a.productId); productsByCampaign.set(cid, cp) }
      }
    }
  }

  // Identity maps, only if any rule actually scopes below marketplace level.
  // D1 — an assignment-governed rule needs the campaign identity too, or every context would
  // arrive with `campaignId: null` and the matcher would refuse all of them.
  const needsCampaignIdentity = rules.some((r) => r.scopePortfolioId != null || r.scopeCampaignId != null) || assignedByRule.size > 0
  const extToLocal = new Map<string, string>()
  const localToPortfolio = new Map<string, string | null>()
  if (needsCampaignIdentity) {
    const exts = new Set<string>()
    const locals = new Set<string>()
    for (const ctx of contexts) {
      const c = ctx as unknown as { campaign?: { id?: string }; searchTerm?: { externalCampaignId?: string } }
      if (c.campaign?.id) locals.add(c.campaign.id)
      if (c.searchTerm?.externalCampaignId) exts.add(c.searchTerm.externalCampaignId)
    }
    const camps = await prisma.campaign.findMany({
      where: { OR: [
        ...(locals.size ? [{ id: { in: [...locals] } }] : []),
        ...(exts.size ? [{ externalCampaignId: { in: [...exts] } }] : []),
      ] },
      select: { id: true, externalCampaignId: true, portfolioId: true },
    })
    for (const c of camps) {
      if (c.externalCampaignId) extToLocal.set(c.externalCampaignId, c.id)
      localToPortfolio.set(c.id, c.portfolioId)
    }
  }

  // ONE BRAIN AB-6 — who holds the levers of every campaign these contexts name, read once for the pass (each rule's own
  // check then reads nothing more); nothing at all unless the brain's ceiling is live and a product is enrolled.
  const { warmRuleLeverOwners, ruleResultLeverSkips } = await import('../services/advertising/brain/rule-skips.js')
  await warmRuleLeverOwners(contexts)
  const leverHeld: LeverSkipCounts = {}

  for (const ctx of contexts) {
    const identity = contextIdentity(ctx, extToLocal, localToPortfolio, productsByAdGroup, productsByCampaign)
    // Each rule is matched with its OWN expanded product set — a per-rule value, so it cannot be
    // hoisted out of this filter the way the shared identity maps can.
    const applicable = rules.filter((r) => ruleMatchesScope({
      ...r,
      scopeProductIds: expandedByRule.get(r.id) ?? null,
      // `?? null` is the "not assignment-governed" signal for every non-budget rule.
      assignedCampaignIds: assignedByRule.get(r.id) ?? null,
    }, identity))
    if (applicable.length === 0) continue
    const results = await evaluateAllRulesForTrigger({
      domain: 'advertising',
      trigger,
      context: ctx,
      forceDryRun,
      ruleIds: applicable.map((r) => r.id),
    })
    evaluations += results.length
    matches += results.filter((r) => r.matched).length
    capped += results.filter((r) => r.status === 'CAP_EXCEEDED').length
    failed += results.filter((r) => r.status === 'FAILED').length
    for (const r of results) for (const a of r.actionResults ?? []) addLeverSkipCounts(leverHeld, ruleResultLeverSkips(a))
  }
  return { evaluations, matches, capped, failed, ...(Object.keys(leverHeld).length ? { leverHeld } : {}) }
}

// ADX — nine queries in this file read `entityType: 'KEYWORD'` from
// AmazonAdsDailyPerformance. Nothing has ever written that value. The ingest writes
// 'AD_TARGET' (ads-reports.service, ingestTargetRows) and the schema documents the
// vocabulary as CAMPAIGN | AD_GROUP | AD_TARGET | PRODUCT_AD | SEARCH_TERM | PLACEMENT.
//
// So every target-grain trigger was reading a value that does not exist — and would
// have gone on reading it even after the targeting report cron started producing rows.
// Two halves of one feature, both fully implemented, disagreeing about the name of the
// thing they exchange.
//
// Separately still dead: nothing ingests AD_GROUP grain, so the ad-group builder below
// has no producer at all — a different failure from a mismatched name.
// ── CAMPAIGN_PERFORMANCE_BUDGET (AME.12) ──────────────────────────────
// Performance/ROAS-guardrail budget rules. Yields every enabled campaign with
// its windowed ROAS/ACOS (from the daily table — accurate, not the stale stored
// columns) + budget utilisation, so a rule can raise the daily budget on
// winners that are budget-capped and trim losers. The adjust_ad_budget action +
// per-rule guardrails (maxValueCentsEur, dryRun) do the rest.
/**
 * B2 — read from the shared map, not re-declared. This constant is used TWICE: for the perf query
 * below and to divide spend into `avgDailySpendCents`. Leaving it at a literal 7 while the query
 * moved to `WINDOW(...)` would let the divisor drift away from the window it is dividing, and a
 * daily average computed over the wrong number of days is wrong in a way nothing on screen shows.
 */
const BUDGET_RULE_WINDOW_DAYS = WINDOW('CAMPAIGN_PERFORMANCE_BUDGET')

/**
 * PLC-P7 — one lane's own performance, over the same window as the campaign beside it.
 *
 * 🔴 UNDEFINED where not measurable — not null, and not 0. The distinction is load-bearing and it
 * cost this unit a failing test to find:
 *
 *     applyOperator('lte', lhs, rhs)  →  Number(lhs) <= Number(rhs)
 *     Number(null)      === 0    →  null  <= 0.003  is TRUE
 *     Number(undefined) === NaN  →  undefined <= 0.003  is FALSE
 *
 * So a `null` behaves exactly like the fabricated zero it was meant to avoid: it MATCHES every
 * `lt`/`lte`. Measured — a lane-scoped "CTR ≤ 99%" draft matched 53 campaigns when only 51 had a
 * measurable Product Pages CTR. With `undefined`, every relational comparison against an
 * unmeasured lane is false, which is the honest reading of "we have never seen this lane".
 *
 * ⚠ The campaign-level ratios one level up are still `null` and therefore still behave as zeros
 * for `lt`/`lte`. That is a live cross-cutting defect in the shared comparator, not this type's to
 * fix unilaterally — see the PLC-P7 note in the ship log.
 */
export interface PlacementLaneMetrics {
  impressions?: number; clicks?: number; orders?: number
  spendCents?: number; salesCents?: number
  acos?: number; roas?: number
  ctr?: number; cvr?: number; cpcCents?: number
}

export interface CampaignBudgetContext {
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET'
  marketplace: string | null
  campaign: {
    id: string; externalCampaignId: string | null; name: string
    dailyBudgetCents: number; spendCents: number; salesCents: number
    impressions: number; clicks: number; orders: number
    avgDailySpendCents: number
    /**
     * KT-P/C1 — OPTIONAL, not nullable. An unmeasurable ratio is absent, so every operator refuses
     * it; a `null` here reads as 0 to the engine. Same shape as `PlacementLaneMetrics` above.
     * The counting fields stay required — a measured 0 is a measurement.
     */
    acos?: number; roas?: number
    ctr?: number; cvr?: number; cpcCents?: number
    budgetUtilization?: number
  }
  /**
   * PLC-P7 — the three SP placement lanes, each measured on its own, from
   * `AmazonAdsPlacementReport` over the SAME window as `campaign` above.
   *
   * 🔴 Additive by design. Budget rules share this trigger and these contexts and reference none of
   * these fields, so their behaviour is unchanged; the Placement builder's IF scope selector is
   * what reads them (`scope: 'tos' | 'pdp' | 'ros'` → `placement.<key>.<metric>`). Putting them on
   * the EXISTING context rather than in a new family is what lets one rule mix a campaign-wide
   * condition with a lane-scoped one, and keeps the evaluator's passes, the preview and the
   * assignment logic working untouched.
   */
  placement: { tos: PlacementLaneMetrics; pdp: PlacementLaneMetrics; ros: PlacementLaneMetrics }
}

/**
 * BUD-P3 — `overrideDays` builds the SAME contexts over a Budget rule's own lookback
 * (`actions[0].windowDays`), for the per-window passes in the tick; absent, the trigger's
 * default 7 settled days apply exactly as before. Mirrors BP.P4's bid mechanism.
 */
export async function buildCampaignBudgetContexts(overrideDays?: number): Promise<CampaignBudgetContext[]> {
  const windowDays = overrideDays ?? BUDGET_RULE_WINDOW_DAYS
  const settled = settledWhere(windowDays) // 6c — ends at the ad product's attribution lag
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ENABLED' },
    select: { id: true, name: true, externalCampaignId: true, marketplace: true, dailyBudget: true },
  })
  if (campaigns.length === 0) return []
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, ...settled },
    // P2.1 — impressions/clicks/orders ride the same groupBy so the builder's full metric list
    // (CTR, CVR, CPC, Impressions, Clicks, Orders) translates instead of being refused.
    _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, impressions: true, clicks: true, orders7d: true },
  })
  const byId = new Map(perf.map((p) => [p.localEntityId!, p]))

  /**
   * PLC-P7 — the same window, per PLACEMENT LANE, from Amazon's placement report.
   *
   * 🔴 Two joins go wrong silently here and both have cost this programme time before:
   *   · `AmazonAdsPlacementReport.placement` holds Amazon's REPORT LABELS
   *     ("Top of Search on-Amazon"), never the bidding enums — matching on an enum returns a clean
   *     zero that reads exactly like "this lane does not deliver". `REPORT_LABEL_TO_PLACEMENT` is
   *     the single join, shared with the placement page.
   *   · the report's `campaignId` is Amazon's EXTERNAL id. `localCampaignId` is the local one and
   *     is now fully populated (0 nulls in 30 days, measured 2026-08-22) — but it is nullable, so
   *     rows without it are skipped rather than mis-attributed.
   *
   * One grouped query per context build, over the campaigns already selected.
   */
  const laneRows = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['localCampaignId', 'placement'],
    where: { localCampaignId: { in: campaigns.map((c) => c.id) }, ...settled },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
  })
  /** local campaign id → bidding enum → the summed row. */
  const lanesByCampaign = new Map<string, Map<string, typeof laneRows[number]>>()
  for (const r of laneRows) {
    if (!r.localCampaignId) continue
    const enumKey = REPORT_LABEL_TO_PLACEMENT[r.placement]
    if (!enumKey) continue // an unrecognised fourth label is dropped, never folded into another
    const m = lanesByCampaign.get(r.localCampaignId) ?? new Map()
    m.set(enumKey, r)
    lanesByCampaign.set(r.localCampaignId, m)
  }
  /**
   * A lane with no rows in the window is NOT MEASURABLE, and every field is null.
   *
   * 🔴 Never 0. A fabricated zero ACoS or CTR matches every `lte` condition, so a rule written to
   * cut a lane that is performing badly would cut every lane it has never seen — the loudest
   * possible failure direction, and the same reasoning that makes the campaign ratios null.
   */
  const EMPTY_LANE: PlacementLaneMetrics = {}
  const laneMetrics = (row: typeof laneRows[number] | undefined): PlacementLaneMetrics => {
    if (!row) return EMPTY_LANE
    const impressions = row._sum.impressions ?? 0
    const clicks = row._sum.clicks ?? 0
    const orders = row._sum.orders7d ?? 0
    const spendCents = microsToCents(row._sum.costMicros)
    const salesCents = row._sum.sales7dCents ?? 0
    return {
      impressions, clicks, orders, spendCents, salesCents,
      // undefined, never null — see PlacementLaneMetrics. A ratio with no denominator is not
      // measurable, and `Number(null)` is 0, which matches every `lte`.
      ...(salesCents > 0 ? { acos: spendCents / salesCents } : {}),
      ...(spendCents > 0 ? { roas: salesCents / spendCents } : {}),
      ...(impressions > 0 ? { ctr: clicks / impressions } : {}),
      ...(clicks > 0 ? { cvr: orders / clicks } : {}),
      ...(clicks > 0 ? { cpcCents: Math.round(spendCents / clicks) } : {}),
    }
  }

  const out: CampaignBudgetContext[] = []
  for (const c of campaigns) {
    const p = byId.get(c.id)
    const spendCents = microsToCents(p?._sum.costMicros)
    if (spendCents === 0) continue
    const salesCents = adSalesCents(p?._sum)
    const impressions = p?._sum.impressions ?? 0
    const clicks = p?._sum.clicks ?? 0
    const orders = p?._sum.orders7d ?? 0
    const dailyBudgetCents = Math.round(Number(c.dailyBudget) * 100)
    const avgDailySpendCents = Math.round(spendCents / windowDays)
    out.push({
      trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
      marketplace: c.marketplace,
      campaign: {
        id: c.id, externalCampaignId: c.externalCampaignId, name: c.name,
        dailyBudgetCents, spendCents, salesCents,
        impressions, clicks, orders,
        avgDailySpendCents,
        /**
         * 🔴 KT-P/C1 — the comment that stood here said "a null fails a condition, which is the
         * honest reading for 'not measurable'". **That was false, and it is why this survived.**
         * `applyOperator` coerces with `Number()`, and `Number(null)` is `0` — so a null ratio
         * MATCHED every `lt`/`lte`, which is the exact failure the old comment believed it was
         * preventing. Only an ABSENT key fails, because `Number(undefined)` is `NaN`.
         *
         * Measured on prod 2026-08-22: **38 of the 46 campaigns emitting a budget context have no
         * ACoS** (spend, no sales) and all 38 satisfied `ACOS <= 25%`.
         */
        ...measured({
          acos: salesCents > 0 ? spendCents / salesCents : null,
          roas: spendCents > 0 ? salesCents / spendCents : null,
          ctr: impressions > 0 ? clicks / impressions : null,
          cvr: clicks > 0 ? orders / clicks : null,
          cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : null,
          budgetUtilization: dailyBudgetCents > 0 ? avgDailySpendCents / dailyBudgetCents : null,
        }),
      },
      // PLC-P7 — the builder's own lane keys, so `scope: 'tos'` resolves without a second map.
      placement: {
        tos: laneMetrics(lanesByCampaign.get(c.id)?.get(PLACEMENT_TOP)),
        pdp: laneMetrics(lanesByCampaign.get(c.id)?.get(PLACEMENT_PRODUCT)),
        ros: laneMetrics(lanesByCampaign.get(c.id)?.get(PLACEMENT_REST)),
      },
    })
  }
  return out
}

// ── KEYWORD_ZERO_IMPRESSIONS ──────────────────────────────────────────
// ENABLED keywords that spent money but got ZERO impressions in the last 7
// days — signals delivery failure (suppressed listing, bad targeting, etc.)
async function buildZeroImpressionContexts() {
  const settled = settledWhere(WINDOW('KEYWORD_ZERO_IMPRESSIONS')) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'AD_TARGET', ...settled, costMicros: { gt: 0n } },
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
  const settled = settledWhere(WINDOW('KEYWORD_LOW_CTR')) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'AD_TARGET', ...settled },
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
  // 6c — both halves settled: the recent week ends at the ad product's attribution lag, the prior week is the 7 days before it
  const recent = settledWhere(WINDOW('CVR_DROP'))
  const prior = settledWhere(WINDOW('CVR_DROP'), { offsetDays: WINDOW('CVR_DROP') })
  const [thisWeek, prevWeek] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'marketplace'], where: { entityType: 'AD_TARGET', ...recent, clicks: { gt: 0 } }, _sum: { clicks: true, orders7d: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'marketplace'], where: { entityType: 'AD_TARGET', ...prior, clicks: { gt: 0 } }, _sum: { clicks: true, orders7d: true } }),
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
  const settled = settledWhere(WINDOW('KEYWORD_WASTED_SPEND')) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'marketplace'],
    where: { entityType: 'AD_TARGET', ...settled },
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
  const settled = settledWhere(WINDOW('SEARCH_TERM_CONVERTING')) // 6c — ends at the ad product's attribution lag
  const terms = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
    // Prisma's `in` cannot contain null — match the null (auto-targeting, no
    // match type) case via OR instead. Putting null inside `in` threw
    // "Expected ListStringFieldRefInput or Null" every tick, silently breaking
    // the whole evaluator (surfaced by the RRL.7 overdueCrons alert).
    where: {
      AND: [settled], // 6c — nested: this where has its own OR (match types) below
      // 🔴 HV.8c — the null branch was written for "auto-targeting, no match type", and NO ROW IN
      // THIS ACCOUNT HAS EVER BEEN NULL. Auto campaigns arrive as TARGETING_EXPRESSION_PREDEFINED
      // and product expressions as TARGETING_EXPRESSION, so 4,514 rows of auto-targeting demand
      // were invisible to `promote_to_exact` — the comment described the intent and the filter
      // implemented something else. HV.1 repaired the page's own read; this is the rule path's copy.
      // EXACT stays out deliberately: promoting an exact term to exact is the tautology HV.1 removed.
      OR: [
        { matchType: { in: ['BROAD', 'PHRASE', 'TARGETING_EXPRESSION', 'TARGETING_EXPRESSION_PREDEFINED'] } },
        { matchType: null },
      ],
    },
    _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true, impressions: true },
    // 🔴 HV.8c — this is a HAVING clause, so it is a FLOOR the rule author cannot see and cannot
    // lower. A rule asking for "orders >= 1" can never match a 1-order term: the context is built
    // first and only terms already at >= CONVERTING_MIN_ORDERS reach the conditions at all. A rule
    // condition can tighten this, never loosen it. Default is 2 (NEXUS_CONVERTING_MIN_ORDERS).
    having: { orders7d: { _sum: { gte: CONVERTING_MIN_ORDERS } } },
  })
  return terms.slice(0, 300).map((t) => searchTermContext('SEARCH_TERM_CONVERTING', t.marketplace, {
    query: t.query, externalCampaignId: t.campaignId, externalAdGroupId: t.adGroupId,
    orders: t._sum.orders7d ?? 0, clicks: t._sum.clicks ?? 0, impressions: t._sum.impressions ?? 0,
    spendCents: microsToCents(t._sum.costMicros), salesCents: t._sum.sales7dCents ?? 0,
  }))
}

// P2.1 — one shape for both search-term triggers, with the derived ratios the builder's metric
// list offers (ACOS/ROAS/CTR/CVR/CPC). Ratios are null (never 0) when their denominator is 0 —
// a null fails a condition, the honest reading for "not measurable".
function searchTermContext(
  trigger: 'SEARCH_TERM_CONVERTING' | 'SEARCH_TERM_WASTING',
  marketplace: string | null,
  base: { query: string; externalCampaignId: string | null; externalAdGroupId: string | null; orders: number; clicks: number; impressions: number; spendCents: number; salesCents: number },
) {
  return {
    trigger,
    marketplace,
    searchTerm: {
      ...base,
      // KT-P/C1 — every ratio absent when its denominator is 0, so `lt`/`lte` refuse it.
      ...measured({
        acos: base.salesCents > 0 ? base.spendCents / base.salesCents : null,
        roas: base.spendCents > 0 ? base.salesCents / base.spendCents : null,
        ctr: base.impressions > 0 ? base.clicks / base.impressions : null,
        cvr: base.clicks > 0 ? base.orders / base.clicks : null,
        cpcCents: base.clicks > 0 ? Math.round(base.spendCents / base.clicks) : null,
      }),
    },
  }
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
/**
 * BP.P4 — `overrideDays` builds the SAME contexts over a Bid rule's own lookback
 * (`actions[0].windowDays`), for the per-window passes in the tick; absent, the trigger's
 * default window applies exactly as before.
 */
/** Exported for the draft preview, exactly as `buildCampaignBudgetContexts` and the SOV/rank
 *  emitters are: a preview that re-implements the emitter checks its own copy. */
export async function buildHighAcosKeywordContexts(overrideDays?: number) {
  try {
    const settled = settledWhere(overrideDays ?? WINDOW('KEYWORD_HIGH_ACOS')) // 6c — ends at the ad product's attribution lag
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'AD_TARGET', ...settled },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true, impressions: true },
    })
    const emitted = perf
      .map((p) => ({ p, spend: microsToCents(p._sum.costMicros), sales: p._sum.sales7dCents ?? 0, orders: p._sum.orders7d ?? 0 }))
      // BID-P — the floor is DECLARED, not inline: the draft preview's census and the builder's
      // window note read the same constant, so what the operator is told cannot drift from what
      // this filter does. Numbers unchanged (orders>0 · sales>0 · >=EUR2 · ACoS>=20%).
      .filter((x) => x.orders >= HIGH_ACOS_FLOOR.minOrders && x.sales >= HIGH_ACOS_FLOOR.minSalesCents
        && x.spend >= HIGH_ACOS_FLOOR.minSpendCents && x.spend / x.sales >= HIGH_ACOS_FLOOR.minAcos)
      .sort((a, b) => (b.spend / b.sales) - (a.spend / a.sales))
      .slice(0, HIGH_ACOS_FLOOR.topPerTick)
    // BP.P4 — the target's CURRENT bid joins the context ("Current Bid" is on H10's Bid metric
    // list). One findMany over the emitted ids; null when the target row is missing, never 0.
    const bids = new Map<string, number | null>()
    /**
     * 🔴 BID-P — the campaign and ad-group IDS, which this context has never carried.
     *
     * This is P2.3's defect, fixed for the SOV and rank emitters at the time and missed here. A
     * context with no `campaign` makes `contextIdentity()` resolve campaign/portfolio/product
     * EMPTY, so a Bid rule scoped to any grain but market matches zero contexts forever — it looks
     * armed and never fires. It also made a draft preview impossible: the picker filter has nothing
     * to match on, so every Bid preview would render 0 rows however many keywords qualified.
     *
     * `bid_apply`'s own `campaignIds` allowlist is unaffected either way — it re-reads the target's
     * campaign from the DB at write time — so this changes what a rule can SEE, never what it may
     * touch. One findMany, already being made for `bidCents`, now selects two more columns.
     */
    const owner = new Map<string, { campaignId: string | null; adGroupId: string | null }>()
    const ids = emitted.map((x) => x.p.localEntityId).filter((v): v is string => v != null)
    if (ids.length) {
      const rows = await prisma.adTarget.findMany({
        where: { id: { in: ids } },
        select: { id: true, bidCents: true, adGroup: { select: { id: true, campaignId: true } } },
      })
      for (const r of rows) {
        bids.set(r.id, r.bidCents)
        owner.set(r.id, { campaignId: r.adGroup?.campaignId ?? null, adGroupId: r.adGroup?.id ?? null })
      }
    }
    return emitted
      .map(({ p, spend, sales, orders }) => {
        const clicks = p._sum.clicks ?? 0
        const impressions = p._sum.impressions ?? 0
        const own = p.localEntityId != null ? owner.get(p.localEntityId) : undefined
        return {
          trigger: 'KEYWORD_HIGH_ACOS' as const,
          marketplace: p.marketplace,
          ...(own?.campaignId ? { campaign: { id: own.campaignId } } : {}),
          ...(own?.adGroupId ? { adGroup: { id: own.adGroupId } } : {}),
          adTarget: {
            id: p.localEntityId, spendCents: spend, salesCents: sales, orders, acos: spend / sales,
            clicks, impressions,
            /**
             * 🔴 KT-P/C1 — the old comment here claimed "ratios are null when the denominator is 0,
             * never a fabricated 0". A null IS a fabricated 0 to this engine: `applyOperator`
             * coerces with `Number()`. Absent is the only value that refuses every operator.
             *
             * ⚠️ `acos` above is deliberately NOT wrapped, and the reason is stronger than it
             * first looked. It is `spend / sales`, and **this emitter's own filter requires
             * `orders > 0 && sales > 0`** (see the `.filter` above), so the denominator can never
             * be zero: `acos` here is always a finite, measured number. There is no null and no
             * Infinity to omit.
             *
             * 🔴 The generalisable point, and it corrects an earlier reading of mine: a trigger's
             * own floor can make a whole class of nulls UNREACHABLE. Before believing a null hazard
             * on any context, read the emitter's `where`/`filter` first — the 197 zero-sales
             * keyword targets on this account are real, but they never become KEYWORD_HIGH_ACOS
             * contexts, so no Bid rule can read them as 0%-ACoS winners. The emitters that do NOT
             * filter — the budget context (38 of 46) and the SOV context (772 of 793) — are where
             * the hazard actually lived. Credit: SOV-P caught this.
             */
            ...measured({
              roas: spend > 0 ? sales / spend : null,
              ctr: impressions > 0 ? clicks / impressions : null,
              cvr: clicks > 0 ? orders / clicks : null,
              cpcCents: clicks > 0 ? Math.round(spend / clicks) : null,
              bidCents: (p.localEntityId != null ? bids.get(p.localEntityId) : null) ?? null,
            }),
          },
        }
      })
  } catch (e) { logger.warn('[ads-rule-evaluator] buildHighAcosKeywordContexts failed', { error: (e as Error).message }); return [] }
}

// ── TARGET_PERFORMANCE (4f) ───────────────────────────────────────────
/**
 * 4f (review 4.6) — the trigger builder Bid rules ride: every ENABLED positive target with at least
 * `TARGET_PERFORMANCE_FLOOR.minClicks` clicks over the rule's window (14 settled days by default,
 * `overrideDays` for a Bid rule's own lookback, as `buildHighAcosKeywordContexts` takes it).
 *
 * KEYWORD_HIGH_ACOS kept only converting keywords at ≥20% ACoS — 8 of 3,155 targets — so a Bid rule
 * built from "Scale winners" or "Floor zero-sale spenders" could never match. It stays for engine rules.
 *
 * 🔴 Suppressed targets are NOT offered: the target's own flag, a bid at or under
 * `KT6_SUPPRESSION_CENTS`, or a campaign whose bids are suppressed — the three tests `bid_apply`
 * skips on. Offering them would only write execution rows for keywords the handler refuses.
 *
 * `acos` is ABSENT (never 0) on a target with no sales: `applyOperator` reads `Number(null)` as 0,
 * so a null would match every "ACoS < x". `salesCents: 0` stays, so "Sales = 0" still matches.
 */
export async function buildTargetPerformanceContexts(overrideDays?: number) {
  try {
    const settled = settledWhere(overrideDays ?? WINDOW('TARGET_PERFORMANCE')) // 6c — ends at the ad product's attribution lag
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'AD_TARGET', localEntityId: { not: null }, ...settled },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true, impressions: true },
    })
    const clicked = perf.filter((p) => (p._sum.clicks ?? 0) >= TARGET_PERFORMANCE_FLOOR.minClicks)
    if (clicked.length === 0) return []
    const rows = await prisma.adTarget.findMany({
      where: {
        id: { in: clicked.map((p) => p.localEntityId as string) },
        status: 'ENABLED', isNegative: false,
        suppressedFromBidCents: null, bidCents: { gt: KT6_SUPPRESSION_CENTS },
        adGroup: { campaign: { bidsSuppressedAt: null } },
      },
      select: {
        id: true, kind: true, expressionType: true, expressionValue: true, bidCents: true,
        adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true } } } },
      },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return clicked
      .map((p) => {
        const t = byId.get(p.localEntityId as string)
        if (!t?.adGroup?.campaign) return null
        const spend = microsToCents(p._sum.costMicros)
        const sales = adSalesCents(p._sum)
        const orders = p._sum.orders7d ?? 0
        const clicks = p._sum.clicks ?? 0
        const impressions = p._sum.impressions ?? 0
        return {
          trigger: 'TARGET_PERFORMANCE' as const,
          marketplace: p.marketplace,
          campaign: { id: t.adGroup.campaign.id, name: t.adGroup.campaign.name },
          adGroup: { id: t.adGroup.id, name: t.adGroup.name },
          adTarget: {
            id: t.id, kind: t.kind, expressionType: t.expressionType, expressionValue: t.expressionValue,
            bidCents: t.bidCents, spendCents: spend, salesCents: sales, orders, clicks, impressions,
            ...measured({
              acos: sales > 0 ? spend / sales : null,
              roas: spend > 0 ? sales / spend : null,
              ctr: impressions > 0 ? clicks / impressions : null,
              cvr: clicks > 0 ? orders / clicks : null,
              cpcCents: clicks > 0 ? Math.round(spend / clicks) : null,
            }),
          },
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.adTarget.spendCents - a.adTarget.spendCents)
  } catch (e) { logger.warn('[ads-rule-evaluator] buildTargetPerformanceContexts failed', { error: (e as Error).message }); return [] }
}

/**
 * 4f — the tick's TARGET_PERFORMANCE passes: one per distinct window among the enabled rules on it
 * (the default window is `null`), each admitting only its own rules — the BP.P4 mechanism the
 * KEYWORD_HIGH_ACOS passes use. Nothing is built when no enabled rule rides the trigger (0 today).
 */
type RulePass = [string, Array<{ marketplace: string | null }>, ((r: { id: string; actions: unknown }) => boolean)?]
export async function targetPerformancePasses(): Promise<RulePass[]> {
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true },
    select: { actions: true },
  })
  const windows = [...new Set(rules.map((r) => bidRuleWindow(r.actions, 'TARGET_PERFORMANCE')))]
  return Promise.all(windows.map(async (w): Promise<RulePass> => [
    'TARGET_PERFORMANCE',
    await buildTargetPerformanceContexts(w ?? undefined),
    (r) => bidRuleWindow(r.actions, 'TARGET_PERFORMANCE') === w,
  ]))
}

// ── KEYWORD_SCALE_OPPORTUNITY (E2) ────────────────────────────────────
// Proven winners (strong ROAS + real orders) with headroom to scale — pair
// with bid_up to win more of a profitable term.
async function buildScaleOpportunityContexts() {
  try {
    const settled = settledWhere(WINDOW('KEYWORD_SCALE_OPPORTUNITY')) // 6c — ends at the ad product's attribution lag
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'AD_TARGET', ...settled },
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
    const settled = settledWhere(WINDOW('AD_GROUP_UNDERPERFORMING')) // 6c — ends at the ad product's attribution lag
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'marketplace'],
      where: { entityType: 'AD_GROUP', ...settled },
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
        // KT-P/C1 — absent, not null (see EMPTY_TARGET_PERF).
        adGroup: { id: p.localEntityId, spendCents: spend, salesCents: sales, orders, ...measured({ acos: sales > 0 ? spend / sales : null }) },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildAdGroupUnderperformContexts failed', { error: (e as Error).message }); return [] }
}

// ── NEW_TO_BRAND_WINNER (E4) ──────────────────────────────────────────
// Campaigns acquiring new-to-brand customers (ntbOrders14d) — worth scaling
// for brand growth, a signal nothing else triggers on. Pairs with adjust_ad_budget.
async function buildNewToBrandWinnerContexts() {
  try {
    const settled = settledWhere(WINDOW('NEW_TO_BRAND_WINNER')) // 6c — ends at the ad product's attribution lag
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
    if (campaigns.length === 0) return []
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, ...settled },
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
    const settled = settledWhere(WINDOW('CAMPAIGN_NO_SALES')) // 6c — ends at the ad product's attribution lag
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
    if (campaigns.length === 0) return []
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: campaigns.map((c) => c.id) }, ...settled },
      _sum: { costMicros: true, sales7dCents: true, sales14dCents: true },
    })
    const byId = new Map(perf.map((p) => [p.localEntityId!, p]))
    return campaigns
      .map((c) => ({ c, p: byId.get(c.id) }))
      .filter((x) => { if (!x.p) return false; const spend = microsToCents(x.p._sum.costMicros); const sales = adSalesCents(x.p._sum); return spend >= 1000 && sales === 0 })
      .slice(0, 200)
      .map(({ c, p }) => ({
        trigger: 'CAMPAIGN_NO_SALES' as const,
        marketplace: c.marketplace,
        campaign: { id: c.id, externalCampaignId: c.externalCampaignId, name: c.name, spendCents: microsToCents(p!._sum.costMicros), salesCents: 0 },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildCampaignNoSalesContexts failed', { error: (e as Error).message }); return [] }
}

// ── SEARCH_TERM_WASTING (E6) ──────────────────────────────────────────
// Search terms (not keywords) burning spend with zero orders — feed straight
// into add_negative_exact to negate the exact query. Distinct from
// KEYWORD_WASTED_SPEND (keyword entity) and the batch harvest cron.
async function buildSearchTermWastingContexts() {
  try {
    const settled = settledWhere(WINDOW('SEARCH_TERM_WASTING')) // 6c — ends at the ad product's attribution lag
    const terms = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
      where: { ...settled },
      _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true, impressions: true },
      having: { orders7d: { _sum: { equals: 0 } } },
    })
    return terms
      .map((t) => ({ t, spend: microsToCents(t._sum.costMicros), clicks: t._sum.clicks ?? 0 }))
      // NEG-P3 — the floor comes from the shared declaration the builder's note and the tab's
      // strip also read; a literal here would let the three drift apart silently.
      .filter((x) => x.spend >= WASTING_FLOOR.minSpendCents && x.clicks >= WASTING_FLOOR.minClicks)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, WASTING_FLOOR.topPerTick)
      .map(({ t, spend, clicks }) => searchTermContext('SEARCH_TERM_WASTING', t.marketplace, {
        query: t.query, externalCampaignId: t.campaignId, externalAdGroupId: t.adGroupId,
        spendCents: spend, clicks, orders: 0, impressions: t._sum.impressions ?? 0,
        // orders7d = 0 by the HAVING; sales can still be non-zero on longer attribution — report it.
        salesCents: t._sum.sales7dCents ?? 0,
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildSearchTermWastingContexts failed', { error: (e as Error).message }); return [] }
}

// ── CAMPAIGN_ROAS_DECLINING (E7) ──────────────────────────────────────
// Campaigns whose ROAS dropped >30% week-over-week off a viable base — an
// efficiency-trend signal (distinct from absolute ACOS spike or keyword CVR).
async function buildCampaignRoasDecliningContexts() {
  try {
    // 6c — both halves settled: the recent week ends at the ad product's attribution lag, the prior week is the 7 days before it
    const recent = settledWhere(WINDOW('CAMPAIGN_ROAS_DECLINING'))
    const prior = settledWhere(WINDOW('CAMPAIGN_ROAS_DECLINING'), { offsetDays: WINDOW('CAMPAIGN_ROAS_DECLINING') })
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
    if (campaigns.length === 0) return []
    const ids = campaigns.map((c) => c.id)
    const [thisWk, prevWk] = await Promise.all([
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, ...recent }, _sum: { costMicros: true, sales7dCents: true } }),
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, ...prior }, _sum: { costMicros: true, sales7dCents: true } }),
    ])
    const roasOf = (s: number, c: number) => (c > 0 ? s / c : 0)
    const prevMap = new Map(prevWk.map((p) => [p.localEntityId, roasOf(p._sum.sales7dCents ?? 0, microsToCents(p._sum.costMicros))]))
    const thisMap = new Map(thisWk.map((p) => [p.localEntityId, { roas: roasOf(p._sum.sales7dCents ?? 0, microsToCents(p._sum.costMicros)), spend: microsToCents(p._sum.costMicros) }]))
    return campaigns
      .map((c) => ({ c, now: thisMap.get(c.id), prev: prevMap.get(c.id) }))
      .filter((x) => !!x.now && x.prev !== undefined && (x.prev as number) >= 1 && x.now!.spend >= 500 && x.now!.roas < (x.prev as number) * 0.7)
      .slice(0, 200)
      .map(({ c, now, prev }) => ({
        trigger: 'CAMPAIGN_ROAS_DECLINING' as const,
        marketplace: c.marketplace,
        campaign: { id: c.id, externalCampaignId: c.externalCampaignId, name: c.name, roas: now!.roas, previousRoas: prev as number, spendCents: now!.spend, declinePct: Math.round((1 - now!.roas / (prev as number)) * 100) },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildCampaignRoasDecliningContexts failed', { error: (e as Error).message }); return [] }
}

// ── KEYWORD_RISING_STAR (E8) ──────────────────────────────────────────
// Keywords with accelerating orders week-over-week (≥50% growth off a real
// base) — momentum, distinct from KEYWORD_SCALE_OPPORTUNITY's absolute ROAS.
// Lets a rule lean into emerging winners early.
async function buildRisingStarContexts() {
  try {
    // 6c — both halves settled: the recent week ends at the ad product's attribution lag, the prior week is the 7 days before it
    const recent = settledWhere(WINDOW('KEYWORD_RISING_STAR'))
    const prior = settledWhere(WINDOW('KEYWORD_RISING_STAR'), { offsetDays: WINDOW('KEYWORD_RISING_STAR') })
    const [thisWk, prevWk] = await Promise.all([
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'marketplace'], where: { entityType: 'AD_TARGET', ...recent }, _sum: { orders7d: true, costMicros: true, sales7dCents: true } }),
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'AD_TARGET', ...prior }, _sum: { orders7d: true } }),
    ])
    const prevMap = new Map(prevWk.map((p) => [p.localEntityId, p._sum.orders7d ?? 0]))
    return thisWk
      .map((p) => ({ p, orders: p._sum.orders7d ?? 0, prevOrders: prevMap.get(p.localEntityId) ?? 0, spend: microsToCents(p._sum.costMicros), sales: p._sum.sales7dCents ?? 0 }))
      .filter((x) => x.orders >= 3 && x.prevOrders >= 1 && x.orders >= x.prevOrders * 1.5)
      .sort((a, b) => (b.orders / Math.max(1, b.prevOrders)) - (a.orders / Math.max(1, a.prevOrders)))
      .slice(0, 300)
      .map(({ p, orders, prevOrders, spend, sales }) => ({
        trigger: 'KEYWORD_RISING_STAR' as const,
        marketplace: p.marketplace,
        adTarget: { id: p.localEntityId, orders, previousOrders: prevOrders, spendCents: spend, salesCents: sales, roas: spend > 0 ? sales / spend : 0, growthPct: Math.round((orders / Math.max(1, prevOrders) - 1) * 100) },
      }))
  } catch (e) { logger.warn('[ads-rule-evaluator] buildRisingStarContexts failed', { error: (e as Error).message }); return [] }
}

// ── SOV_BID (SK4) — keyword bid adjustment driven by Share of Voice.
//
// 🔴 SOV-P1 (2026-08-22) — THE SHARE IS AMAZON'S NOW, NOT OURS.
//
// This builder used to take `sovPct` from `analyzeShareOfVoice()`, whose number is a query's
// impressions ÷ our OWN account's total impressions over every query and every marketplace — an
// impression MIX, not a share of any market. Measured on prod: median 0.0026 %, so
// `Share of Voice < 50 %` matched 1000 of 1000 rows and `< 1 %` matched 986; and against Amazon's
// own per-query share the two were NEGATIVELY rank-correlated (Spearman ρ = −0.2445 pooled,
// negative in all four markets), because a head query is a big slice of us and a tiny slice of the
// market while a tail query is the reverse. Our five strongest real positions all read ≈0.00x %,
// so "raise the bid where Share of Voice is low" bid UP on every one of them.
//
// The share now comes from `SearchQueryPerformance` — Amazon Brand Analytics' own
// `Σ impressionsBrand ÷ max impressionsTotal` per (marketplace × query), on the week the shared
// `chooseViewPeriod` gate picks, refusing any market whose newest week is truncated. See
// `ads-sov-keyword-share.service.ts` for the whole argument. Same thresholds now discriminate:
// `< 1 %` matches 29.8 % of rows instead of 98.6 %.
//
// `adTarget.id` still lets `bid_apply` act on the target; nothing about the action changed.
/**
 * Exported for verification, exactly as `buildCampaignBudgetContexts` above is: a probe that
 * re-implements the emitter to check it would be checking its own copy, which is how a verifier
 * comes to pass on code the engine does not run.
 */
export async function buildSovBidContexts() {
  try {
    const { keywordMarketShares, sovShareKey } = await import('../services/advertising/ads-sov-keyword-share.service.js')
    const { analyzeShareOfVoice } = await import('../services/advertising/ads-impression-share.service.js')
    const shares = await keywordMarketShares()
    if (!shares.byKey.size) return []

    /**
     * Campaign Concentration — how much of a query's impressions our single biggest campaign took.
     * This one IS ours to compute (it is a fact about our own account), so it still comes from
     * `analyzeShareOfVoice`, but with two corrections:
     *   · PER MARKET — the single unscoped call summed four marketplaces into one aggregate and
     *     handed a target the concentration of a query it never ran in (69 of 1,178 joins);
     *   · NO `limit` — the 1,000-row slice of a 2,379-query aggregate silently dropped 102 targets.
     */
    const concentration = new Map<string, number>()
    for (const marketplace of shares.measuredMarkets) {
      const own = await analyzeShareOfVoice({ windowDays: 30, marketplace, limit: Number.MAX_SAFE_INTEGER })
      for (const r of own.rows) concentration.set(sovShareKey(marketplace, r.query), r.topCampaignSharePct)
    }

    const targets = await prisma.adTarget.findMany({
      /**
       * 🔴 SOV-P2 — `status: 'ENABLED'` added, and it is a real narrowing.
       *
       * Without it this emitter offered ARCHIVED and PAUSED targets to the rule: measured on prod,
       * 183 of the 1,178 it matched were ARCHIVED and 42 PAUSED. An archived target cannot serve
       * and cannot be un-archived, so a bid written to one is a write that can never take effect —
       * it spends the rule's daily write cap and its execution cap to change nothing.
       *
       * The honest P2 preview is what surfaced it. With the status finally on screen, the panel was
       * offering a bid change on `motorradjacke herren [EXACT] ARCHIVED` — which is the preview
       * doing its job: it showed what the engine would really do, and what the engine would really
       * do was wrong.
       *
       * This matches the account's existing convention for target emitters —
       * `buildUnderperformContexts` has always filtered `status: 'ENABLED'`; SOV was the departure.
       * No live rule changes behaviour: 0 SOV rules exist.
       */
      where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED' },
      // P2.3 — carry the ad-group and campaign IDS. Without them contextIdentity() resolved
      // campaign/portfolio/product empty, so a SOV rule scoped to any grain but market silently
      // matched zero contexts forever — the rule looked armed and never fired.
      select: { id: true, expressionValue: true, adGroup: { select: { id: true, campaign: { select: { id: true, marketplace: true } } } } },
      take: 3000,
    })
    // P2.3 — perf comes from the daily table, never AdTarget's metric columns: those are
    // unpopulated account-wide (0 on all 2,129 keyword targets), so Spend/ACOS conditions could
    // never distinguish anything. 30-day window to match the SOV signal's own.
    // 🔴 No silent cap. `take: 3000` above bounds the population; the old `.slice(0, 1000)` on the
    // way out was a second, invisible bound on top of it. If the take itself ever binds, say so.
    if (targets.length >= 3000) {
      logger.warn('[ads-rule-evaluator] buildSovBidContexts hit its target cap — some keywords were not offered', { cap: 3000 })
    }
    const perfByTarget = await targetPerfMap(targets.map((t) => t.id), 30)
    return targets
      .map((t) => {
        const marketplace = t.adGroup?.campaign?.marketplace ?? null
        if (!marketplace) return null // a target with no market cannot be matched to a market's share
        const key = sovShareKey(marketplace, t.expressionValue)
        const s = shares.byKey.get(key)
        // No measured market share for this keyword IN ITS OWN MARKET → no context. Never a
        // fabricated 0: "Amazon reported no market total" and "we hold none of this market" are
        // different facts and this trigger must not collapse them.
        if (!s) return null
        return {
          trigger: 'SOV_BID' as const,
          marketplace,
          campaign: t.adGroup?.campaign?.id ? { id: t.adGroup.campaign.id } : undefined,
          adGroup: t.adGroup?.id ? { id: t.adGroup.id } : undefined,
          adTarget: {
            id: t.id,
            /**
             * Fractions (0..1).
             * · `sovPct` — Amazon's own share of THIS query's market that our ASINs took.
             * · `topSharePct` — our biggest campaign's share of the impressions WE took on it
             *   (cannibalisation). Null where we ran no ads on the query, which is a real state:
             *   a query can have a market share and no campaign concentration.
             * · `impressionSharePct` is GONE. It was assigned `s.sovPct` — the same number under a
             *   second name, so two builder metrics were byte-identical. The metric is removed from
             *   `SOV_METRIC` in the same change, so nothing compares against undefined.
             */
            sovPct: s.sharePct,
            // KT-P/C1 — absent where we ran no ads on the query in the window. As a null it read
            // as 0 and satisfied `Campaign Concentration < 60%`, which is the opposite of what a
            // missing concentration means (SOV-P measured 86 of 793 null, 4 matched).
            ...measured({ topSharePct: concentration.get(key) ?? null }),
            ...(perfByTarget.get(t.id) ?? EMPTY_TARGET_PERF),
          },
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  } catch (e) { logger.warn('[ads-rule-evaluator] buildSovBidContexts failed', { error: (e as Error).message }); return [] }
}

// P2.3 — shared 30d perf aggregate for the SOV/RANK context builders. Same fields and null
// semantics as the KEYWORD_HIGH_ACOS context, so one metric map serves all three.
/**
 * ── KT-P/C1 (2026-08-22) — an unmeasurable ratio is ABSENT, never null ────────────────────────
 *
 * 🔴 `applyOperator` (`automation-rule.service.ts:87`) coerces with `Number()`, and `Number(null)`
 * is **0** while `Number(undefined)` is `NaN`. Every comparison against `NaN` is false. So:
 *
 * | `adTarget.acos` | `<= 20%` | `>= 40%` |
 * |---|---|---|
 * | `null` (before) | **true** | false |
 * | key absent      | false    | false |
 *
 * A target with spend and ZERO SALES has no ACoS. As `null` it satisfied `ACOS <= 20%` and read as
 * a 0%-ACoS winner — so a Bid rule "ACoS ≤ 20% → raise bid" would have RAISED the bid on the
 * account's worst performers. Measured on prod 2026-08-22 over Bid's own 14 settled days:
 * **197 of 435 keyword targets with performance rows have spend and no sales, 196 of them in
 * write-enabled campaigns, carrying €713.47 of spend.**
 *
 * The fix is here rather than in `applyOperator`, which also serves fulfillment routing and
 * customer segments — changing the comparator moves every domain at once with no way to measure
 * per-surface. Omitting at the producer is the same correction, one builder at a time, and it is
 * the shape `PlacementLaneMetrics` above already uses.
 *
 * ⚠️ The counting fields stay 0, because a measured zero IS a measurement: 0 clicks means we know
 * there were none. Only the RATIOS — which are undefined rather than zero when their denominator
 * is 0 — become absent.
 */
const EMPTY_TARGET_PERF: { spendCents: number; salesCents: number; orders: number; clicks: number; impressions: number; acos?: number; roas?: number; ctr?: number; cvr?: number; cpcCents?: number } =
  { spendCents: 0, salesCents: 0, orders: 0, clicks: 0, impressions: 0 }
async function targetPerfMap(targetIds: string[], windowDays: number) {
  const map = new Map<string, typeof EMPTY_TARGET_PERF>()
  if (!targetIds.length) return map
  const settled = settledWhere(windowDays) // 6c — ends at the ad product's attribution lag
  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'AD_TARGET', localEntityId: { in: targetIds }, ...settled },
    _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true, impressions: true },
  })
  for (const p of perf) {
    const spendCents = microsToCents(p._sum.costMicros)
    const salesCents = p._sum.sales7dCents ?? 0
    const orders = p._sum.orders7d ?? 0
    const clicks = p._sum.clicks ?? 0
    const impressions = p._sum.impressions ?? 0
    map.set(p.localEntityId!, {
      spendCents, salesCents, orders, clicks, impressions,
      // KT-P/C1 — `measured()` drops each ratio whose denominator was 0, so it is ABSENT rather
      // than a null the comparator reads as zero. See EMPTY_TARGET_PERF's note.
      ...measured({
        acos: salesCents > 0 ? spendCents / salesCents : null,
        roas: spendCents > 0 ? salesCents / spendCents : null,
        ctr: impressions > 0 ? clicks / impressions : null,
        cvr: clicks > 0 ? orders / clicks : null,
        cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : null,
      }),
    })
  }
  return map
}

// ── KEYWORD_RANK_BID (SK4) — keyword bid adjustment driven by rank and search volume. For each positive
// keyword target, attach the latest KeywordRank (matched by lowercased text + marketplace) so a rule
// can e.g. raise the bid on a high-volume keyword that converts. What fills KeywordRank, and why organic
// and sponsored rank stay empty: services/advertising/keyword-rank-feed.service.ts (the weekly Brand
// Analytics feed fills searchVolume only; a rank comes only from a hand import).
/**
 * 🔴 KT-P3 (2026-08-22) — "not measurable" must OMIT THE KEY. `null` is not enough, and that is not
 * a style point: it is the difference between the rule refusing and the rule firing on everything.
 *
 * `applyOperator` (`automation-rule.service.ts:87`) coerces with `Number()`, and **`Number(null)` is
 * `0`**. So a `null` reading is byte-identical to a real zero for every numeric operator:
 *
 * | `adTarget.rankDelta` | `<= 0` | `>= 0` | `= 0` | `< 5` |
 * |---|---|---|---|---|
 * | `0` (the original)   | true | true | true | true |
 * | `null`               | **true** | **true** | **true** | **true** |
 * | key absent           | false | false | false | false |
 *
 * `Number(undefined)` is `NaN` and every comparison against `NaN` is false, so an ABSENT key is the
 * only value meaning "this rule cannot judge this target". The original defect was `rankDelta: … : 0`,
 * which told every `<= 0` rule that rank had held steady on a keyword we have never observed twice.
 * Nulling it would have compiled, reviewed and diffed clean — and changed nothing.
 *
 * ⚠ **The same trap is still live one layer out, and it is NOT KT's to fix.** `EMPTY_TARGET_PERF` and
 * `targetPerfMap` set `acos/roas/ctr/cvr/cpcCents` to `null`, so a target with spend and ZERO SALES
 * satisfies `ACOS <= 20%` and would have its bid RAISED as a 0%-ACoS winner. That map is shared with
 * the Bid and SOV tabs, where rules can actually fire, so changing it moves live bids and needs its
 * own operator decision (raised alongside KT-P6). Here the perf spread goes through `measured()` so
 * the KEYWORD_RANK_BID context is correct on its own terms; KT has 0 rules and 0 executions, so this
 * diverges from Bid/SOV in principle and from nothing in practice.
 */
const measured = <T extends Record<string, unknown>>(o: T): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v
  return out as Partial<T>
}

/**
 * KT-P3 — the scan cap is age-based, not alphabetical.
 *
 * `orderBy: [keyword asc, marketplace asc, capturedAt desc] take: 8000` meant that once the table
 * passed 8,000 rows, keywords late in the ALPHABET were dropped from every evaluation entirely — a
 * coverage cliff with no symptom, excluding a slice of the account from a rule that then reported
 * success. Ordering by `capturedAt desc` makes a truncation drop the OLDEST observations instead,
 * degrading one delta rather than removing keywords wholesale, and it says so when it binds.
 */
const KEYWORD_RANK_SCAN_CAP = 8000

/**
 * 4m (review 3.13) — a rank reading expires after 14 days.
 *
 * Readings arrive two ways: the weekly Brand Analytics feed (`keyword-rank-feed`, daily, one reading per
 * keyword per Amazon week, dated at the week's end) and `POST /advertising/keyword-ranks` (a hand
 * import). Weekly is the slowest cadence a rank rule is useful at; twice that lets one week be late
 * without the rule going blind, and nothing older drives a bid. Before this, a reading from months ago
 * moved bids as if it were today's. The value lives beside the feed (keyword-rank-feed.service.ts) so
 * its census reads the same limit; it is re-exported here, where it is applied.
 *
 * A stale reading is ABSENT, exactly like one the source never measured (KT-P3 above: absent, never
 * null or 0, so every rank condition refuses), and `adTarget.rankNote` says why in plain words. The
 * same limit holds for the reading before it: a "rank change" against a reading older than the limit
 * is not a recent change, so `rankDelta` is absent then too.
 */
export { KEYWORD_RANK_MAX_AGE_DAYS }

export async function buildKeywordRankBidContexts() {
  try {
    const freshSince = Date.now() - KEYWORD_RANK_MAX_AGE_DAYS * 864e5
    const ageDays = (d: Date) => Math.floor((Date.now() - d.getTime()) / 864e5)
    const ranks = await prisma.keywordRank.findMany({ orderBy: [{ capturedAt: 'desc' }], take: KEYWORD_RANK_SCAN_CAP })
    if (!ranks.length) return []
    if (ranks.length === KEYWORD_RANK_SCAN_CAP) {
      logger.warn('[ads-rule-evaluator] KeywordRank scan hit its cap — the oldest observations were not read', { cap: KEYWORD_RANK_SCAN_CAP })
    }
    /**
     * 🔴 KT-P3 — `prior` must come from the SAME ASIN as `latest`, or the delta is not a delta.
     *
     * `KeywordRank` carries an `asin`, but the collapse keyed on (keyword, marketplace) alone — so
     * with two ASINs tracked for one keyword, `latest` and `prior` were just the two newest rows
     * ACROSS ASINs, and `rankDelta` became *ASIN A's rank minus ASIN B's rank*: a cross-product
     * difference wearing a rank-change label, and largest exactly where we advertise one term on
     * several products.
     *
     * Rows arrive newest-first, so the first row seen per (keyword, marketplace, asin) is that
     * ASIN's latest and the second is its prior. The lookup stays per (keyword, marketplace) —
     * a target knows its keyword and market, not which ASIN was tracked — so the ASIN whose latest
     * observation is newest represents the pair, and its own prior travels with it.
     */
    const perAsin = new Map<string, { r: typeof ranks[number]; prior?: typeof ranks[number] }>()
    for (const r of ranks) {
      const k = `${r.keyword.trim().toLowerCase()}\u001f${r.marketplace}\u001f${r.asin ?? ''}`
      const e = perAsin.get(k)
      if (!e) perAsin.set(k, { r }); else if (!e.prior) e.prior = r
    }
    /**
     * Two sources write this table, and they measure different things: the Brand Analytics feed carries
     * search volume only (every rank NULL, asin NULL), a hand import may carry a rank. So a reading that
     * carries a rank represents the pair over one that does not, whatever their dates — or each weekly
     * volume reading would hide an imported rank. Among equals the newest wins, as before.
     */
    const carriesRank = (r: typeof ranks[number]) => r.organicRank != null || r.sponsoredRank != null
    const latest = new Map<string, { r: typeof ranks[number]; prior?: typeof ranks[number] }>()
    for (const [k, e] of perAsin) {
      const pairKey = k.slice(0, k.lastIndexOf('\u001f'))
      const held = latest.get(pairKey)
      const better = !held || (carriesRank(e.r) !== carriesRank(held.r) ? carriesRank(e.r) : e.r.capturedAt > held.r.capturedAt)
      if (better) latest.set(pairKey, e)
    }
    /**
     * Search volume is the keyword's in its market, not a product's or a source's: the newest reading that
     * carries one, whichever row represents the pair's rank. Rows arrive newest-first.
     */
    const volumeOf = new Map<string, typeof ranks[number]>()
    for (const r of ranks) {
      if (r.searchVolume == null) continue
      const pairKey = `${r.keyword.trim().toLowerCase()}\u001f${r.marketplace}`
      if (!volumeOf.has(pairKey)) volumeOf.set(pairKey, r)
    }
    const targets = await prisma.adTarget.findMany({
      /**
       * KT-P/C2 — `status: 'ENABLED'`, matching the convention every sibling builder already keeps
       * (`buildUnderperformContexts` always has; `buildSovBidContexts` since SOV-P1). A rule that
       * computes a bid for an archived or paused target is doing arithmetic nothing can deliver.
       *
       * Measured on prod 2026-08-22 over the 2,130 positive keyword targets this walked:
       * **ENABLED 1,777 · ARCHIVED 234 · PAUSED 119** — so 353 dead targets were being priced.
       *
       * ⚠️ Deliberately NOT filtering on the CAMPAIGN's status, though **1,228 of the 2,130 sit in a
       * PAUSED campaign** (901 in an enabled one). That is a larger population than the target
       * filter removes and arguably just as dead — but it is a different decision, it is not what
       * any sibling builder does, and quietly extending the convention here would make this builder
       * disagree with the other eleven. Raised for the operator separately rather than taken.
       */
      where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED' },
      // P2.3 — ids for contextIdentity (see buildSovBidContexts) + perf from the daily table,
      // never AdTarget's unpopulated metric columns.
      select: { id: true, expressionValue: true, adGroup: { select: { id: true, campaign: { select: { id: true, marketplace: true } } } } },
      take: 3000,
    })
    const perfByTarget = await targetPerfMap(targets.map((t) => t.id), 30)
    return targets
      .map((t) => {
        const kw = (t.expressionValue ?? '').trim().toLowerCase()
        const mkt = t.adGroup?.campaign?.marketplace ?? ''
        const pairKey = `${kw}\u001f${mkt}`
        const e = kw ? latest.get(pairKey) : undefined
        if (!e) return null // no rank snapshot for this keyword → skip
        const cur = e.r, prior = e.prior
        // 4m — a reading older than KEYWORD_RANK_MAX_AGE_DAYS is not used (see the note there).
        const curFresh = cur.capturedAt.getTime() >= freshSince
        const priorFresh = prior != null && prior.capturedAt.getTime() >= freshSince
        const vol = volumeOf.get(pairKey)
        const volFresh = vol != null && vol.capturedAt.getTime() >= freshSince
        // +ve delta = rank improved (the number went down). ABSENT — not 0 — when either end is missing or stale.
        const rankDelta = curFresh && priorFresh && prior?.organicRank != null && cur.organicRank != null ? prior.organicRank - cur.organicRank : undefined
        const rankNote = carriesRank(cur)
          ? !curFresh
            ? `Rank not used: the newest rank reading for this keyword is ${ageDays(cur.capturedAt)} days old, and readings older than ${KEYWORD_RANK_MAX_AGE_DAYS} days are ignored.`
            : prior != null && !priorFresh
              ? `Rank change not used: the reading before the newest is ${ageDays(prior.capturedAt)} days old, and readings older than ${KEYWORD_RANK_MAX_AGE_DAYS} days are ignored.`
              : undefined
          : vol != null && !volFresh
            ? `Search volume not used: the newest reading for this keyword is ${ageDays(vol.capturedAt)} days old, and readings older than ${KEYWORD_RANK_MAX_AGE_DAYS} days are ignored.`
            : undefined
        return {
          trigger: 'KEYWORD_RANK_BID' as const,
          marketplace: mkt || null,
          campaign: t.adGroup?.campaign?.id ? { id: t.adGroup.campaign.id } : undefined,
          adGroup: t.adGroup?.id ? { id: t.adGroup.id } : undefined,
          adTarget: {
            id: t.id,
            ...(curFresh ? measured({ organicRank: cur.organicRank, sponsoredRank: cur.sponsoredRank, rankDelta }) : {}),
            ...(volFresh ? measured({ searchVolume: vol.searchVolume }) : {}),
            ...(rankNote ? { rankNote } : {}),
            ...measured(perfByTarget.get(t.id) ?? EMPTY_TARGET_PERF),
          },
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, 1000)
  } catch (e) { logger.warn('[ads-rule-evaluator] buildKeywordRankBidContexts failed', { error: (e as Error).message }); return [] }
}

/**
 * ADS AUTONOMY W4-8 — `onLine` hears the tick's own summary line (the one its scheduled run records), or why it evaluated
 * nothing: what a hand-run records as its ONE run row (runAdvertisingRuleEvaluatorLineOnce). Callers without it are
 * unchanged.
 */
export async function runAdvertisingRuleEvaluatorOnce(opts: { onLine?: (line: string) => void } = {}): Promise<TickSummary> {
  const startedAt = Date.now()
  // AME.14 — global kill-switch. When set, NO advertising rule auto-applies
  // (the ultimate safety; per-rule enabled/dryRun guardrails are the finer
  // controls). Operable from Railway env or flipped via /autonomy/pause-all.
  if (process.env.NEXUS_ADS_AUTOMATION_KILL === '1') {
    logger.warn('[ads-rule-evaluator] global kill-switch active — skipping all rule evaluation')
    opts.onLine?.('skipped: NEXUS_ADS_AUTOMATION_KILL is set — no rule evaluated')
    return { fbaAgeContexts: 0, profitabilityContexts: 0, cacSpikeContexts: 0, underperformContexts: 0, campaignBudgetContexts: 0, totalEvaluations: 0, totalMatches: 0, totalCapped: 0, totalFailed: 0, durationMs: Date.now() - startedAt }
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
      opts.onLine?.('skipped: ads automation is halted, its autonomy is OFF, or its state could not be read — no rule evaluated')
      return { fbaAgeContexts: 0, profitabilityContexts: 0, cacSpikeContexts: 0, underperformContexts: 0, campaignBudgetContexts: 0, totalEvaluations: 0, totalMatches: 0, totalCapped: 0, totalFailed: 0, durationMs: Date.now() - startedAt }
    }
    forceDryRun = await shouldForceDryRun()
  } catch { /* state unavailable → fall through (env kill remains the backstop) */ }
  const [fbaAge, profitability, cacSpike, underperform, campaignBudget,
    zeroImpression, lowCtr, cvrDrop, wastedKeyword, searchTermConverting,
    highAcosKeyword, scaleOpportunity, adGroupUnderperform,
    newToBrandWinner, campaignNoSales,
    searchTermWasting, campaignRoasDeclining, risingStar,
    sovBid, keywordRankBid] = await Promise.all([
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
    buildSearchTermWastingContexts(),
    buildCampaignRoasDecliningContexts(),
    buildRisingStarContexts(),
    // ── SK4 — SOV + Keyword Tracker keyword-bid-adjustment rules ────────
    buildSovBidContexts(),
    buildKeywordRankBidContexts(),
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
  let totalCapped = 0
  let totalFailed = 0
  // ONE BRAIN AB-6 — the writes the rules left to a product's brain (or the Owner's lock) this tick, per lever.
  const totalLeverHeld: LeverSkipCounts = {}

  // BP.P4 — Bid rules that chose their own lookback get their own pass (`bidRuleWindow`, above).
  const bidWindowRules = await prisma.automationRule.findMany({
    where: { domain: 'advertising', trigger: 'KEYWORD_HIGH_ACOS', enabled: true },
    select: { actions: true },
  })
  const customWindows = [...new Set(bidWindowRules.map((r) => bidRuleWindow(r.actions)).filter((w): w is number => w != null))]
  const highAcosByWindow = await Promise.all(customWindows.map(async (w) =>
    [w, await buildHighAcosKeywordContexts(w)] as const))
  // 4f — builder Bid rules ride TARGET_PERFORMANCE, one pass per window in use (`targetPerformancePasses`).
  const targetPerformance = await targetPerformancePasses()

  // BUD-P3 · PLC-P5 — Budget and Placement rules that chose their own lookback (`campaignRuleWindow`).
  const budgetWindowRules = await prisma.automationRule.findMany({
    where: { domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true },
    select: { actions: true },
  })
  const budgetWindows = [...new Set(budgetWindowRules.map((r) => campaignRuleWindow(r.actions)).filter((w): w is number => w != null))]
  const budgetByWindow = await Promise.all(budgetWindows.map(async (w) =>
    [w, await buildCampaignBudgetContexts(w)] as const))

  type Pass = [string, Array<{ marketplace: string | null }>, ((r: { id: string; actions: unknown }) => boolean)?]
  const passes: Pass[] = [
    ['FBA_AGE_THRESHOLD_REACHED', fbaAge],
    ['AD_SPEND_PROFITABILITY_BREACH', profitability],
    ['CAC_SPIKE', cacSpike],
    ['AD_TARGET_UNDERPERFORMING', underperform],
    // Default window — Budget AND Placement rules that chose their own lookback are excluded here
    // and get their own pass below with contexts built over THEIR window (BUD-P3 · PLC-P5).
    ['CAMPAIGN_PERFORMANCE_BUDGET', campaignBudget, (r) => campaignRuleWindow(r.actions) == null],
    ...budgetByWindow.map(([w, ctxs]): Pass => (
      ['CAMPAIGN_PERFORMANCE_BUDGET', ctxs, (r) => campaignRuleWindow(r.actions) === w])),
    ['KEYWORD_ZERO_IMPRESSIONS', zeroImpression],
    ['KEYWORD_LOW_CTR', lowCtr],
    ['CVR_DROP', cvrDrop],
    ['KEYWORD_WASTED_SPEND', wastedKeyword],
    ['SEARCH_TERM_CONVERTING', searchTermConverting],
    // Default window — rules that chose their own lookback are excluded here and get their own
    // pass below with contexts built over THEIR window.
    ['KEYWORD_HIGH_ACOS', highAcosKeyword, (r) => bidRuleWindow(r.actions) == null],
    ...highAcosByWindow.map(([w, ctxs]): Pass => (
      ['KEYWORD_HIGH_ACOS', ctxs, (r) => bidRuleWindow(r.actions) === w])),
    ...targetPerformance,
    ['KEYWORD_SCALE_OPPORTUNITY', scaleOpportunity],
    ['AD_GROUP_UNDERPERFORMING', adGroupUnderperform],
    ['NEW_TO_BRAND_WINNER', newToBrandWinner],
    ['CAMPAIGN_NO_SALES', campaignNoSales],
    ['SEARCH_TERM_WASTING', searchTermWasting],
    ['CAMPAIGN_ROAS_DECLINING', campaignRoasDeclining],
    ['KEYWORD_RISING_STAR', risingStar],
    ['SOV_BID', sovBid],
    ['KEYWORD_RANK_BID', keywordRankBid],
    ['SCHEDULE', scheduleContexts],
  ]
  for (const [trigger, contexts, ruleFilter] of passes) {
    const r = await applyMarketplaceScope(trigger, contexts, forceDryRun, ruleFilter)
    totalEvaluations += r.evaluations
    totalMatches += r.matches
    totalCapped += r.capped
    totalFailed += r.failed
    addLeverSkipCounts(totalLeverHeld, r.leverHeld)
  }

  // SG.0 — the suggestion lifecycle sweep rides the tick (no separate cron): AFTER the passes,
  // so a change every rule just re-proposed carries a fresh `lastSeenAt` before expiry is judged.
  // The sweep swallows its own failures — hygiene must never fail the evaluation it rides.
  try {
    const { sweepSuggestionLifecycle } = await import('../services/advertising/ads-suggestions.service.js')
    const swept = await sweepSuggestionLifecycle()
    if (swept.expired > 0 || swept.reproposed > 0) {
      logger.info('[ads-rule-evaluator] suggestion lifecycle sweep', swept)
    }
  } catch { /* never fail the tick for queue hygiene */ }

  const summary: TickSummary = {
    fbaAgeContexts: fbaAge.length,
    profitabilityContexts: profitability.length,
    cacSpikeContexts: cacSpike.length,
    underperformContexts: underperform.length,
    campaignBudgetContexts: campaignBudget.length,
    totalEvaluations,
    totalMatches,
    totalCapped,
    totalFailed,
    durationMs: Date.now() - startedAt,
  }
  lastRunAt = new Date()
  lastSummary = `fba=${fbaAge.length} prof=${profitability.length} cac=${cacSpike.length} under=${underperform.length} schedule=${scheduleContexts.length} evals=${totalEvaluations} matches=${totalMatches} capped=${totalCapped} failed=${totalFailed}${leverSkipNote(totalLeverHeld)} durationMs=${summary.durationMs}`
  opts.onLine?.(lastSummary)
  return summary
}

/**
 * ADS AUTONOMY W4-8 (the ACR.1.2d form, as ads-sync-drain.job.ts) — the tick's work AND its own summary line, without
 * the CronRun wrapper, for the manual-trigger registry: a hand-run (the Sync Logs hub's Run now, Claude's
 * run-ad-engine-now) records ONE honest row — `manual`, this run's own line, FAILED when it throws. Registering
 * runAdvertisingRuleEvaluatorCron wrote two rows per hand-run (a `manual` one saying the module's last line, often a
 * scheduled run's, and a nested `cron` one), and the wrapper's catch made a failed run read as a success.
 */
export async function runAdvertisingRuleEvaluatorLineOnce(): Promise<string> {
  let line = ''
  await runAdvertisingRuleEvaluatorOnce({ onLine: (said) => { line = said } })
  return line || 'no-summary'
}

/**
 * RA.AUTO — simulate ONE rule against real current data, and write nothing.
 *
 * This replaces what `POST /advertising/automation-rules/:id/simulate` used to do, which was
 * `void runAdvertisingRuleEvaluatorOnce()` — the entire evaluator, all 21 triggers, every enabled
 * rule, with no forced dry-run. Its comment claimed "dry-run forced for safety" and the only
 * thing forcing dry-run in that path is the ACCOUNT-level SUGGEST posture, which is off. So
 * pressing Simulate on one PROPOSE rule handed the eight writing AUTO rules a live tick, and
 * because the call was not awaited it returned before anything happened and could never report
 * what the rule would have done. Nothing in the UI called it, which is the only reason this was
 * a latent hazard rather than an incident.
 *
 * Four things make this safe, and all four are required:
 *   · `ruleIds: [ruleId]` — no other rule is evaluated, so no other rule can act
 *   · `forceDryRun: true` — this rule cannot write either, whatever its autonomy says
 *   · `isTestRun: true`   — and it cannot leave a proposal in the Suggestions queue
 *   · `noPersist: true`   — and it leaves no run row and raises no counter (R3, below)
 *
 * `ignoreEnabled` lets a DISABLED rule be simulated without arming it, which is the main case:
 * 29 of the 51 rules are off, and "what would this do" is the question you ask before turning one
 * on. The old `/test` route answered it by writing `enabled: true` and hoping to write it back.
 *
 * R3 (MCP full control, part 06 gap 6) — and it writes no `AutomationRuleExecution` row and raises no
 * `evaluationCount` / `matchCount` / `executionCount`. It used to record one row per context, exactly as a dry-run
 * tick does, and the graduation gate counts those numbers ("10 evaluations", "1 match"), so a few simulations could
 * open the road to Auto for a rule that never ran on a tick; the rows also spent the rule's own daily cap.
 *
 * R8 — and it notifies nobody: `notify` and `alert_operator` see `meta.preview` and report whom they would reach (a
 * tick's dry run still notifies, by design). Nothing reaches Amazon.
 */
export async function simulateOneRule(ruleId: string): Promise<{
  ok: boolean
  error?: string
  ruleName?: string
  trigger?: string
  enabled?: boolean
  /** Contexts the rule's trigger produced from current data, before scope filtering. */
  contextsBuilt?: number
  /** Contexts left after the rule's own market/portfolio/campaign scope. */
  contextsInScope?: number
  matched?: number
  results?: Array<{
    matched: boolean
    status: string
    errorMessage?: string
    actions: Array<{ type?: string; ok?: boolean; error?: string; output?: unknown }>
  }>
}> {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      id: true, name: true, domain: true, trigger: true, enabled: true,
      scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
      // 4a — the picker list and the rule's own lookback live on the stored action.
      actions: true,
    },
  })
  if (!rule || rule.domain !== 'advertising') return { ok: false, error: 'not_found' }

  // Only the builder for THIS rule's trigger runs. The old route's cost was building all 21.
  const BUILDERS: Record<string, () => Promise<Array<{ marketplace: string | null }>>> = {
    FBA_AGE_THRESHOLD_REACHED: buildFbaAgeContexts,
    AD_SPEND_PROFITABILITY_BREACH: buildProfitabilityContexts,
    CAC_SPIKE: buildCacSpikeContexts,
    AD_TARGET_UNDERPERFORMING: buildUnderperformContexts,
    CAMPAIGN_PERFORMANCE_BUDGET: buildCampaignBudgetContexts,
    KEYWORD_ZERO_IMPRESSIONS: buildZeroImpressionContexts,
    KEYWORD_LOW_CTR: buildLowCtrContexts,
    CVR_DROP: buildCvrDropContexts,
    KEYWORD_WASTED_SPEND: buildWastedKeywordContexts,
    SEARCH_TERM_CONVERTING: buildSearchTermConvertingContexts,
    KEYWORD_HIGH_ACOS: buildHighAcosKeywordContexts,
    TARGET_PERFORMANCE: buildTargetPerformanceContexts,
    KEYWORD_SCALE_OPPORTUNITY: buildScaleOpportunityContexts,
    AD_GROUP_UNDERPERFORMING: buildAdGroupUnderperformContexts,
    NEW_TO_BRAND_WINNER: buildNewToBrandWinnerContexts,
    CAMPAIGN_NO_SALES: buildCampaignNoSalesContexts,
    SEARCH_TERM_WASTING: buildSearchTermWastingContexts,
    CAMPAIGN_ROAS_DECLINING: buildCampaignRoasDecliningContexts,
    KEYWORD_RISING_STAR: buildRisingStarContexts,
    SOV_BID: buildSovBidContexts,
    KEYWORD_RANK_BID: buildKeywordRankBidContexts,
  }

  let contexts: Array<{ marketplace: string | null }>
  if (rule.trigger === 'SCHEDULE') {
    // SCHEDULE has no builder — the tick synthesises one context per active marketplace,
    // carrying month-to-date spend so the budget-cap rules can evaluate. Mirrored here rather
    // than extracted, because the tick's version also feeds 22 other triggers in one pass.
    const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const spend = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['marketplace'],
      where: { entityType: 'CAMPAIGN', date: { gte: monthStart } },
      _sum: { costMicros: true },
    })
    const byMkt = new Map(spend.map((r) => [r.marketplace, microsToCents(r._sum.costMicros)]))
    contexts = [...new Set(conns.map((c) => c.marketplace))].map((mkt) => ({
      trigger: 'SCHEDULE' as const,
      marketplace: mkt,
      budget: { monthlySpendCents: byMkt.get(mkt) ?? 0 },
    }))
  } else {
    const build = BUILDERS[rule.trigger]
    if (!build) return { ok: false, error: `no context builder for trigger ${rule.trigger}`, ruleName: rule.name, trigger: rule.trigger }
    /**
     * 4a (review 4.14) — the rule's OWN lookback, exactly as the tick's per-window passes build it.
     * A Bid rule on 30 days, or a Budget/Placement rule on 14, used to be simulated over the
     * trigger's default window — numbers the real run never sees.
     */
    const ownWindow = rule.trigger === 'KEYWORD_HIGH_ACOS' || rule.trigger === 'TARGET_PERFORMANCE' ? bidRuleWindow(rule.actions, rule.trigger)
      : rule.trigger === 'CAMPAIGN_PERFORMANCE_BUDGET' ? campaignRuleWindow(rule.actions)
        : null
    contexts = ownWindow == null ? await build()
      : rule.trigger === 'KEYWORD_HIGH_ACOS' ? await buildHighAcosKeywordContexts(ownWindow)
        : rule.trigger === 'TARGET_PERFORMANCE' ? await buildTargetPerformanceContexts(ownWindow)
          : await buildCampaignBudgetContexts(ownWindow)
  }

  /**
   * 4a (review 4.14) — the campaigns the rule is BOUND to (budget assignment, or the builder's
   * picker list), from the resolver the tick uses. Simulate used to skip this entirely, so a
   * simulated budget or placement rule reported every campaign in its market.
   */
  const { resolveAssignedCampaignIds } = await import('../services/advertising/ads-rule-scope-resolver.js')
  const assignedCampaignIds = (await resolveAssignedCampaignIds([rule])).get(rule.id) ?? null

  // Same scope enforcement as the real tick, so a simulation cannot claim reach the rule
  // would not have. Identity maps only matter when the rule scopes below marketplace.
  const extToLocal = new Map<string, string>()
  const localToPortfolio = new Map<string, string | null>()
  if (rule.scopePortfolioId != null || rule.scopeCampaignId != null || assignedCampaignIds != null) {
    const exts = new Set<string>(); const locals = new Set<string>()
    for (const ctx of contexts) {
      const c = ctx as unknown as { campaign?: { id?: string }; searchTerm?: { externalCampaignId?: string } }
      if (c.campaign?.id) locals.add(c.campaign.id)
      if (c.searchTerm?.externalCampaignId) exts.add(c.searchTerm.externalCampaignId)
    }
    const camps = await prisma.campaign.findMany({
      where: { OR: [
        ...(locals.size ? [{ id: { in: [...locals] } }] : []),
        ...(exts.size ? [{ externalCampaignId: { in: [...exts] } }] : []),
      ] },
      select: { id: true, externalCampaignId: true, portfolioId: true },
    })
    for (const c of camps) {
      if (c.externalCampaignId) extToLocal.set(c.externalCampaignId, c.id)
      localToPortfolio.set(c.id, c.portfolioId)
    }
  }

  /**
   * RA.GRAIN — a simulation must honour the product grain too, or it reports a reach the real
   * tick would not produce. Same expansion as `applyMarketplaceScope`, for one rule.
   */
  let expandedProductIds: string[] | null = null
  const simProductsByAdGroup = new Map<string, string[]>()
  const simProductsByCampaign = new Map<string, string[]>()
  if (rule.scopeProductId) {
    const { expandProductScope } = await import('../services/advertising/ads-scope-reach.js')
    expandedProductIds = await expandProductScope(rule.scopeProductId)
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: expandedProductIds } },
      select: { productId: true, adGroupId: true, adGroup: { select: { campaignId: true } } },
    })
    for (const a of ads) {
      if (!a.productId) continue
      const ag = simProductsByAdGroup.get(a.adGroupId) ?? []
      if (!ag.includes(a.productId)) { ag.push(a.productId); simProductsByAdGroup.set(a.adGroupId, ag) }
      const cid = a.adGroup?.campaignId
      if (cid) {
        const cp = simProductsByCampaign.get(cid) ?? []
        if (!cp.includes(a.productId)) { cp.push(a.productId); simProductsByCampaign.set(cid, cp) }
      }
    }
  }

  const inScope = contexts.filter((ctx) => ruleMatchesScope(
    { ...rule, scopeProductIds: expandedProductIds, assignedCampaignIds },
    contextIdentity(ctx, extToLocal, localToPortfolio, simProductsByAdGroup, simProductsByCampaign),
  ))

  /**
   * Register the ads action handlers before evaluating, because nothing else here guarantees it.
   *
   * `automation-action-handlers.ts` mutates the exported `ACTION_HANDLERS` map as a module-load
   * side effect, and its ONLY importer is `index.ts:1435` — inside `if (adsCronOn)`. So on any
   * instance where ads crons are off, every ads action resolves to no handler and comes back
   * `Unknown action type: retail_guard`.
   *
   * Measured, and it is why this line exists: the first verification run of this function (from a
   * script, outside the server) reported exactly that for `alert_operator` and `retail_guard` —
   * both of which have handlers. A simulation that reports "unknown action" for a rule that works
   * is worse than no simulation, because it reads as a broken rule rather than a broken probe.
   * Importing here is idempotent and makes this function true regardless of who booted what.
   */
  await import('../services/advertising/automation-action-handlers.js')

  const { evaluateRule } = await import('../services/automation-rule.service.js')
  const results: Array<{ matched: boolean; status: string; errorMessage?: string; actions: Array<{ type?: string; ok?: boolean; error?: string; output?: unknown }> }> = []
  for (const ctx of inScope) {
    const r = await evaluateRule({ ruleId: rule.id, context: ctx, forceDryRun: true, isTestRun: true, ignoreEnabled: true, noPersist: true })
    results.push({
      matched: r.matched,
      status: r.status,
      errorMessage: r.errorMessage,
      actions: (r.actionResults ?? []).map((a) => ({ type: a.type, ok: a.ok, error: a.error, output: a.output })),
    })
  }

  return {
    ok: true,
    ruleName: rule.name,
    trigger: rule.trigger,
    enabled: rule.enabled,
    contextsBuilt: contexts.length,
    contextsInScope: inScope.length,
    matched: results.filter((r) => r.matched).length,
    results,
  }
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
  scheduledTask = cron.schedule(schedule, async () => {
    await runAdvertisingRuleEvaluatorCron()
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
