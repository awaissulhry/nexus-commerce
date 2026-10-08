/**
 * BID BRAIN BB-6 — the live writer. For the campaigns the brain owns (live.ts), each decision whose action is `write`
 * goes to Amazon through the one path every bid takes: updateAdTargetWithSync with `askGate` (the write gate is asked
 * before Nexus changes its own copy, so a refused bid leaves no local change and no queue row), the 5-minute queue, the
 * gate again at dispatch, then the channel gateway. Actor `automation:bid-brain`; every write carries its decision's
 * evidence (run, layer, data day, the one-line why) and the why as its reason.
 *
 *   posture  the account dial (ads-engine-guard.ts): AUTO writes inside the caps; SUGGEST writes nothing and counts
 *            what it would have written; stopped never reaches here — the brakes already held every decision
 *            (load.ts marketBrakes)
 *   caps     the brain's own engine caps (ads-engine-actors.ts `bid-brain`) and each market's own "most actions per
 *            run", asked once per campaign before its first write, so a campaign is never split; the rest go next run
 *   kind     a LOWERING by a stop, stock, the phase or a Min-bid hour is a floor (forced, so the 5¢ engine floor and the
 *            step clamp do not hold it up — the gate judges it as the lowering it is). A give-back (`restore`: the bid
 *            going back where it was before a floor) is a restore: no cap holds it and it still runs under SUGGEST, as
 *            rank-defend's and the stops' give-backs do (Owner decision S2), and it is forced too — the step clamp would
 *            bring a keyword back from a 2¢ floor 25 % a write; decide() already holds it inside the limits and the gate
 *            judges it as the raise it is. Every other move is forward
 *   once     decide() moves a keyword at most once per new settled data day (its lastStep anchor): a rerun on the same
 *            evidence asks nothing
 *   BB-7     the hourly plan's placement % of an owned campaign: one placement write per campaign when the hour's % (capped
 *            so that its highest base bid × (1 + p) × Amazon's dynamic bidding stays within the lane's CPC ceiling)
 *            differs from what is live — through updatePlacementBidding as the brain (the gate judges it, Amazon's
 *            current array is read and merged first)
 *   AB-2     the stop recipe (stop-recipe.ts): a stop or a Min-bid hour holding the whole campaign sets every lane to 0 %
 *            (the lanes live before it saved first, stop-memory.ts), and switches "up and down" to "down only"; when it
 *            ends the lanes come back in one write (the plan's own lanes over the saved ones) and so does the strategy —
 *            through the campaign write every bidding-strategy change takes (updateCampaignWithSync with askGate: the
 *            gate before Nexus's copy, the 5-minute queue, the gate at dispatch, the channel gateway). A stop lowers past
 *            the Owner's lock (AB-1), as it beats a pinned bid; its give-back puts his value back. The campaign's own pins
 *            hold every write; unreadable locks hold the give-back a tick — each said in the report, no memory dropped
 */
import type { AdWriteEvidence } from '../ads-evidence.js'
import { allowChange, nothingHeld, type ChangeKind, type EngineGuard } from '../ads-engine-guard.js'
import { updateAdTargetWithSync, updateCampaignWithSync } from '../ads-mutation.service.js'
import { buildBlendedAdjustments, MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import { logger } from '../../../utils/logger.js'
import type { LeverLocks } from '../brain/owner-brakes.js'
import type { Decision } from './decide.js'
import { BRAIN_ACTOR } from './live.js'
import { laneOf, placementOf } from './plan-hour.js'
import { laneWords, placementsFor, type Lane } from './recipe.js'
import { forgetLanes, forgetStrategy, rememberLanes, rememberStrategy } from './stop-memory.js'
import type { StrategyStep } from './stop-recipe.js'

export interface BrainWrite {
  campaignId: string
  market: string
  decision: Decision
}

/** What became of one decision the brain owns. */
export type WriteOutcome =
  | { sent: 'queued'; outboundQueueId: string | null; actionLogId: string | null }
  | { sent: 'unchanged' }
  | { sent: 'refused'; reason: string }
  | { sent: 'would-apply'; why: string }
  | { sent: 'deferred'; why: string }

export interface WriteReport {
  queued: number
  unchanged: number
  refused: number
  wouldApply: number
  deferred: number
  /** Each refusal's reason once, at most three. */
  refusedReasons: string[]
  byTarget: Map<string, WriteOutcome>
}

// Batch 2 fix — the money brake's step down is a lowering too: taken exactly, and it passes the dial's SUGGEST as a floor
// does (lowering spend never waits); it is not a floor the brain remembers to give back (shadow.ts FLOORING_LAYERS).
// Batch 3 review — an intraday brake (BB-17) is a lowering as well: taken exactly, never waiting behind the dial or the caps.
const FLOOR_LAYERS = new Set(['stop', 'stock', 'phase', 'min_bid_hour', 'money', 'intraday'])

/** A floor: a lowering decided by a stop, stock, the phase, a Min-bid hour or the money brake. Every other write is a forward move. */
export function isFloorWrite(d: Pick<Decision, 'layer' | 'bidCents' | 'currentCents'>): boolean {
  return FLOOR_LAYERS.has(d.layer) && d.bidCents < d.currentCents
}

/** The engine guard's kind of a decision's write: a floor, a give-back after one (restore), or a forward move. */
export function writeKind(d: Pick<Decision, 'layer' | 'bidCents' | 'currentCents'>): ChangeKind {
  return isFloorWrite(d) ? 'floor' : d.layer === 'restore' ? 'restore' : 'forward'
}

/** A write the mutation layer must take exactly: a floor, or a give-back after one (no step clamp, no 5¢ lift). */
export function isExactWrite(d: Pick<Decision, 'layer' | 'bidCents' | 'currentCents'>): boolean {
  return writeKind(d) !== 'forward'
}

/** The evidence one write carries: the run, the deciding layer, the data day, the aim and the why. */
export function writeEvidence(d: Decision, runId: string): AdWriteEvidence {
  return {
    metric: 'expectedAcos',
    observed: d.expectedAcos != null ? Math.round(d.expectedAcos * 10_000) / 10_000 : null,
    threshold: d.goal?.aim ?? null,
    note: d.why.slice(0, 1_000),
    source: { kind: 'bid-brain', id: runId },
    brain: { runId, layer: d.layer, dataDay: d.dataDay, goalBidCents: d.goalBidCents },
  }
}

export const emptyWriteReport = (): WriteReport => ({ queued: 0, unchanged: 0, refused: 0, wouldApply: 0, deferred: 0, refusedReasons: [], byTarget: new Map() })

/** Write the decisions of the campaigns the brain owns, campaign by campaign, inside the dial and the caps. */
export async function writeOwnedDecisions(writes: readonly BrainWrite[], ctx: { runId: string; guard: EngineGuard }): Promise<WriteReport> {
  const out = emptyWriteReport()
  const byCampaign = new Map<string, BrainWrite[]>()
  for (const w of writes) {
    if (w.decision.action !== 'write' || w.decision.bidCents === w.decision.currentCents) continue
    byCampaign.set(w.campaignId, [...(byCampaign.get(w.campaignId) ?? []), w])
  }
  for (const [campaignId, list] of byCampaign) {
    const permit = ctx.guard.permit({ market: list[0].market })
    const held = nothingHeld()
    let changes = 0
    for (const { decision: d } of list) {
      const kind = writeKind(d)
      if (!allowChange(true, permit, held, kind)) {
        const why = ctx.guard.posture === 'suggest' ? 'the account ads dial is SUGGEST' : permit.capped || permit.marketCapped ? 'the bid brain\'s caps for this run are used: it goes next run' : 'the account ads automation is stopped'
        if (ctx.guard.posture === 'suggest') { out.wouldApply++; out.byTarget.set(d.targetId, { sent: 'would-apply', why }) }
        else { out.deferred++; out.byTarget.set(d.targetId, { sent: 'deferred', why }) }
        continue
      }
      try {
        const r = await updateAdTargetWithSync({
          adTargetId: d.targetId,
          patch: { bidCents: d.bidCents },
          actor: BRAIN_ACTOR,
          reason: `bid brain — ${d.why}`.slice(0, 480),
          evidence: writeEvidence(d, ctx.runId),
          askGate: true,
          // Pre-go-live — a give-back refused earlier on this data day: sent again, its refusal not recorded again.
          ...(d.quietRefusal ? { quietRefusal: true } : {}),
          // A floor lands exactly (below the 5¢ engine floor, past the step clamp); the gate sees a forced lowering. A
          // give-back lands exactly too; the gate judges it as a raise (isSuppressionWrite: not every value goes down).
          ...(isExactWrite(d) ? { force: true } : {}),
        })
        if (r.ok && r.outboundQueueId) { out.queued++; changes++; out.byTarget.set(d.targetId, { sent: 'queued', outboundQueueId: r.outboundQueueId, actionLogId: r.actionLogId }) }
        else if (r.ok) { out.unchanged++; out.byTarget.set(d.targetId, { sent: 'unchanged' }) }
        else {
          const reason = r.error ?? 'refused by the bid write'
          out.refused++
          if (out.refusedReasons.length < 3 && !out.refusedReasons.includes(reason)) out.refusedReasons.push(reason)
          out.byTarget.set(d.targetId, { sent: 'refused', reason })
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        out.refused++
        if (out.refusedReasons.length < 3 && !out.refusedReasons.includes(reason)) out.refusedReasons.push(reason)
        out.byTarget.set(d.targetId, { sent: 'refused', reason })
        logger.warn('[bid-brain] a live write failed', { campaignId, targetId: d.targetId, error: reason })
      }
    }
    ctx.guard.settle(permit, changes, held)
  }
  return out
}

/** "queued=3 refused=1 (…)" — the run line's write part; '' when the brain owned nothing that had to move. */
export function writeReportWords(r: WriteReport | null | undefined): string {
  if (!r) return ''
  const parts = [
    r.queued ? `queued=${r.queued}` : '',
    r.unchanged ? `unchanged=${r.unchanged}` : '',
    r.wouldApply ? `would-apply=${r.wouldApply}` : '',
    r.deferred ? `deferred=${r.deferred}` : '',
    r.refused ? `refused=${r.refused} (${r.refusedReasons.join('; ')})` : '',
  ].filter(Boolean)
  return parts.join(' ')
}

/** BB-7 — one owned campaign's placements as its hourly plan sets them this hour. */
export interface PlacementWrite {
  campaignId: string
  market: string
  /** The lanes the hour sets: all three for a blended target (an undeclared one at 0), else the one. */
  lanes: readonly Lane[]
  /** The placement % live now (Campaign.dynamicBidding.placementBidding). */
  current: ReadonlyArray<{ placement: string; percentage: number }>
  /** The campaign's highest base bid after this run's decisions: the bid each lane's ceiling is measured against. */
  maxBidCents: number
  /** The plan's target key this hour, and the plan in words (the why). */
  key: string
  note: string
  dataDay: string
  /** BB-10 — why raises wait this hour (spend-guard.ts): a lane only comes down, never up. */
  raiseCap?: string | null
  /**
   * AB-2 — the stop recipe: `stop` sets every lane to 0 % (the lanes live now saved first); `restore` gives back the lanes
   * saved when the stop began (`base`), the hour's own lanes over them. Absent: the hourly plan's hour.
   */
  recipe?: 'stop' | 'restore'
  /** AB-2 restore — the lanes saved when the stop began, every managed lane listed (stop-recipe.ts fullLanes). */
  base?: ReadonlyArray<{ placement: string; percentage: number }>
  /** AB-2 restore — the lanes the Owner locked (LaneName): back to `base`, whatever the hour's plan sets around them. */
  fixedLanes?: readonly string[]
  /**
   * AB-2 — the hour's plan only: the Owner's locks (brain/owner-brakes.ts): a placements lever he locked is not written, a
   * locked lane keeps its %. (A stop passes them; its give-back carries his value in `base`.)
   */
  locks?: LeverLocks | null
  /** AB-2 — the campaign's placements pin, in words: no lane is written (the gate would refuse it); a memory is kept. */
  pinned?: string | null
  /** AB-2 — why this write waits this tick (the Owner's locks could not be read): nothing written, nothing dropped. */
  wait?: string | null
  /** AB-2 — the stop recipe's words for the why of the campaign's decisions (shadow.ts recipeWords). */
  recipeWhy?: string
}

/**
 * What one campaign's placements become, and which lanes change; null when nothing changes. Pure. Live fix 10-08 — `kept`:
 * a single-placement hour sets its own lane only; the other lanes as they stay, for the why (none after a stop: they come
 * back from its memory, `base`).
 * AB-2 — `base`: what the lanes the hour does not set go back to (the lanes saved when a stop began; else the live ones),
 * and what the raise cap measures a raise from (a give-back is no raise); `locks`: a lane the Owner locked keeps its %.
 */
export function placementPlan(w: Pick<PlacementWrite, 'lanes' | 'current' | 'maxBidCents' | 'raiseCap'> & Partial<Pick<PlacementWrite, 'base' | 'locks' | 'fixedLanes'>>): { adjustments: Array<{ placement: string; percentage: number }>; changes: Array<{ lane: string; from: number; to: number; held: string | null }>; kept: Array<{ lane: string; pct: number }>; locked: Array<{ lane: string; pct: number; by: string }> } | null {
  const base = w.base ?? w.current
  if (!w.lanes.length && !w.base) return null
  // The CR cap of placementsFor waits for the placement report (crRatio null): only the CPC ceilings hold here.
  const decided = placementsFor(w.maxBidCents, w.lanes, { aim: 1, hi: 1 })
  const valueOf = (list: ReadonlyArray<{ placement: string; percentage: number }>, p: string) => list.find((x) => x.placement === p)?.percentage ?? 0
  // BB-10 — under the raise cap a lane may come down, never go up: it keeps what it had (AB-2: before the stop).
  const requested = decided.map((d) => {
    const placement = placementOf(d.lane)
    return { placement, percentage: w.raiseCap && d.pct > valueOf(base, placement) ? valueOf(base, placement) : d.pct }
  })
  const blended = w.lanes.length > 1
  let adjustments = blended
    ? buildBlendedAdjustments([...base], requested)
    : [...base.filter((c) => !requested.some((r) => r.placement === c.placement)), ...requested]
  // AB-2 — after a stop, a lane the Owner locked goes back to its value before it (`base`), whatever the hour's plan sets.
  for (const p of MANAGED_PLACEMENTS) {
    if (!w.fixedLanes?.includes(laneOf(p))) continue
    const back = valueOf(base, p)
    adjustments = adjustments.some((a) => a.placement === p)
      ? adjustments.map((a) => (a.placement === p ? { placement: p, percentage: back } : a))
      : back > 0 ? [...adjustments, { placement: p, percentage: back }] : adjustments
  }
  // AB-2 — on the hour's plan, a lane the Owner locked keeps the % it has now.
  const locked: Array<{ lane: string; pct: number; by: string }> = []
  for (const p of MANAGED_PLACEMENTS) {
    const by = w.locks?.lanes.get(laneOf(p))
    if (!by) continue
    const now = valueOf(w.current, p)
    adjustments = adjustments.some((a) => a.placement === p)
      ? adjustments.map((a) => (a.placement === p ? { placement: p, percentage: now } : a))
      : now > 0 ? [...adjustments, { placement: p, percentage: now }] : adjustments
    locked.push({ lane: laneWords(laneOf(p)), pct: now, by })
  }
  const changes = MANAGED_PLACEMENTS.flatMap((p) => {
    const from = valueOf(w.current, p)
    const to = valueOf(adjustments, p)
    if (from === to) return []
    const d = decided.find((x) => placementOf(x.lane) === p)
    return [{ lane: laneWords(d?.lane ?? laneOf(p)), from, to, held: d?.held ?? null }]
  })
  const isLocked = (p: string) => !!w.locks?.lanes.get(laneOf(p))
  const kept = blended || w.base ? [] : MANAGED_PLACEMENTS.filter((p) => !requested.some((r) => r.placement === p) && !isLocked(p)).map((p) => ({ lane: laneWords(laneOf(p)), pct: valueOf(adjustments, p) }))
  return changes.length ? { adjustments, changes, kept, locked } : null
}

export interface PlacementReport {
  written: number
  refused: number
  deferred: number
  /** AB-2 — campaigns whose placements are held (the placements pin; the Owner's lock on the hour's plan): nothing written. */
  locked: number
  /** AB-2 — writes that wait this tick (the Owner's locks could not be read): nothing written, nothing dropped. */
  waiting: number
  reasons: string[]
  byCampaign: Map<string, { sent: 'written' | 'refused' | 'deferred' | 'would-apply' | 'locked' | 'waiting'; changes: Array<{ lane: string; from: number; to: number; held: string | null }>; reason?: string }>
}

const valueIn = (list: ReadonlyArray<{ placement: string; percentage: number }> | undefined, p: string): number => list?.find((x) => x.placement === p)?.percentage ?? 0
const noteReason = (out: { reasons: string[] }, reason: string) => { if (out.reasons.length < 3 && !out.reasons.includes(reason)) out.reasons.push(reason) }

/**
 * Write each owned campaign's hour placements, inside the dial and the brain's caps (one change per campaign). AB-2 — the
 * stop recipe's lanes too: a stop's zeroing saves the lanes live first (no zeroing without that memory) and is a floor;
 * the give-back after it is a restore (no cap holds it; it lands under SUGGEST), or a forward move where the hour's own
 * lanes go above the saved ones (a lane the Owner locked goes back to his value: shadow.ts puts it in `base`); once it is
 * written — or nothing is left to give back — the memory goes. The placements pin holds every write, and the Owner's lock
 * the hour's own plan; locks that cannot be read hold the write for a tick. None of these drops a memory.
 */
export async function writeOwnedPlacements(list: readonly PlacementWrite[], ctx: { runId: string; guard: EngineGuard }): Promise<PlacementReport> {
  const out: PlacementReport = { written: 0, refused: 0, deferred: 0, locked: 0, waiting: 0, reasons: [], byCampaign: new Map() }
  const { updatePlacementBidding } = await import('../ads-create.service.js')
  const forget = async (campaignId: string) => {
    try { await forgetLanes(campaignId) } catch (err) { logger.warn('[bid-brain] could not drop the stop\'s saved placements — the next tick tries again', { campaignId, error: err instanceof Error ? err.message : String(err) }) }
  }
  for (const w of list) {
    // AB-2 — held, never dropped: the pin (the gate would refuse), and the Owner's lock on the hour's own plan.
    const holder = w.pinned ?? (!w.recipe && w.locks?.placements ? w.locks.placements.words : null)
    if (holder) {
      out.locked++
      out.byCampaign.set(w.campaignId, { sent: 'locked', changes: [], reason: `placements ${holder}: not written` })
      continue
    }
    // AB-2 — the Owner's locks could not be read: this tick writes nothing and drops nothing; the next tick tries again.
    if (w.wait) {
      out.waiting++
      out.byCampaign.set(w.campaignId, { sent: 'waiting', changes: [], reason: w.wait })
      continue
    }
    const plan = placementPlan(w)
    if (!plan) {
      if (w.recipe === 'restore') await forget(w.campaignId)
      continue
    }
    const permit = ctx.guard.permit({ market: w.market })
    const held = nothingHeld()
    const raises = plan.changes.some((c) => c.to > c.from)
    const giveBack = w.recipe === 'restore' && plan.adjustments.every((a) => a.percentage <= valueIn(w.base, a.placement))
    const kind: ChangeKind = giveBack ? 'restore' : raises ? 'forward' : 'floor'
    if (!allowChange(true, permit, held, kind)) {
      const sent = ctx.guard.posture === 'suggest' ? 'would-apply' as const : 'deferred' as const
      if (sent === 'deferred') out.deferred++
      out.byCampaign.set(w.campaignId, { sent, changes: plan.changes })
      ctx.guard.settle(permit, 0, held)
      continue
    }
    const words = plan.changes.map((c) => `${c.lane} ${c.from}% → ${c.to}%${c.held ? ` (held by ${c.held})` : ''}`).join(', ')
      + (plan.kept.length ? `; the hour sets one placement: ${plan.kept.map((k) => `${k.lane} stays at ${k.pct}%`).join(', ')}` : '')
      + (plan.locked.length ? `; ${plan.locked.map((k) => `${k.lane} ${k.by}: left at ${k.pct}%`).join(', ')}` : '')
    // AB-2 — the stop's memory first: the lanes live before it (an older memory is kept). None kept, none zeroed.
    if (w.recipe === 'stop') {
      try {
        await rememberLanes(w.campaignId, w.current)
      } catch (err) {
        const reason = `the placements before the stop could not be kept (${err instanceof Error ? err.message : String(err)}): nothing zeroed, the next tick tries again`
        out.refused++
        noteReason(out, reason)
        out.byCampaign.set(w.campaignId, { sent: 'refused', changes: plan.changes, reason })
        ctx.guard.settle(permit, 0, held)
        continue
      }
    }
    try {
      const r = await updatePlacementBidding({
        campaignId: w.campaignId,
        adjustments: plan.adjustments,
        actor: BRAIN_ACTOR,
        reason: `bid brain — ${w.note}: ${words}`.slice(0, 480),
        targetKey: w.key,
        evidence: { metric: 'placementBidding', note: `${w.note}: ${words}`.slice(0, 1_000), source: { kind: 'bid-brain', id: ctx.runId }, brain: { runId: ctx.runId, layer: w.recipe ?? 'plan', dataDay: w.dataDay, goalBidCents: null } },
      }) as { ok?: boolean; mode?: string; reason?: string }
      if (r.mode === 'blocked' || r.ok === false) {
        const reason = r.reason ?? 'placement write refused'
        out.refused++
        noteReason(out, reason)
        out.byCampaign.set(w.campaignId, { sent: 'refused', changes: plan.changes, reason })
        ctx.guard.settle(permit, 0, held)
      } else {
        out.written++
        out.byCampaign.set(w.campaignId, { sent: 'written', changes: plan.changes })
        ctx.guard.settle(permit, 1, held)
        if (w.recipe === 'restore') await forget(w.campaignId)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      out.refused++
      noteReason(out, reason)
      out.byCampaign.set(w.campaignId, { sent: 'refused', changes: plan.changes, reason })
      ctx.guard.settle(permit, 0, held)
      logger.warn('[bid-brain] a placement write failed', { campaignId: w.campaignId, error: reason })
    }
  }
  return out
}

/** "placements=2 placements-refused=1 (…)" — the run line's placement part; '' when none moved. */
export function placementReportWords(r: PlacementReport | null | undefined): string {
  if (!r) return ''
  return [
    r.written ? `placements=${r.written}` : '',
    r.deferred ? `placements-deferred=${r.deferred}` : '',
    r.refused ? `placements-refused=${r.refused} (${r.reasons.join('; ')})` : '',
    r.locked ? `placements-locked=${r.locked}` : '',
    r.waiting ? `placements-waiting=${r.waiting} (${[...r.byCampaign.values()].find((b) => b.sent === 'waiting')?.reason ?? ''})` : '',
  ].filter(Boolean).join(' ')
}

/** AB-2 — one owned campaign's bidding-strategy step this tick (stop-recipe.ts strategyStep). */
export interface StrategyWrite {
  campaignId: string
  market: string
  /** Campaign.biddingStrategy now. */
  from: string | null
  step: StrategyStep
  /** The layer the write is recorded under: the stop (or the Min-bid hour) that switches it, or the give-back after it. */
  layer: 'stop' | 'stock' | 'min_bid_hour' | 'restore'
  dataDay: string
}

export interface StrategyReport {
  switched: number
  refused: number
  deferred: number
  /** Steps that wrote nothing on purpose (a lock during a stop, the anti-flap), each with its why. */
  held: number
  reasons: string[]
  byCampaign: Map<string, { sent: 'switched' | 'unchanged' | 'refused' | 'deferred' | 'would-apply' | 'held' | 'forgotten'; from: string | null; to: string | null; why: string; reason?: string }>
}

/**
 * AB-2 — each owned campaign's bidding-strategy step, inside the dial and the brain's caps: a switch to down only for a
 * stop is a floor (the strategy it had saved first: no switch without that memory); the switch back after it is a restore
 * (no cap holds it; it lands under SUGGEST). Through the campaign write every strategy change takes (updateCampaignWithSync,
 * the gate asked first, then the queue, the gate at dispatch and the channel gateway), as automation:bid-brain with its
 * why. Once the switch back is queued — or nothing was left to switch — the memory goes; a `forget` step drops it alone.
 */
export async function writeOwnedStrategies(list: readonly StrategyWrite[], ctx: { runId: string; guard: EngineGuard }): Promise<StrategyReport> {
  const out: StrategyReport = { switched: 0, refused: 0, deferred: 0, held: 0, reasons: [], byCampaign: new Map() }
  const forget = async (campaignId: string) => {
    try { await forgetStrategy(campaignId) } catch (err) { logger.warn('[bid-brain] could not drop the stop\'s saved bidding strategy — the next tick tries again', { campaignId, error: err instanceof Error ? err.message : String(err) }) }
  }
  const refuse = (w: StrategyWrite, to: string, reason: string) => {
    out.refused++
    noteReason(out, reason)
    out.byCampaign.set(w.campaignId, { sent: 'refused', from: w.from, to, why: w.step.why, reason })
  }
  for (const w of list) {
    const s = w.step
    if (s.do === 'hold') {
      out.held++
      out.byCampaign.set(w.campaignId, { sent: 'held', from: w.from, to: null, why: s.why })
      continue
    }
    if (s.do === 'forget') {
      await forget(w.campaignId)
      out.byCampaign.set(w.campaignId, { sent: 'forgotten', from: w.from, to: null, why: s.why })
      continue
    }
    const permit = ctx.guard.permit({ market: w.market })
    const held = nothingHeld()
    if (!allowChange(true, permit, held, s.kind)) {
      const sent = ctx.guard.posture === 'suggest' ? 'would-apply' as const : 'deferred' as const
      if (sent === 'deferred') out.deferred++
      out.byCampaign.set(w.campaignId, { sent, from: w.from, to: s.to, why: s.why })
      ctx.guard.settle(permit, 0, held)
      continue
    }
    try {
      if (s.remember) await rememberStrategy(w.campaignId, s.remember)
    } catch (err) {
      refuse(w, s.to, `the bidding strategy before the stop could not be kept (${err instanceof Error ? err.message : String(err)}): not switched, the next tick tries again`)
      ctx.guard.settle(permit, 0, held)
      continue
    }
    try {
      const r = await updateCampaignWithSync({
        campaignId: w.campaignId,
        patch: { biddingStrategy: s.to as 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL' },
        actor: BRAIN_ACTOR,
        reason: `bid brain — ${s.why}`.slice(0, 480),
        evidence: { metric: 'biddingStrategy', note: s.why.slice(0, 1_000), source: { kind: 'bid-brain', id: ctx.runId }, brain: { runId: ctx.runId, layer: w.layer, dataDay: w.dataDay, goalBidCents: null } },
        askGate: true,
      })
      if (r.ok && r.outboundQueueId) {
        out.switched++
        out.byCampaign.set(w.campaignId, { sent: 'switched', from: w.from, to: s.to, why: s.why })
        ctx.guard.settle(permit, 1, held)
        if (s.kind === 'restore') await forget(w.campaignId)
      } else if (r.ok) {
        out.byCampaign.set(w.campaignId, { sent: 'unchanged', from: w.from, to: s.to, why: s.why })
        ctx.guard.settle(permit, 0, held)
        if (s.kind === 'restore') await forget(w.campaignId)
      } else {
        refuse(w, s.to, r.error ?? 'bidding-strategy write refused')
        ctx.guard.settle(permit, 0, held)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      refuse(w, s.to, reason)
      ctx.guard.settle(permit, 0, held)
      logger.warn('[bid-brain] a bidding-strategy write failed', { campaignId: w.campaignId, error: reason })
    }
  }
  return out
}

/** "strategy=1 strategy-held=1 (…)" — the run line's bidding-strategy part; '' when nothing was asked. */
export function strategyReportWords(r: StrategyReport | null | undefined): string {
  if (!r) return ''
  const held = [...r.byCampaign.values()].filter((b) => b.sent === 'held').map((b) => b.why)
  return [
    r.switched ? `strategy=${r.switched}` : '',
    r.deferred ? `strategy-deferred=${r.deferred}` : '',
    r.refused ? `strategy-refused=${r.refused} (${r.reasons.join('; ')})` : '',
    r.held ? `strategy-held=${r.held} (${[...new Set(held)].slice(0, 3).join('; ')})` : '',
  ].filter(Boolean).join(' ')
}
