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
import { adsActorOf } from './ads-actor.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { computeAdGroupTargetAcos, type AcosMode } from './ads-target-acos.service.js'
import { MAX_TARGET_ACOS_FRACTION, readOwnerTargets, reachesSource, resolveTargetAcos, targetFraction, targetSourceNote, type ResolvedTargetAcos, type TargetAcosInputs, type TargetAcosSource, type TargetAcosSubject } from './ads-target-acos-resolver.js'
import { NO_LIMITS, clampToStrategy, limitSources, limitWords, strategyBidReader, strategySource, type StrategyBidLimits, type WriteSource, type WriteSources } from './ads-strategy/bids.js'
import { fractionToPct } from './ads-strategy/fields.js'
import { fitBetaPrior, shrunkConversionRate, dataConfidence } from './ads-bayesian-bidding.service.js'
import { ACTION_WINDOW } from '@nexus/shared/ads-rule-window'
import { settledWhere } from './ads-settled-window.js'
import { protectedAdGroups, protectedStopWhy } from './ads-strategy/terms.js'
import type { StrategySource } from './ads-strategy/resolve.js'

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
 * 6c (review G.2, Owner decision S9) — the window is SETTLED now, like every trigger window: 30
 * days ending at the ad product's attribution lag (`settledWhere`). It used to be a bare
 * `Date.now() - 30d` that counted today's spend against sales Amazon had not attributed yet, so
 * every target looked less profitable than it was at the moment its bid was decided.
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

/** W1-7 — a cut the optimiser did not propose: the ads strategy protects a product of this target's ad group. */
export interface HeldCut { targetId: string; expression: string; currentBidCents: number; wouldBeCents: number; why: string }

export interface BidProposal {
  targetId: string; expression: string; matchType: string
  currentBidCents: number; proposedBidCents: number; deltaCents: number
  acos: number | null; spendCents: number; salesCents: number; clicks: number; reason: string
  // Apex C.2 — the target ACOS actually used for this target + where it came from.
  // Apex C.3 adds 'bayesian' when the decision used a shrunk CR (sparse-data path).
  // Ads autonomy W0 adds 'explicit' (the caller's own target), 'campaign' and 'account' (ads-target-acos-resolver.ts).
  targetAcosUsed: number; targetBasis: TargetAcosSource | 'bayesian'
  /** W0 — whose target it moved toward, on the Bayesian path too (where `targetBasis` says 'bayesian'). */
  targetSource: TargetAcosSource
  /**
   * W1-5 — which level supplied each number (the target, and the ads strategy's bid limits in force for its ad group),
   * for the write's evidence (`AdWriteEvidence.sources`).
   */
  sources: WriteSources
  /** W1-5 — the ads strategy's bid limits for its ad group, so a caller that clamps again stays inside them. */
  limits: StrategyBidLimits
}

/** W1-5 — the target a proposal moved toward, as a write source (an integer percent, with its row for the strategy). */
function targetWriteSource(r: ResolvedTargetAcos, explicitFrom?: string): WriteSource {
  const pct = fractionToPct(r.targetAcos)
  if (r.source === 'strategy' && r.strategy) return strategySource(pct, r.strategy)
  return { level: r.source, value: pct, ...(r.source === 'explicit' && explicitFrom ? { from: explicitFrom } : {}) }
}

/**
 * W1-5 — the largest step one pass may move a bid: MAX_DOWN / MAX_UP, or the ads strategy's largest change for the ad
 * group when it is lower.
 */
function stepsFor(limits: StrategyBidLimits): { down: number; up: number } {
  const pct = limits.maxChangePct?.value
  return pct != null ? { down: Math.min(MAX_DOWN, pct / 100), up: Math.min(MAX_UP, pct / 100) } : { down: MAX_DOWN, up: MAX_UP }
}

/**
 * W1-5 — a proposal a caller clamped again (a rule's or a plan's own Min/Max bid) held back inside the ads strategy's band
 * of its ad group: every limit binds and the stricter wins, and where they cross the highest bid wins (it spends less).
 * One that then equals the current bid is dropped.
 */
export function holdToStrategy(proposals: BidProposal[]): BidProposal[] {
  return proposals
    .map((p) => {
      const c = clampToStrategy(p.proposedBidCents, p.limits, { currentCents: p.currentBidCents })
      return c.held ? { ...p, proposedBidCents: c.cents, deltaCents: c.cents - p.currentBidCents, reason: `${p.reason} (held to ${limitWords(c.held.side, c.held.limit)})` } : p
    })
    .filter((p) => p.proposedBidCents !== p.currentBidCents)
}

/**
 * W0 — where each keyword's target comes from (resolveTargetAcos, ads-target-acos-resolver.ts), first that answers:
 *   `targetAcos`           the caller's EXPLICIT target, a fraction: a rule's own, an autopilot plan's own, a number a
 *                          person typed. Pass it only when someone configured it — never a default "just in case":
 *                          it would mask the campaign's target. `targetAcosFrom` names it in the reasons.
 *   the campaign's own target ACoS, then the ads strategy's for the keyword's ad group (W1-5), then the account default,
 *   then profit data in profit mode;
 *   `fallbackTargetAcos`   the caller's fallback (an autopilot plan's goal default), else 30 %.
 * Callers without an explicit target get the same target for the same campaign. The returned `targetAcos` is the
 * explicit target when there is a valid one, else the fallback; each proposal says what it used and whose it is.
 *
 * W1-5 — and the ads strategy's bid limits for the keyword's ad group bind every proposal: a step per pass no larger
 * than its largest change (when lower than 50 % down / 25 % up), and a bid inside its lowest and highest bid (the
 * reason names the row that held it). Each proposal carries its `sources` for the write's evidence.
 */
export async function previewBidOptimization(
  opts: { targetAcos?: number; targetAcosFrom?: string; fallbackTargetAcos?: number; campaignId?: string; profitMode?: boolean; mode?: AcosMode; bayesian?: boolean; source?: BidMetricSource } = {},
): Promise<{ targetAcos: number; profitMode: boolean; bayesian: boolean; proposals: BidProposal[]; held: HeldCut[] }> {
  const flatTargetAcos = opts.fallbackTargetAcos ?? 0.3 // 30% default fallback
  const explicit = targetFraction(opts.targetAcos)
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
    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', ...settledWhere(DAILY_WINDOW_DAYS), localEntityId: { not: null } },
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
      adGroup: { select: { campaignId: true, campaign: { select: { marketplace: true } } } },
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

  // W0 — after the caller's explicit target, the Owner's stored ones: each campaign's target ACoS and the account default
  // (read once per run, and not at all when there is no keyword to bid). Then profit data in profit mode, then the
  // caller's fallback (ads-target-acos-resolver.ts).
  const owner = targets.length
    ? await readOwnerTargets([...new Set(targets.map((t) => t.adGroup?.campaignId).filter((id): id is string => !!id))])
    : { byCampaign: new Map<string, unknown>(), accountDefaultPct: null }
  const subjectOf = (t: (typeof targets)[number]): TargetAcosSubject => ({
    adGroupId: t.adGroupId,
    campaignTargetAcos: t.adGroup?.campaignId ? owner.byCampaign.get(t.adGroup.campaignId) : undefined,
  })
  // W1-5 — the ads strategy per ad group (each market opened once): its ACoS target, after the campaign's own and before
  // the account default; and its bid limits, which hold every proposal below. A market without a strategy row gives
  // nothing, so its keywords are proposed exactly as before.
  const adGroupMarkets = new Map(targets.map((t) => [t.adGroupId, t.adGroup?.campaign?.marketplace ?? null]))
  const strategy = targets.length
    ? await strategyBidReader().forAdGroups([...adGroupMarkets].map(([adGroupId, marketplace]) => ({ adGroupId, marketplace })))
    : new Map<string, { limits: StrategyBidLimits; target: null }>()
  const strategyByAdGroup = new Map([...strategy].flatMap(([id, s]) => (s.target ? [[id, s.target] as const] : [])))
  const inputs: TargetAcosInputs = { explicitTargetAcos: opts.targetAcos, accountDefaultPct: owner.accountDefaultPct, strategyByAdGroup, profitByAdGroup: null, flatTargetAcos }

  // Apex C.2 — when profitMode, resolve each ad group's profit-derived target
  // ACOS once (revenue-weighted across its advertised products) and use it
  // instead of the flat 30%. Falls back to flat per ad group with no profit data.
  // W0 — only for the ad groups a configured target leaves open: a number someone set wins over a derived one.
  if (profitMode) {
    const acosByAdGroup = new Map<string, number>()
    const adGroupIds = [...new Set(targets.filter((t) => reachesSource('profit', subjectOf(t), inputs)).map((t) => t.adGroupId))]
    for (const agId of adGroupIds) {
      const mkt = targets.find((t) => t.adGroupId === agId)?.adGroup?.campaign?.marketplace ?? null
      const r = await computeAdGroupTargetAcos(agId, { marketplace: mkt, mode: opts.mode })
      if (r.targetAcos != null) acosByAdGroup.set(agId, r.targetAcos)
    }
    inputs.profitByAdGroup = acosByAdGroup
  }

  // ADS AUTONOMY W1-7 — no optimiser stops a protected product. The zero-sales cut is a stop by steps (halved each run
  // down to the floor), so a keyword or target of an ad group advertising a product the ads strategy protects is not
  // cut while it has no sales; with sales it steers to its target like any other, and raises are never held. Read
  // once per run, only for ad groups holding such a target (a market without a protection costs one indexed read).
  const zeroSales = targets.filter((t) => t.clicks >= clickFloor && t.salesCents === 0)
  const protectedGroups = zeroSales.length
    ? await protectedAdGroups([...new Map(zeroSales.map((t) => [t.adGroupId, { id: t.adGroupId, market: t.adGroup?.campaign?.marketplace ?? null }])).values()])
    : new Map<string, StrategySource>()
  const held: HeldCut[] = []

  const proposals: BidProposal[] = []
  for (const t of targets) {
    if (t.clicks < clickFloor) continue
    // W1-5 — the ad group's strategy limits: the step per pass (the lower of MAX_DOWN/MAX_UP and its largest change)
    // and the band the proposal is held inside.
    const limits = strategy.get(t.adGroupId)?.limits ?? NO_LIMITS
    const step = stepsFor(limits)
    const resolved = resolveTargetAcos(subjectOf(t), inputs)
    const targetAcos = resolved.targetAcos
    const whose = targetSourceNote(resolved, opts.targetAcosFrom)
    const observedAcos = t.salesCents > 0 ? t.spendCents / t.salesCents : null
    let proposed = t.bidCents
    let reason = ''
    let targetBasis: BidProposal['targetBasis'] = resolved.source

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
        const ratio = Math.max(1 - step.down, targetAcos / expAcos)
        proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * ratio))
        reason = `exp.ACOS ${(expAcos * 100).toFixed(0)}% > target ${(targetAcos * 100).toFixed(0)}%${whose} — lower (${tag})`
      } else if (expAcos < targetAcos) {
        const ratio = Math.min(1 + step.up, targetAcos / expAcos)
        proposed = Math.round(t.bidCents * ratio)
        reason = `exp.ACOS ${(expAcos * 100).toFixed(0)}% < target ${(targetAcos * 100).toFixed(0)}%${whose} — raise (${tag})`
      } else continue
    } else if (t.salesCents === 0) {
      // Spending with no sales → cut hard toward the floor.
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * (1 - step.down)))
      reason = `${t.clicks} clicks, 0 sales — cut ${Math.round(step.down * 100)}%`
    } else if (observedAcos != null && observedAcos > targetAcos) {
      const ratio = Math.max(1 - step.down, targetAcos / observedAcos)
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * ratio))
      reason = `ACOS ${(observedAcos * 100).toFixed(0)}% > target ${(targetAcos * 100).toFixed(0)}%${whose} — lower`
    } else if (observedAcos != null && observedAcos < targetAcos && t.ordersCount >= 1) {
      const ratio = Math.min(1 + step.up, targetAcos / observedAcos)
      proposed = Math.round(t.bidCents * ratio)
      reason = `ACOS ${(observedAcos * 100).toFixed(0)}% < target ${(targetAcos * 100).toFixed(0)}%${whose} — raise to capture volume`
    } else continue
    const acos = observedAcos
    if (proposed === t.bidCents) continue
    // W1-7 — a protected product's zero-sales cut is not proposed (no optimiser stops it).
    const protection = proposed < t.bidCents && t.salesCents === 0 ? protectedGroups.get(t.adGroupId) : undefined
    if (protection) {
      held.push({ targetId: t.id, expression: t.expressionValue, currentBidCents: t.bidCents, wouldBeCents: proposed, why: protectedStopWhy(protection) })
      continue
    }
    // W1-5 — held inside the ads strategy's band before the write gate sees it (a refused write is noise, not a brake).
    const banded = clampToStrategy(proposed, limits, { currentCents: t.bidCents })
    if (banded.held) {
      proposed = banded.cents
      reason = `${reason} (held to ${limitWords(banded.held.side, banded.held.limit)})`
    }
    if (proposed === t.bidCents) continue
    const sources: WriteSources = { targetAcosPct: targetWriteSource(resolved, opts.targetAcosFrom), ...limitSources(limits) }
    proposals.push({ targetId: t.id, expression: t.expressionValue, matchType: t.expressionType, currentBidCents: t.bidCents, proposedBidCents: proposed, deltaCents: proposed - t.bidCents, acos, spendCents: t.spendCents, salesCents: t.salesCents, clicks: t.clicks, reason, targetAcosUsed: targetAcos, targetBasis, targetSource: resolved.source, sources, limits })
  }
  proposals.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
  return { targetAcos: typeof explicit === 'number' ? explicit : flatTargetAcos, profitMode, bayesian, proposals, held }
}

export async function applyBidOptimization(args: {
  /** W1-5 — `sources` (a proposal's): which level supplied each number, kept on the write's evidence. */
  changes: Array<{ targetId: string; proposedBidCents: number; sources?: WriteSources }>; actor?: string; dryRun?: boolean
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
  const entries = args.changes.map((c) => ({ adTargetId: c.targetId, bidCents: c.proposedBidCents, ...(c.sources ? { evidence: { sources: c.sources } } : {}) }))
  if (entries.length === 0) return { applied: 0, dryRun: false }
  // R2 — never `automation:automation:<x>`: auto-bid, a rule and an autopilot plan pass a namespaced actor.
  const actor: AdsActor = adsActorOf(args.actor, 'bid-optimizer')
  const out = await bulkUpdateAdTargetBids({ entries, actor, reason: 'AX.8 target-ACOS optimization', changeSetId: args.changeSetId ?? null })
  logger.info('[AX.8] bid optimization applied', { count: out.applied, skipped: out.skipped, failed: out.failed })
  return {
    applied: out.applied, dryRun: false,
    actionLogIds: out.outcomes.map((o) => o.actionLogId).filter((x): x is string => !!x),
    outboundQueueIds: out.outcomes.map((o) => o.outboundQueueId).filter((x): x is string => !!x),
  }
}

/**
 * CC-4 — the rule's own Min/Max bid. The campaign builders store `minBidEur` / `maxBidEur` on the action ("the algorithm
 * never bids below Min or above Max"), and nothing read them. A proposal outside the bounds moves to the bound; one
 * that then equals the current bid is dropped (nothing to change). Absent bounds change nothing.
 */
export function clampProposalsToRuleBounds(proposals: BidProposal[], minBidEur: unknown, maxBidEur: unknown): BidProposal[] {
  const cents = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null)
  const lo = cents(minBidEur)
  const hi = cents(maxBidEur)
  if (lo == null && hi == null) return proposals
  return proposals
    .map((p) => {
      let next = p.proposedBidCents
      if (lo != null && next < lo) next = lo
      if (hi != null && (lo == null || hi >= lo) && next > hi) next = hi
      return next === p.proposedBidCents ? p : { ...p, proposedBidCents: next, deltaCents: next - p.currentBidCents, reason: `${p.reason} (held to the rule's ${next === lo ? 'Min' : 'Max'} bid)` }
    })
    .filter((p) => p.proposedBidCents !== p.currentBidCents)
}

// ── Automation handler: bid_to_target_acos ────────────────────────────────
ACTION_HANDLERS.bid_to_target_acos = async (action, _context, meta): Promise<ActionResult> => {
  // W0 — the rule's own target only when it stores one: a 0.3 put here "just in case" would mask the campaign's target.
  const targetAcos = typeof action.targetAcos === 'number' ? (action.targetAcos as number) : undefined
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
  // W0 — up to 5 (500 %), the range every target ACoS writer takes: a launch target above 100 % is a real choice; 30
  // is still 3,000 % and still refused.
  if (targetAcos !== undefined && targetFraction(targetAcos) !== targetAcos) {
    return {
      type: action.type,
      ok: false,
      error: `targetAcos must be a fraction above 0 and at most ${MAX_TARGET_ACOS_FRACTION} (0.3 = 30%, ${MAX_TARGET_ACOS_FRACTION} = ${MAX_TARGET_ACOS_FRACTION * 100}%); this rule stores ${JSON.stringify(action.targetAcos)}, which would be read as ${(targetAcos * 100).toFixed(0)}% and is refused`,
    }
  }
  if (Array.isArray(action.campaignIds) && (action.campaignIds as unknown[]).length > 0 && !campaignId) {
    return {
      type: action.type,
      ok: false,
      error: `this rule names ${(action.campaignIds as unknown[]).length} campaigns via \`campaignIds\`, which this action cannot honour (it reads \`campaignId\`); refused rather than run account-wide`,
    }
  }
  // W0 — a rule's own target wins over the campaign's and the account default (resolveTargetAcos): a number the Owner
  // configured beats a more general one. Without one, the rule bids toward the same target auto-bid uses.
  // Apex C.2 — a rule can opt into profit-native per-SKU target ACOS.
  const profitMode = action.profitMode === true || action.profitMode === 'true'
  const mode = typeof action.acosMode === 'string' ? (action.acosMode as AcosMode) : undefined
  // Apex C.3 — a rule can opt into Bayesian sparse-data handling.
  const bayesian = action.bayesian === true || action.bayesian === 'true'
  const preview = await previewBidOptimization({ targetAcos, targetAcosFrom: "this rule's target", campaignId, profitMode, mode, bayesian })
  // W1-5 — the rule's own Min/Max and the ads strategy's band both bind: the stricter wins.
  const proposals = holdToStrategy(clampProposalsToRuleBounds(preview.proposals, action.minBidEur, action.maxBidEur))
  // W1-7 — the cuts left alone because the ads strategy protects the product, said rather than dropped silently.
  const held = preview.held.length ? { protectedHeld: preview.held.length, protectedSample: preview.held.slice(0, 5) } : {}
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, wouldChange: proposals.length, sample: proposals.slice(0, 5), ...held } }
  const r = await applyBidOptimization({ changes: proposals.map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents, sources: p.sources })), actor: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { applied: r.applied, ...held } }
}

logger.debug('[AX.8] bid_to_target_acos handler registered')
