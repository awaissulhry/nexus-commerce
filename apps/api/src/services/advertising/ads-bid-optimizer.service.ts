/**
 * AX.8 — Target-ACOS bid optimization.
 *
 * For each enabled keyword/target with spend, move the bid toward a target
 * ACOS: if ACOS is above target → cut the bid proportionally; if below
 * target with conversions → raise it (capped). Zero-sale spenders get a
 * hard cut. Guardrailed: €0.05 floor, max ±change %, only acts on targets
 * with enough signal. preview() returns proposed changes; apply() writes
 * via the shipped bulkUpdateAdTargetBids (grace window + audit + sync).
 *
 * Also exposes a `bid_to_target_acos` automation handler so a rule can run
 * it on a schedule (registered into ACTION_HANDLERS by side-effect import).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { bulkUpdateAdTargetBids } from './ads-mutation.service.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { computeAdGroupTargetAcos, type AcosMode } from './ads-target-acos.service.js'
import { fitBetaPrior, shrunkConversionRate, dataConfidence } from './ads-bayesian-bidding.service.js'

const FLOOR_CENTS = 5
const MAX_DOWN = 0.5 // never cut a bid by more than 50% in one pass
const MAX_UP = 0.25 // never raise by more than 25% in one pass
const MIN_CLICKS = 5 // need signal before acting

/** Trailing window when reading the daily table. Matches the 30d the console reports on. */
const DAILY_WINDOW_DAYS = 30

export type BidMetricSource = 'legacy' | 'daily'

/**
 * ACR.4.5 — where this engine's per-target metrics come from.
 *
 * `legacy` reads `AdTarget.spendCents/.clicks/.salesCents/.ordersCount`. Those columns are ZERO
 * on all 5,204 rows and will stay zero: their only writer is `ads-metrics-ingest`, whose cron
 * was retired in H.2e and never started since — measured, zero `CronRun` rows have ever existed
 * for it. The replacement (the Phase 11 v1-export pipeline) populates `AmazonAdsDailyPerformance`
 * and does not denormalise. So `legacy` means "propose nothing", which is exactly what four AUTO
 * rules have been doing across ~1,174 successful, empty executions.
 *
 * `daily` rolls the same figures up from `AmazonAdsDailyPerformance` — the move
 * `ad-autopilot.job.ts` already made for its own signals. Deliberately NOT re-starting the
 * retired ingest: that would recreate a second copy of the truth, and a denormalised copy is a
 * copy that drifts.
 *
 * **Default is `legacy`, so deploying this changes nothing.** The switch is one env var, and it
 * is a real switch: this function is the shared upstream of the APPLY path too
 * (`ads-auto-bid`, `autopilot/apply`), so flipping it does not merely reveal proposals — it lets
 * four AUTO rules start writing bids. Measured on prod with the suppression guard below in
 * force: 52 proposals, net −314¢, touching €1,555 of 30-day spend, and 300 suppressed/sub-floor
 * targets correctly excluded. A caller can pass `source` explicitly to inspect the `daily` view
 * without arming anything.
 */
export function resolveSource(explicit?: BidMetricSource): BidMetricSource {
  if (explicit) return explicit
  return process.env.NEXUS_BID_OPTIMIZER_SOURCE === 'daily' ? 'daily' : 'legacy'
}

export interface BidProposal {
  targetId: string; expression: string; matchType: string
  currentBidCents: number; proposedBidCents: number; deltaCents: number
  acos: number | null; spendCents: number; salesCents: number; clicks: number; reason: string
  // Apex C.2 — the target ACOS actually used for this target + where it came from.
  // Apex C.3 adds 'bayesian' when the decision used a shrunk CR (sparse-data path).
  targetAcosUsed: number; targetBasis: 'flat' | 'profit' | 'bayesian'
}

export async function previewBidOptimization(
  opts: { targetAcos?: number; campaignId?: string; profitMode?: boolean; mode?: AcosMode; bayesian?: boolean; source?: BidMetricSource } = {},
): Promise<{ targetAcos: number; profitMode: boolean; bayesian: boolean; proposals: BidProposal[] }> {
  const flatTargetAcos = opts.targetAcos ?? 0.3 // 30% default fallback
  const profitMode = opts.profitMode ?? false
  const bayesian = opts.bayesian ?? false
  /**
   * ACR.6 — SUPPRESSED TARGETS ARE EXCLUDED, and this guard predates the bug it prevents.
   *
   * This account does not pause; it silences by dropping bids to ~2¢ (no-pause policy), and
   * `suppressedFromBidCents` records the bid to restore when the campaign resumes. FLOOR_CENTS is
   * 5, so this engine's own "hard cut" arithmetic — `max(FLOOR, bid × 0.5)` — turns into a RAISE
   * for anything already below the floor. A cut that raises a bid is not a cut.
   *
   * Measured on prod 2026-08-05 (`scripts/_acr6-bidopt-whatif.mts`, read-only): had this engine
   * been fed live metrics, 51 of the 103 proposals it would have generated were raises on targets
   * bidding under 5¢, carrying €1,316.41 of 30d spend that would have resumed. 451 of the 600
   * sub-floor targets carry the marker; the rest are sub-floor without it, which is why both
   * conditions are needed rather than either alone.
   *
   * This costs nothing today — the engine proposes zero, because `spendCents` is 0 on every row
   * since its only writer (ads-metrics-ingest) was retired in H.2e. It is here so that whoever
   * repoints this at AmazonAdsDailyPerformance, as ad-autopilot.job.ts already did for its own
   * signals, cannot un-suppress the account as a side effect of turning the lights back on.
   */
  /**
   * ACR.4.5 — the metric overlay. Everything below this point is untouched: the same guard, the
   * same Bayesian and profit-mode branches, the same clamps. Only where four numbers come from
   * changes, which is the whole of the fix and the reason it is safe to make.
   */
  const source = resolveSource(opts.source)
  let dailyMetrics: Map<string, { spendCents: number; salesCents: number; clicks: number; ordersCount: number }> | null = null
  if (source === 'daily') {
    const since = new Date(Date.now() - DAILY_WINDOW_DAYS * 86_400_000)
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', date: { gte: since }, localEntityId: { not: null } },
      _sum: { costMicros: true, clicks: true, sales7dCents: true, orders7d: true },
    })
    dailyMetrics = new Map()
    for (const p of perf) {
      const spendCents = Math.round(Number(p._sum.costMicros ?? 0) / 10_000)
      // `spendCents > 0` was the legacy WHERE clause; it becomes this filter, so the engine still
      // only considers targets that actually spent something.
      if (spendCents <= 0) continue
      dailyMetrics.set(p.localEntityId!, {
        spendCents,
        salesCents: Number(p._sum.sales7dCents ?? 0),
        clicks: Number(p._sum.clicks ?? 0),
        ordersCount: Number(p._sum.orders7d ?? 0),
      })
    }
  }

  const where: Record<string, unknown> = {
    status: 'ENABLED',
    isNegative: false,
    suppressedFromBidCents: null,
    bidCents: { gte: FLOOR_CENTS },
    // An empty map matches nothing, which is the correct answer when no target spent anything.
    ...(dailyMetrics ? { id: { in: [...dailyMetrics.keys()] } } : { spendCents: { gt: 0 } }),
  }
  if (opts.campaignId) where.adGroup = { campaignId: opts.campaignId }
  const rawTargets = await prisma.adTarget.findMany({
    where, take: 2000,
    select: {
      id: true, expressionValue: true, expressionType: true, bidCents: true, spendCents: true,
      salesCents: true, clicks: true, ordersCount: true, adGroupId: true,
      adGroup: { select: { campaign: { select: { marketplace: true } } } },
    },
  })

  // Overlay, rather than a parallel code path — a second implementation of this arithmetic is
  // how the two would drift.
  const targets = dailyMetrics
    ? rawTargets.map((t) => {
      const m = dailyMetrics!.get(t.id)
      return m ? { ...t, spendCents: m.spendCents, salesCents: m.salesCents, clicks: m.clicks, ordersCount: m.ordersCount } : t
    })
    : rawTargets

  // Apex C.3 — Bayesian sparse-data path: fit a pooled CR prior + pool AOV from
  // the corpus, so we can make a principled (gentle) decision on low-click
  // targets the flat path skips, using a shrunk CR → expected ACOS instead of
  // the noisy observed ACOS.
  const prior = bayesian ? fitBetaPrior(targets.map((t) => ({ orders: t.ordersCount ?? 0, clicks: t.clicks }))) : null
  let poolAovCents = 5000
  if (bayesian) {
    const totOrders = targets.reduce((s, t) => s + (t.ordersCount ?? 0), 0)
    const totSales = targets.reduce((s, t) => s + t.salesCents, 0)
    if (totOrders > 0) poolAovCents = Math.round(totSales / totOrders)
  }
  // In Bayesian mode a lower click floor still yields a principled estimate (the
  // prior carries the rest); the flat path needs MIN_CLICKS of its own signal.
  const clickFloor = bayesian ? 1 : MIN_CLICKS

  // Apex C.2 — when profitMode, resolve each ad group's profit-derived target
  // ACOS once (revenue-weighted across its advertised products) and use it
  // instead of the flat 30%. Falls back to flat per ad group with no profit data.
  const acosByAdGroup = new Map<string, number>()
  if (profitMode) {
    const adGroupIds = [...new Set(targets.map((t) => t.adGroupId))]
    for (const agId of adGroupIds) {
      const mkt = targets.find((t) => t.adGroupId === agId)?.adGroup?.campaign?.marketplace ?? null
      const r = await computeAdGroupTargetAcos(agId, { marketplace: mkt, mode: opts.mode })
      if (r.targetAcos != null) acosByAdGroup.set(agId, r.targetAcos)
    }
  }

  const proposals: BidProposal[] = []
  for (const t of targets) {
    if (t.clicks < clickFloor) continue
    const fromProfit = profitMode && acosByAdGroup.has(t.adGroupId)
    const targetAcos = fromProfit ? acosByAdGroup.get(t.adGroupId)! : flatTargetAcos
    const observedAcos = t.salesCents > 0 ? t.spendCents / t.salesCents : null
    let proposed = t.bidCents
    let reason = ''
    let targetBasis: 'flat' | 'profit' | 'bayesian' = fromProfit ? 'profit' : 'flat'

    if (bayesian && prior) {
      // Shrink CR toward the pool, derive an EXPECTED ACOS, and move toward
      // target. Works even at 0 observed sales (the prior gives a non-zero CR),
      // so sparse keywords get a gentle, principled bid instead of being skipped
      // or hard-cut on noise.
      const crS = shrunkConversionRate(t.ordersCount ?? 0, t.clicks, prior)
      const aovCents = (t.ordersCount ?? 0) > 0 ? t.salesCents / (t.ordersCount ?? 1) : poolAovCents
      const expectedSalesCents = t.clicks * crS * aovCents
      const expAcos = expectedSalesCents > 0 ? t.spendCents / expectedSalesCents : null
      if (expAcos == null) continue
      const conf = dataConfidence(t.clicks, prior)
      targetBasis = 'bayesian'
      const tag = `Bayesian CR ${(crS * 100).toFixed(1)}% · ${(conf * 100).toFixed(0)}% data-confidence`
      if (expAcos > targetAcos) {
        const ratio = Math.max(1 - MAX_DOWN, targetAcos / expAcos)
        proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * ratio))
        reason = `exp.ACOS ${(expAcos * 100).toFixed(0)}% > target ${(targetAcos * 100).toFixed(0)}% — lower (${tag})`
      } else if (expAcos < targetAcos) {
        const ratio = Math.min(1 + MAX_UP, targetAcos / expAcos)
        proposed = Math.round(t.bidCents * ratio)
        reason = `exp.ACOS ${(expAcos * 100).toFixed(0)}% < target ${(targetAcos * 100).toFixed(0)}% — raise (${tag})`
      } else continue
    } else if (t.salesCents === 0) {
      // Spending with no sales → cut hard toward the floor.
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * (1 - MAX_DOWN)))
      reason = `${t.clicks} clicks, 0 sales — cut ${Math.round(MAX_DOWN * 100)}%`
    } else if (observedAcos != null && observedAcos > targetAcos) {
      const ratio = Math.max(1 - MAX_DOWN, targetAcos / observedAcos)
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * ratio))
      reason = `ACOS ${(observedAcos * 100).toFixed(0)}% > target ${(targetAcos * 100).toFixed(0)}%${fromProfit ? ' (profit-derived)' : ''} — lower`
    } else if (observedAcos != null && observedAcos < targetAcos && t.ordersCount >= 1) {
      const ratio = Math.min(1 + MAX_UP, targetAcos / observedAcos)
      proposed = Math.round(t.bidCents * ratio)
      reason = `ACOS ${(observedAcos * 100).toFixed(0)}% < target ${(targetAcos * 100).toFixed(0)}%${fromProfit ? ' (profit-derived)' : ''} — raise to capture volume`
    } else continue
    const acos = observedAcos
    if (proposed === t.bidCents) continue
    proposals.push({ targetId: t.id, expression: t.expressionValue, matchType: t.expressionType, currentBidCents: t.bidCents, proposedBidCents: proposed, deltaCents: proposed - t.bidCents, acos, spendCents: t.spendCents, salesCents: t.salesCents, clicks: t.clicks, reason, targetAcosUsed: targetAcos, targetBasis })
  }
  proposals.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
  return { targetAcos: flatTargetAcos, profitMode, bayesian, proposals }
}

export async function applyBidOptimization(args: { changes: Array<{ targetId: string; proposedBidCents: number }>; actor?: string; dryRun?: boolean }): Promise<{ applied: number; dryRun: boolean }> {
  if (args.dryRun) return { applied: 0, dryRun: true }
  const updates = args.changes.map((c) => ({ id: c.targetId, newBidCents: c.proposedBidCents }))
  if (updates.length === 0) return { applied: 0, dryRun: false }
  await bulkUpdateAdTargetBids({ updates, actor: args.actor ?? 'bid-optimizer', reason: 'AX.8 target-ACOS optimization' } as never)
  logger.info('[AX.8] bid optimization applied', { count: updates.length })
  return { applied: updates.length, dryRun: false }
}

// ── Automation handler: bid_to_target_acos ────────────────────────────────
ACTION_HANDLERS.bid_to_target_acos = async (action, _context, meta): Promise<ActionResult> => {
  const targetAcos = typeof action.targetAcos === 'number' ? (action.targetAcos as number) : 0.3
  const campaignId = typeof action.campaignId === 'string' ? (action.campaignId as string) : undefined
  // Apex C.2 — a rule can opt into profit-native per-SKU target ACOS.
  const profitMode = action.profitMode === true || action.profitMode === 'true'
  const mode = typeof action.acosMode === 'string' ? (action.acosMode as AcosMode) : undefined
  // Apex C.3 — a rule can opt into Bayesian sparse-data handling.
  const bayesian = action.bayesian === true || action.bayesian === 'true'
  const { proposals } = await previewBidOptimization({ targetAcos, campaignId, profitMode, mode, bayesian })
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, wouldChange: proposals.length, sample: proposals.slice(0, 5) } }
  const r = await applyBidOptimization({ changes: proposals.map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents })), actor: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { applied: r.applied } }
}

logger.debug('[AX.8] bid_to_target_acos handler registered')
