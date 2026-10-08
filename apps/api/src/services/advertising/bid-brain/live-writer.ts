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
 */
import type { AdWriteEvidence } from '../ads-evidence.js'
import { allowChange, nothingHeld, type ChangeKind, type EngineGuard } from '../ads-engine-guard.js'
import { updateAdTargetWithSync } from '../ads-mutation.service.js'
import { logger } from '../../../utils/logger.js'
import type { Decision } from './decide.js'
import { BRAIN_ACTOR } from './live.js'

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
