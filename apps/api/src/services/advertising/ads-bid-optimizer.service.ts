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
 *
 * C3 (2026-10-07) — no compounding. The window's evidence barely moves between two runs (auto-bid runs every 6 hours on
 * 30 settled days), and every proposal used to be `current bid × target / ACoS`: each run multiplied the bid the last
 * run had left by the same ratio again (one target went 33 → 25 → 19 → 14¢ in 6 hours). Now the evidence sets a GOAL
 * bid, independent of the current bid — target ACoS × sales per click (Bayesian: × the shrunk CR × AOV), which equals
 * the average CPC × target / ACoS — and a proposal moves the current bid TOWARD it (one step at most, never past it),
 * and proposes nothing within GOAL_TOLERANCE of it (ads-bid-goal.ts). The zero-sales cut has no goal (a click there
 * earned nothing), so it waits for evidence at the bid it would cut: once the bid moved inside the window, it needs a
 * click floor of clicks on the settled days after that move before it cuts again (clicksAtCurrentBid).
 *
 * Review 2026-10-08 — A: the goal above is a CPC, and Amazon charges less than the bid. The goal BID is that CPC ÷ r̂
 * (paid CPC ÷ the bid that served the window's clicks; the target's own from 10 clicks, else its ad group's, else 0.85,
 * held to 0.6–1.0), the bid brain's own arithmetic (bid-brain/recipe.ts bidForAcos, bid-brain/estimator.ts cpcRatio).
 * Before, a keyword paying 62 % of its bid was steered to a bid that bought 62 % of the clicks its target allowed.
 * B: a target moves at most once per settled data day (whichever automatic writer moved it first), a move against this
 * optimiser's own last move waits 3 data days, and the dead zone is 10 % or 2¢ (ads-bid-window.ts, ads-bid-goal.ts).
 * The account-wide Beta prior stays as it is: the bid brain's pooled estimate replaces it when a campaign goes live.
 *
 * Review follow-up 2026-10-08 — a reason compares the target with the ACoS the bid it has NOW is expected to give
 * (bid × r̂ ÷ value per click, bid-brain/recipe.ts expectedAcos), the number that decides the direction: the window's
 * ACoS was paid at the bids that served it, so after a cut it could read "above target" next to a raise. The window's
 * figure follows in brackets when it differs. And a cut that reverses this optimiser's own raise does not wait when that
 * expected ACoS is over SAFETY_CUT_ACOS_MULTIPLE × the target (ads-bid-window.ts isSafetyCut).
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
import { settledBounds, settledWhere } from './ads-settled-window.js'
import { protectedAdGroups, protectedStopWhy } from './ads-strategy/terms.js'
import { stepTowardGoal } from './ads-bid-goal.js'
import { bidForAcos, expectedAcos } from './bid-brain/recipe.js'
import { CPC_RATIO_MIN_CLICKS, cpcRatio } from './bid-brain/estimator.js'
import { dayKey, isSafetyCut, isServingMove, movedThisDataDay, reversalWait, REVERSAL_WAIT_DATA_DAYS, SAFETY_CUT_ACOS_MULTIPLE, windowBidCents, type AutoMove, type BidMove, type ClickDay, type WindowBidBasis } from './ads-bid-window.js'
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

/**
 * W1-7 — a cut the optimiser did not propose: the ads strategy protects a product of this target's ad group. Review
 * 2026-10-08 (B) — also a move that waits for a newer data day (`waiting`); `why` says which.
 */
export interface HeldCut { targetId: string; expression: string; currentBidCents: number; wouldBeCents: number; why: string }

/**
 * Review follow-up 2026-10-08 — a move that waits, with which wait holds it (`movedToday`: an automatic writer already
 * moved the bid on this data day; `reversal`: it would undo this optimiser's own move of the last REVERSAL_WAIT_DATA_DAYS
 * data days) and whose target it moves toward, so auto-bid counts the waits it would otherwise move (planAutoBid).
 */
export interface WaitingMove extends HeldCut { wait: 'movedToday' | 'reversal'; targetSource: TargetAcosSource }

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
  /** Review 2026-10-08 (B) — the settled data day it was decided on, stamped on its write's evidence. */
  dataDay: string
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
 * C3 — evidence at the bid a target has now, for the zero-sales cut. For each target whose serving bid moved inside the
 * decision window (CampaignBidHistory: a bid write between two serving bids, both at least the 5¢ floor — a ~2¢
 * suppression floor and the restore that undoes it leave the serving bid where it was), the newest move and the clicks
 * on settled days AFTER the day it moved (that day is part old bid, part new). A target missing from the map did not
 * move inside the window: every click in it was at the bid it has now. `daily` false (the legacy columns): there are no
 * days to count, so a target that moved has no clicks at its bid yet.
 */
export async function clicksAtCurrentBid(targetIds: string[], daily: boolean): Promise<Map<string, { movedAt: Date; clicks: number }>> {
  const out = new Map<string, { movedAt: Date; clicks: number }>()
  if (!targetIds.length) return out
  // The earlier start of the two lags (Sponsored Brands/Display wait 14 days), so a move inside either window is seen.
  const since = settledBounds(DAILY_WINDOW_DAYS, 'SPONSORED_BRANDS').since
  const moves = await prisma.campaignBidHistory.findMany({
    where: { entityType: 'AD_TARGET', field: 'bid', entityId: { in: targetIds }, changedAt: { gte: since } },
    select: { entityId: true, oldValue: true, newValue: true, changedAt: true },
  })
  for (const m of moves) {
    const from = Number(m.oldValue)
    const to = Number(m.newValue)
    if (!(from >= FLOOR_CENTS) || !(to >= FLOOR_CENTS) || from === to) continue
    const seen = out.get(m.entityId)
    if (!seen || m.changedAt > seen.movedAt) out.set(m.entityId, { movedAt: m.changedAt, clicks: 0 })
  }
  if (!out.size || !daily) return out
  const days = await prisma.amazonAdsDailyPerformance.findMany({
    where: { entityType: 'AD_TARGET', localEntityId: { in: [...out.keys()] }, clicks: { gt: 0 }, ...settledWhere(DAILY_WINDOW_DAYS) },
    select: { localEntityId: true, date: true, clicks: true },
  })
  for (const d of days) {
    const m = d.localEntityId ? out.get(d.localEntityId) : undefined
    if (!m) continue
    const dayAfterMove = Date.UTC(m.movedAt.getUTCFullYear(), m.movedAt.getUTCMonth(), m.movedAt.getUTCDate() + 1)
    if (d.date.getTime() >= dayAfterMove) m.clicks += d.clicks
  }
  return out
}

/** Review 2026-10-08 — the settled data day a decision reads now: the newest day of the Sponsored Products window. */
export function currentDataDay(now: Date = new Date()): string {
  return dayKey(settledBounds(DAILY_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now }).until)
}

/** Bid history values under the 5¢ engine floor: a stop's low bid or its restore, never a serving-bid move. */
const SUB_FLOOR_VALUES = ['0', '1', '2', '3', '4']

/**
 * Review 2026-10-08 (A) — the bid that served each target's window clicks (ads-bid-window.ts windowBidCents), for r̂.
 * Moves come from CampaignBidHistory since the window's first day (a move after the window's last day still says which
 * bid served before it); the days that weigh them, from the settled daily rows of the targets that moved (`daily`).
 * Without those days (the legacy columns hold one sum) each bid is weighted by the time it served inside the window.
 */
export async function windowBids(targets: ReadonlyArray<{ id: string; bidCents: number }>, daily: boolean): Promise<Map<string, { cents: number; basis: WindowBidBasis }>> {
  const out = new Map<string, { cents: number; basis: WindowBidBasis }>()
  if (!targets.length) return out
  // The earlier start of the two lags (Sponsored Brands/Display wait 14 days), so a move inside either window is seen.
  const since = settledBounds(DAILY_WINDOW_DAYS, 'SPONSORED_BRANDS').since
  const rows = await prisma.campaignBidHistory.findMany({
    where: {
      entityType: 'AD_TARGET', field: 'bid', entityId: { in: targets.map((t) => t.id) }, changedAt: { gte: since },
      oldValue: { notIn: SUB_FLOOR_VALUES }, newValue: { notIn: SUB_FLOOR_VALUES },
    },
    select: { entityId: true, oldValue: true, newValue: true, changedAt: true },
  })
  const moves = new Map<string, BidMove[]>()
  for (const r of rows) {
    const move = { at: r.changedAt, fromCents: Number(r.oldValue), toCents: Number(r.newValue) }
    if (!isServingMove(move.fromCents, move.toCents)) continue
    moves.set(r.entityId, [...(moves.get(r.entityId) ?? []), move])
  }
  const days = new Map<string, ClickDay[]>()
  if (daily && moves.size) {
    const perDay = await prisma.amazonAdsDailyPerformance.findMany({
      where: { entityType: 'AD_TARGET', localEntityId: { in: [...moves.keys()] }, clicks: { gt: 0 }, ...settledWhere(DAILY_WINDOW_DAYS) },
      select: { localEntityId: true, date: true, clicks: true },
    })
    for (const d of perDay) if (d.localEntityId) days.set(d.localEntityId, [...(days.get(d.localEntityId) ?? []), { date: d.date, clicks: d.clicks }])
  }
  const window = settledBounds(DAILY_WINDOW_DAYS, 'SPONSORED_PRODUCTS')
  for (const t of targets) out.set(t.id, windowBidCents(t.bidCents, moves.get(t.id) ?? [], days.get(t.id) ?? [], window))
  return out
}

/** A JSON payload's `bidCents` (AdvertisingActionLog.payloadBefore/After of a bid write), or NaN. */
const payloadBid = (p: unknown): number => (p && typeof p === 'object' && 'bidCents' in p ? Number((p as { bidCents: unknown }).bidCents) : NaN)

/**
 * Review 2026-10-08 (B) — each target's automatic bid writes (actor `automation:*`, not rolled back) of the last
 * REVERSAL_WAIT_DATA_DAYS data days, newest first. A write's data day is the one stamped on the optimiser's own writes,
 * else the data day it fell on (the window moves one day at 00:00 UTC).
 */
export async function recentAutoMoves(targetIds: string[], now: Date = new Date()): Promise<Map<string, AutoMove[]>> {
  const out = new Map<string, AutoMove[]>()
  if (!targetIds.length) return out
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (REVERSAL_WAIT_DATA_DAYS - 1)))
  const rows = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', entityId: { in: targetIds }, userId: { startsWith: 'automation:' }, rolledBackAt: null, createdAt: { gte: since } },
    select: { entityId: true, userId: true, createdAt: true, payloadBefore: true, payloadAfter: true, evidence: true },
    orderBy: { createdAt: 'desc' },
  })
  for (const r of rows) {
    const fromCents = payloadBid(r.payloadBefore)
    const toCents = payloadBid(r.payloadAfter)
    if (!isServingMove(fromCents, toCents)) continue
    const stampedDay = r.evidence && typeof r.evidence === 'object' && typeof (r.evidence as { dataDay?: unknown }).dataDay === 'string' ? (r.evidence as { dataDay: string }).dataDay : null
    const move: AutoMove = { dataDay: stampedDay ?? currentDataDay(r.createdAt), fromCents, toCents, by: r.userId ?? 'automation', stamped: stampedDay != null }
    out.set(r.entityId, [...(out.get(r.entityId) ?? []), move])
  }
  return out
}

/** Review 2026-10-08 (A) — a target's r̂ (paid CPC ÷ the bid that served its clicks) and where it came from, in words. */
interface PaidRatio { ratio: number; words: string }

/**
 * r̂ per target, the bid brain's rule (bid-brain/estimator.ts cpcRatio): the target's own from CPC_RATIO_MIN_CLICKS
 * clicks, else its ad group's (every target of the group in this run, each at the bid that served it), else 0.85; held
 * to 0.6–1.0.
 */
function paidRatios<T extends { id: string; adGroupId: string; bidCents: number; clicks: number; spendCents: number }>(targets: readonly T[], served: ReadonlyMap<string, { cents: number; basis: WindowBidBasis }>): Map<string, PaidRatio> {
  const groups = new Map<string, { clicks: number; costCents: number; bidClicks: number }>()
  for (const t of targets) {
    const g = groups.get(t.adGroupId) ?? { clicks: 0, costCents: 0, bidClicks: 0 }
    g.clicks += t.clicks
    g.costCents += t.spendCents
    g.bidClicks += t.clicks * (served.get(t.id)?.cents ?? t.bidCents)
    groups.set(t.adGroupId, g)
  }
  const out = new Map<string, PaidRatio>()
  for (const t of targets) {
    const g = groups.get(t.adGroupId)
    const parent = g && g.clicks >= CPC_RATIO_MIN_CLICKS && g.bidClicks > 0 ? cpcRatio({ clicks: g.clicks, costCents: g.costCents }, g.bidClicks / g.clicks) : null
    const bid = served.get(t.id) ?? { cents: t.bidCents, basis: 'unchanged' as const }
    const ratio = cpcRatio({ clicks: t.clicks, costCents: t.spendCents }, bid.cents, parent)
    const over = bid.basis === 'unchanged' ? '' : bid.basis === 'clicks' ? ', at the bids that served them' : ', bids weighted by time — no daily clicks'
    const from = t.clicks >= CPC_RATIO_MIN_CLICKS && bid.cents > 0
      ? `its own, ${t.clicks} clicks${over}`
      : parent != null ? `its ad group's, ${g!.clicks} clicks` : `the default — under ${CPC_RATIO_MIN_CLICKS} clicks`
    out.set(t.id, { ratio, words: `r̂ ${ratio.toFixed(2)} (paid CPC ÷ bid: ${from})` })
  }
  return out
}

/** "€1.23" from cents, for a reason. */
const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

/**
 * Review follow-up — the window's figure beside the ACoS at the bid it has now, when the two read differently (whole
 * percent): " (window ACOS 50%)". The window's clicks were bought at the bids that served them, at its own r̂.
 */
function windowNote(label: string, windowAcos: number, nowAcos: number): string {
  const w = (windowAcos * 100).toFixed(0)
  return w === (nowAcos * 100).toFixed(0) ? '' : ` (${label} ${w}%)`
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
): Promise<{
  targetAcos: number; profitMode: boolean; bayesian: boolean; proposals: BidProposal[]; held: HeldCut[]
  /** Review 2026-10-08 (B) — moves that wait: another automatic move on this data day, or a quick reversal of its own. */
  waiting: WaitingMove[]
}> {
  await (await import('./ads-settled-facts.js')).primeSettledWindow() // BB-14 — the settled day the scheduler reads, here too
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
  // C3 — the flat path's zero-sales cut waits for evidence at the bid it would cut (clicksAtCurrentBid). The Bayesian
  // path has no such cut: its goal falls smoothly as clicks without an order add up.
  const movedBids = bayesian ? new Map<string, { movedAt: Date; clicks: number }>() : await clicksAtCurrentBid(zeroSales.map((t) => t.id), dailyMetrics != null)
  const pct = (f: number) => (f * 100).toFixed(0)
  const cmp = (a: number, b: number) => (a > b ? '>' : a < b ? '<' : '=')
  // Review 2026-10-08 — the data day this run decides on and each target's automatic writes of the last data days (B);
  // the bid that served each target's window clicks and its r̂ (A). Read once per run, for the targets it can decide.
  const dataDay = currentDataDay()
  const decidable = targets.filter((t) => t.clicks >= clickFloor)
  const autoMoves = await recentAutoMoves(decidable.map((t) => t.id))
  const ratios = paidRatios(decidable, await windowBids(decidable, dailyMetrics != null))
  const waiting: WaitingMove[] = []

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
    // Review follow-up — the ACoS the bid it has now is expected to give; null on the zero-sales cut (no value a click).
    let nowAcos: number | null = null

    if (bayesian && prior) {
      // Shrink CR toward the pool and derive an EXPECTED ACOS. Works even at 0 observed sales (the prior gives a
      // non-zero CR), so sparse keywords get a gentle, principled bid instead of being skipped or hard-cut on noise.
      // C3 — the goal is the bid whose expected ACoS is the target: target × expected sales per click (shrunk CR × AOV).
      const crS = shrunkConversionRate(t.ordersCount ?? 0, t.clicks, prior)
      const aovCents = (t.ordersCount ?? 0) > 0 ? t.salesCents / (t.ordersCount ?? 1) : poolAovCents
      const expectedSalesCents = t.clicks * crS * aovCents
      const expAcos = expectedSalesCents > 0 ? t.spendCents / expectedSalesCents : null
      if (expAcos == null) continue
      // A — the CPC the target affords (target × shrunk CR × AOV), as the bid that buys it: ÷ r̂.
      const paid = ratios.get(t.id)!
      const goal = bidForAcos(targetAcos, crS, aovCents, paid.ratio)
      const next = stepTowardGoal(t.bidCents, goal, step, FLOOR_CENTS)
      if (next == null) continue
      proposed = next
      const conf = dataConfidence(t.clicks, prior)
      targetBasis = 'bayesian'
      nowAcos = expectedAcos(t.bidCents, crS, aovCents, paid.ratio)!
      const tag = `Bayesian CR ${(crS * 100).toFixed(1)}% · ${(conf * 100).toFixed(0)}% data-confidence · ${paid.words}`
      reason = `exp.ACOS ${pct(nowAcos)}% at ${t.bidCents}¢${windowNote('window exp.ACOS', expAcos, nowAcos)} ${cmp(nowAcos, targetAcos)} target ${pct(targetAcos)}%${whose} — ${next < t.bidCents ? 'lower' : 'raise'} toward ${Math.round(goal)}¢ (${tag})`
    } else if (t.salesCents === 0) {
      // Spending with no sales → cut hard toward the floor. There is no goal (a click here earned nothing), so C3: once
      // the bid moved inside the window, the cut needs the click floor of clicks at the bid it has now — no second cut
      // on the evidence the last one already acted on.
      const moved = movedBids.get(t.id)
      if (moved && moved.clicks < clickFloor) continue
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * (1 - step.down)))
      reason = `${moved ? `${moved.clicks} clicks at this bid (${t.clicks} in the window)` : `${t.clicks} clicks`}, 0 sales — cut ${Math.round(step.down * 100)}%`
    } else if (observedAcos != null) {
      // C3 — the goal is target × sales per click (= average CPC × target / ACoS), whatever the bid is now; A — as the
      // bid that buys that CPC: ÷ r̂ (a click's value is its sales: CR 1 × sales a click).
      const paid = ratios.get(t.id)!
      const goal = bidForAcos(targetAcos, 1, t.salesCents / t.clicks, paid.ratio)
      const next = stepTowardGoal(t.bidCents, goal, step, FLOOR_CENTS)
      if (next == null || (next > t.bidCents && t.ordersCount < 1)) continue
      proposed = next
      nowAcos = expectedAcos(t.bidCents, 1, t.salesCents / t.clicks, paid.ratio)!
      reason = `exp.ACOS ${pct(nowAcos)}% at ${t.bidCents}¢${windowNote('window ACOS', observedAcos, nowAcos)} ${cmp(nowAcos, targetAcos)} target ${pct(targetAcos)}%${whose} — ${next < t.bidCents ? 'lower' : 'raise'} toward ${Math.round(goal)}¢ (${pct(targetAcos)}% of ${eur(t.salesCents / t.clicks)} sales a click ÷ ${paid.words})`
    } else continue
    const acos = observedAcos
    if (proposed === t.bidCents) continue
    // B — once a data day, and no quick reversal of its own move: the move waits, and is said rather than dropped. A safety
    // cut (isSafetyCut) does not wait as a reversal; it still waits for the next data day after another automatic move.
    const moves = autoMoves.get(t.id) ?? []
    const today = movedThisDataDay(dataDay, moves)
    const reversal = today ? null : reversalWait(dataDay, t.bidCents, proposed, moves)
    const safety = reversal != null && isSafetyCut(t.bidCents, proposed, nowAcos, targetAcos)
    if (today || (reversal && !safety)) {
      waiting.push({ targetId: t.id, expression: t.expressionValue, currentBidCents: t.bidCents, wouldBeCents: proposed, why: (today ?? reversal)!, wait: today ? 'movedToday' : 'reversal', targetSource: resolved.source })
      continue
    }
    if (safety) reason = `${reason} — a safety cut: not held as a reversal of its own raise, the bid now runs over ${SAFETY_CUT_ACOS_MULTIPLE} × the target`
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
    proposals.push({ targetId: t.id, expression: t.expressionValue, matchType: t.expressionType, currentBidCents: t.bidCents, proposedBidCents: proposed, deltaCents: proposed - t.bidCents, acos, spendCents: t.spendCents, salesCents: t.salesCents, clicks: t.clicks, reason, targetAcosUsed: targetAcos, targetBasis, targetSource: resolved.source, sources, limits, dataDay })
  }
  proposals.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
  return { targetAcos: typeof explicit === 'number' ? explicit : flatTargetAcos, profitMode, bayesian, proposals, held, waiting }
}

export async function applyBidOptimization(args: {
  /** W1-5 — `sources` (a proposal's): which level supplied each number, kept on the write's evidence. */
  changes: Array<{ targetId: string; proposedBidCents: number; sources?: WriteSources; dataDay?: string }>; actor?: string; dryRun?: boolean
  /** SG.10 (additive) — group the batch into ONE reversible change set (see bulkUpdateAdTargetBids). */
  changeSetId?: string | null
  /**
   * Honest writes — ask the write gate before Nexus writes its copy (updateAdTargetWithSync `askGate`): a refused bid
   * leaves no local change and no queue row, and is counted in `notSent`. Auto-bid passes it.
   */
  askGate?: boolean
}): Promise<{
  applied: number; dryRun: boolean
  /** Honest writes — the bids the write refused before anything was written or queued, and their reasons (each once, at most three). */
  notSent?: number
  notSentReasons?: string[]
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
  // Review 2026-10-08 (B) — every write carries the data day it was decided on (a proposal's, else today's): the next run
  // reads it to hold a quick reversal (ads-bid-window.ts).
  const today = currentDataDay()
  const entries = args.changes.map((c) => ({ adTargetId: c.targetId, bidCents: c.proposedBidCents, evidence: { ...(c.sources ? { sources: c.sources } : {}), dataDay: c.dataDay ?? today } }))
  if (entries.length === 0) return { applied: 0, dryRun: false }
  // R2 — never `automation:automation:<x>`: auto-bid, a rule and an autopilot plan pass a namespaced actor.
  const actor: AdsActor = adsActorOf(args.actor, 'bid-optimizer')
  const out = await bulkUpdateAdTargetBids({ entries, actor, reason: 'AX.8 target-ACOS optimization', changeSetId: args.changeSetId ?? null, ...(args.askGate ? { askGate: true } : {}) })
  logger.info('[AX.8] bid optimization applied', { count: out.applied, skipped: out.skipped, failed: out.failed })
  const notSentReasons = [...new Set(out.outcomes.filter((o) => o.ok === false).map((o) => o.error ?? 'refused by the bid write'))].slice(0, 3)
  return {
    applied: out.applied, dryRun: false, ...(out.failed ? { notSent: out.failed, notSentReasons } : {}),
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
  const held = {
    ...(preview.held.length ? { protectedHeld: preview.held.length, protectedSample: preview.held.slice(0, 5) } : {}),
    // Review 2026-10-08 (B) — the moves that wait for the next data day, said rather than dropped silently.
    ...(preview.waiting.length ? { waiting: preview.waiting.length, waitingSample: preview.waiting.slice(0, 5) } : {}),
  }
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, wouldChange: proposals.length, sample: proposals.slice(0, 5), ...held } }
  const r = await applyBidOptimization({ changes: proposals.map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents, sources: p.sources, dataDay: p.dataDay })), actor: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { applied: r.applied, ...held } }
}

logger.debug('[AX.8] bid_to_target_acos handler registered')
