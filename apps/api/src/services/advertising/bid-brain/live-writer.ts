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
 *            step clamp do not hold it up — the gate judges it as the lowering it is); every other move is forward.
 *            BB-7 — a give-back (`restore`: the bid going back where it was before a floor) is forced too, as rank-defend's
 *            and the stops' own give-backs are: the step clamp would bring a keyword back from a 2¢ floor 25 % a write.
 *            decide() already holds the bid inside the limits; the gate judges it as the raise it is
 *   once     decide() moves a keyword at most once per new settled data day (its lastStep anchor): a rerun on the same
 *            evidence asks nothing
 *   BB-7     the hourly plan's placement % of an owned campaign: one placement write per campaign when the hour's % (capped
 *            so that its highest base bid × (1 + p) × Amazon's dynamic bidding stays within the lane's CPC ceiling)
 *            differs from what is live — through updatePlacementBidding as the brain (the gate judges it, Amazon's
 *            current array is read and merged first)
 */
import type { AdWriteEvidence } from '../ads-evidence.js'
import { allowChange, nothingHeld, type EngineGuard } from '../ads-engine-guard.js'
import { updateAdTargetWithSync } from '../ads-mutation.service.js'
import { buildBlendedAdjustments, MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import { logger } from '../../../utils/logger.js'
import type { Decision } from './decide.js'
import { BRAIN_ACTOR } from './live.js'
import { placementOf } from './plan-hour.js'
import { laneWords, placementsFor, type Lane } from './recipe.js'

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

const FLOOR_LAYERS = new Set(['stop', 'stock', 'phase', 'min_bid_hour'])

/** A floor: a lowering decided by a stop, stock, the phase or a Min-bid hour. Every other write is a forward move. */
export function isFloorWrite(d: Pick<Decision, 'layer' | 'bidCents' | 'currentCents'>): boolean {
  return FLOOR_LAYERS.has(d.layer) && d.bidCents < d.currentCents
}

/** BB-7 — a write the mutation layer must take exactly: a floor, or a give-back after one (no step clamp, no 5¢ lift). */
export function isExactWrite(d: Pick<Decision, 'layer' | 'bidCents' | 'currentCents'>): boolean {
  return isFloorWrite(d) || d.layer === 'restore'
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
      const kind = isFloorWrite(d) ? 'floor' : 'forward'
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
          // A floor lands exactly (below the 5¢ engine floor, past the step clamp); the gate sees a forced lowering. A
          // give-back lands exactly too (BB-7); the gate judges it as a raise (isSuppressionWrite: not every value goes down).
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
}

/** What one campaign's placements become, and which lanes change; null when nothing changes. Pure. */
export function placementPlan(w: Pick<PlacementWrite, 'lanes' | 'current' | 'maxBidCents' | 'raiseCap'>): { adjustments: Array<{ placement: string; percentage: number }>; changes: Array<{ lane: string; from: number; to: number; held: string | null }> } | null {
  if (!w.lanes.length) return null
  // The CR cap of placementsFor waits for the placement report (crRatio null): only the CPC ceilings hold here.
  const decided = placementsFor(w.maxBidCents, w.lanes, { aim: 1, hi: 1 })
  const liveOf = (p: string) => w.current.find((x) => x.placement === p)?.percentage ?? 0
  // BB-10 — under the raise cap a lane may come down, never go up: it keeps what it has.
  const requested = decided.map((d) => {
    const placement = placementOf(d.lane)
    return { placement, percentage: w.raiseCap && d.pct > liveOf(placement) ? liveOf(placement) : d.pct }
  })
  const blended = w.lanes.length > 1
  const adjustments = blended
    ? buildBlendedAdjustments([...w.current], requested)
    : [...w.current.filter((c) => !requested.some((r) => r.placement === c.placement)), ...requested]
  const valueOf = (list: ReadonlyArray<{ placement: string; percentage: number }>, p: string) => list.find((x) => x.placement === p)?.percentage ?? 0
  const changes = MANAGED_PLACEMENTS.flatMap((p) => {
    const from = valueOf(w.current, p)
    const to = valueOf(adjustments, p)
    if (from === to) return []
    const d = decided.find((x) => placementOf(x.lane) === p)
    return [{ lane: laneWords(d?.lane ?? 'REST_OF_SEARCH'), from, to, held: d?.held ?? null }]
  })
  return changes.length ? { adjustments, changes } : null
}

export interface PlacementReport {
  written: number
  refused: number
  deferred: number
  reasons: string[]
  byCampaign: Map<string, { sent: 'written' | 'refused' | 'deferred' | 'would-apply'; changes: Array<{ lane: string; from: number; to: number; held: string | null }>; reason?: string }>
}

/** Write each owned campaign's hour placements, inside the dial and the brain's caps (one change per campaign). */
export async function writeOwnedPlacements(list: readonly PlacementWrite[], ctx: { runId: string; guard: EngineGuard }): Promise<PlacementReport> {
  const out: PlacementReport = { written: 0, refused: 0, deferred: 0, reasons: [], byCampaign: new Map() }
  const { updatePlacementBidding } = await import('../ads-create.service.js')
  for (const w of list) {
    const plan = placementPlan(w)
    if (!plan) continue
    const permit = ctx.guard.permit({ market: w.market })
    const held = nothingHeld()
    const raises = plan.changes.some((c) => c.to > c.from)
    if (!allowChange(true, permit, held, raises ? 'forward' : 'floor')) {
      const sent = ctx.guard.posture === 'suggest' ? 'would-apply' as const : 'deferred' as const
      if (sent === 'deferred') out.deferred++
      out.byCampaign.set(w.campaignId, { sent, changes: plan.changes })
      ctx.guard.settle(permit, 0, held)
      continue
    }
    const words = plan.changes.map((c) => `${c.lane} ${c.from}% → ${c.to}%${c.held ? ` (held by ${c.held})` : ''}`).join(', ')
    try {
      const r = await updatePlacementBidding({
        campaignId: w.campaignId,
        adjustments: plan.adjustments,
        actor: BRAIN_ACTOR,
        reason: `bid brain — ${w.note}: ${words}`.slice(0, 480),
        targetKey: w.key,
        evidence: { metric: 'placementBidding', note: `${w.note}: ${words}`.slice(0, 1_000), source: { kind: 'bid-brain', id: ctx.runId }, brain: { runId: ctx.runId, layer: 'plan', dataDay: w.dataDay, goalBidCents: null } },
      }) as { ok?: boolean; mode?: string; reason?: string }
      if (r.mode === 'blocked' || r.ok === false) {
        const reason = r.reason ?? 'placement write refused'
        out.refused++
        if (out.reasons.length < 3 && !out.reasons.includes(reason)) out.reasons.push(reason)
        out.byCampaign.set(w.campaignId, { sent: 'refused', changes: plan.changes, reason })
        ctx.guard.settle(permit, 0, held)
      } else {
        out.written++
        out.byCampaign.set(w.campaignId, { sent: 'written', changes: plan.changes })
        ctx.guard.settle(permit, 1, held)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      out.refused++
      if (out.reasons.length < 3 && !out.reasons.includes(reason)) out.reasons.push(reason)
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
  ].filter(Boolean).join(' ')
}
