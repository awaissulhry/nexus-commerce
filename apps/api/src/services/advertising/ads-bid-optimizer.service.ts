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
import { bulkUpdateAdTargetBids, type AdsActor } from './ads-mutation.service.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { computeAdGroupTargetAcos, type AcosMode } from './ads-target-acos.service.js'
import { fitBetaPrior, shrunkConversionRate, dataConfidence } from './ads-bayesian-bidding.service.js'
import { ACTION_WINDOW } from '@nexus/shared/ads-rule-window'

const FLOOR_CENTS = 5
const MAX_DOWN = 0.5 // never cut a bid by more than 50% in one pass
const MAX_UP = 0.25 // never raise by more than 25% in one pass
const MIN_CLICKS = 5 // need signal before acting

/**
 * Trailing window when reading the daily table. Matches the 30d the console reports on.
 *
 * B2 (2026-08-20) — read from `@nexus/shared/ads-rule-window`, the same table the Rules &
 * Automation grid's Lookback column renders, so the number an operator is shown for a
 * `bid_to_target_acos` rule is this number and cannot drift from it. Four of the eighteen bid
 * rules compute their bids here, three of them at AUTO.
 *
 * 🔴 **This window is NOT settled, and that is a real difference from every trigger window.**
 * The `since` below is a bare `Date.now() - Nd`, so it includes D-0 and D-1 — the two days Amazon
 * is still attributing conversions to — while all thirteen trigger windows go through
 * `ruleWindowBounds`, which drops them. The effect is one-directional: today's spend is already
 * recorded but today's sales are not, so every target looks less profitable than it is at the
 * moment its bid is decided. The grid now SAYS so on each affected row rather than printing a
 * bare "30 days" that reads the same as a settled one. Left as-is on purpose — changing it moves
 * live bids on three AUTO rules, which is an operator decision, not a tidy-up.
 */
const DAILY_WINDOW_DAYS = ACTION_WINDOW.bid_to_target_acos.days as number

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

export async function applyBidOptimization(args: {
  changes: Array<{ targetId: string; proposedBidCents: number }>; actor?: string; dryRun?: boolean
  /** SG.10 (additive) — group the batch into ONE reversible change set (see bulkUpdateAdTargetBids). */
  changeSetId?: string | null
}): Promise<{
  applied: number; dryRun: boolean
  /**
   * SG.10 (additive) — the receipts this function used to discard. `actionLogIds[0]` is enough
   * to undo the WHOLE batch when a changeSetId was passed, because rollback follows the set.
   * Existing callers read `applied`/`dryRun` and are unaffected.
   */
  actionLogIds?: string[]
  outboundQueueIds?: string[]
}> {
  if (args.dryRun) return { applied: 0, dryRun: true }
  // Pre-F fix (NAF V9): this used to pass `{updates}` (with {id,
  // newBidCents} rows) into a function whose contract is `{entries:
  // [{adTargetId, bidCents}]}`, silenced by `as never` — so every
  // non-dry-run apply crashed on `entries.length` before writing. The
  // engine's Off dial is why nobody hit it.
  const entries = args.changes.map((c) => ({ adTargetId: c.targetId, bidCents: c.proposedBidCents }))
  if (entries.length === 0) return { applied: 0, dryRun: false }
  const actor: AdsActor = args.actor?.startsWith('user:')
    ? (args.actor as AdsActor)
    : `automation:${args.actor ?? 'bid-optimizer'}`
  const out = await bulkUpdateAdTargetBids({ entries, actor, reason: 'AX.8 target-ACOS optimization', changeSetId: args.changeSetId ?? null })
  logger.info('[AX.8] bid optimization applied', { count: out.applied, skipped: out.skipped, failed: out.failed })
  return {
    applied: out.applied, dryRun: false,
    actionLogIds: out.outcomes.map((o) => o.actionLogId).filter((x): x is string => !!x),
    outboundQueueIds: out.outcomes.map((o) => o.outboundQueueId).filter((x): x is string => !!x),
  }
}

// ── Automation handler: bid_to_target_acos ────────────────────────────────
ACTION_HANDLERS.bid_to_target_acos = async (action, _context, meta): Promise<ActionResult> => {
  const targetAcos = typeof action.targetAcos === 'number' ? (action.targetAcos as number) : 0.3
  const campaignId = typeof action.campaignId === 'string' ? (action.campaignId as string) : undefined

  /**
   * RA.AUTO — two guards, both of which REFUSE rather than guess.
   *
   * `targetAcos` is a FRACTION: `previewBidOptimization` defaults it to `0.3 // 30% default
   * fallback` and uses it directly. Measured on prod 2026-08-10 (`scripts/_ra8-targetacos-units.mts`):
   * of the seven rules carrying this action, six store a fraction or nothing, and one — "AIREON —
   * Target ACoS bidding" — stores `30`. Read as a fraction that is a 3000% ACOS target, i.e. "spend
   * up to thirty times revenue", which in this engine raises every bid it touches.
   *
   * Nothing has been lost: that rule is PROPOSE, so it cannot write, and this action has applied 0
   * bids in 60 days. But the ceiling admits it to AUTO, so one click on the Automations dial is all
   * that stands between the stored 30 and a live account.
   *
   * Coercing 30 → 0.3 would be a guess about intent dressed as a fix, and a wrong guess here moves
   * real money. Refusing is honest, loud, and visible in the execution history and on the rule row.
   *
   * The second guard is the same shape. This handler reads `campaignId` (SINGULAR). The AIREON rule
   * stores `campaignIds` — an array of 11 — which is silently ignored, so a rule an operator scoped
   * to eleven campaigns would optimise the entire account. Supporting the array is a real change to
   * the bid engine and belongs in its own study; refusing to act on a scope this handler cannot
   * honour costs nothing and cannot surprise anyone.
   */
  if (!Number.isFinite(targetAcos) || targetAcos <= 0 || targetAcos > 1) {
    return {
      type: action.type,
      ok: false,
      error: `targetAcos must be a fraction between 0 and 1 (0.3 = 30%); this rule stores ${JSON.stringify(action.targetAcos)}, which would be read as ${(targetAcos * 100).toFixed(0)}% and is refused`,
    }
  }
  if (Array.isArray(action.campaignIds) && (action.campaignIds as unknown[]).length > 0 && !campaignId) {
    return {
      type: action.type,
      ok: false,
      error: `this rule names ${(action.campaignIds as unknown[]).length} campaigns via \`campaignIds\`, which this action cannot honour (it reads \`campaignId\`); refused rather than run account-wide`,
    }
  }
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
