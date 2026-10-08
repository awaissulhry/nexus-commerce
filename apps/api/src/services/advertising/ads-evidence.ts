/**
 * ADX A2 — the evidence an ads write carries with it.
 *
 * `AdvertisingActionLog.payloadBefore/payloadAfter` answer *what changed*, and
 * `userId` answers *who changed it*. Neither answers the question an operator
 * actually asks when a bid moves, which is **on what evidence**. Without that, the
 * audit log is only readable by someone who already knows how the engine works —
 * which is most of why this system felt uncontrollable even where it ran correctly.
 *
 * Every field is optional on purpose. A write that genuinely has nothing numeric to
 * say (an operator edit, a rollback) should still be able to record a `note` rather
 * than being forced to invent a metric.
 *
 * Deliberately NOT a free-text string: "rank — Min bid placement 150→300%" is
 * readable but not queryable, and the whole point is to be able to ask "show me every
 * write that fired on fewer than N days of data".
 */

import type { WriteSources } from './ads-strategy/bids.js'

export interface AdWriteEvidence {
  /** The RankTarget key or rule identity the decision was serving, e.g. 'own-top'. */
  targetKey?: string
  /** The metric that drove it, e.g. 'topOfSearchImpressionShare' | 'acos' | 'sqpBrandShare'. */
  metric?: string
  /** What we actually observed for that metric. */
  observed?: number | null
  /** What we wanted — the target, cap or threshold being chased or respected. */
  threshold?: number | null
  /** Lookback in days. */
  windowDays?: number | null
  /**
   * How much data the observation rests on (rows, days, or impressions — `sampleUnit`
   * says which). This matters more than it looks: AMS coverage is per-campaign, and
   * some schedules hold 1–5 days of data where the account has 56. A decision resting
   * on thin data should say so on its face rather than being indistinguishable from a
   * well-evidenced one.
   */
  sampleSize?: number | null
  sampleUnit?: 'rows' | 'days' | 'impressions'
  /** Free text for the part that is genuinely not numeric. */
  note?: string
  /**
   * 6.1 — on a budget schedule's give-back: the window entry it gives back, so the history can say
   * so. A record for the reader only: the write gate never trusts it, and recognises a give-back
   * from the action log itself (ads-budget-giveback.ts).
   */
  giveBackOf?: string
  /** 3A (Owner decided 2026-10-06) — "sent past <limit> by <person>": a person confirmed this write past his own limits. */
  sentPastOwnLimits?: string
  /**
   * ADS AUTONOMY W1-5 — which level supplied each number this write used (design §3.2): the target ACoS the bid moved
   * toward (explicit, campaign, a strategy row, account, profit, flat) and the strategy's bid limits in force (lowest,
   * highest, largest change), each with its row and version. `ad-changes` returns it with the rest of the evidence.
   */
  sources?: WriteSources
  /**
   * W1-5 — a PERSON's own edit that goes past an ads strategy limit: it was sent (the strategy warns a person, never
   * refuses or rewrites his edit), and this says which limit and whose.
   */
  strategyWarning?: string
  /**
   * ADS AUTONOMY W3-1 — what this write carries out, when an engine produced it: `kind` recommendation and the id
   * ad-recommendations gave it (`bid:<targetId>`, `budget:<campaignId>` …), so the Change Log and Claude's daily report
   * can say "from the bid optimizer". A record for the reader only: no gate trusts it.
   */
  source?: { kind: string; id: string }
  /**
   * ADS AUTONOMY W4-4 — an approved Claude bid request that hands the bid back to auto-bid (its `afterwards: 'auto-bid'`,
   * which the person saw on the card): bid-grid.service.ts personBidTargetIds does not count this write as a person's
   * bid, so auto-bid may move it from its next run. Honoured only on an operator's write whose change set
   * (`executionId`) is a request a PERSON decided — never one the business's rule ran (the tools refuse that by rule
   * too); a person's own edit never carries it.
   */
  handBack?: 'auto-bid'
  /**
   * Bid optimiser review 2026-10-08 (B) — the settled data day ('YYYY-MM-DD', the newest day of the window) the bid
   * optimiser decided this bid on. Its next run does not reverse this move until REVERSAL_WAIT_DATA_DAYS newer data days
   * exist (ads-bid-window.ts). A record of the decision: no gate trusts it.
   */
  dataDay?: string
  /**
   * BID BRAIN BB-6 — a write of the bid brain (actor `automation:bid-brain`): the run that decided it, the deciding layer
   * (goal, band, limit, stop, stock, freeze, phase, min_bid_hour), the newest settled data day it read and the goal bid.
   * A record for the reader (the Change Log, auto-undo, the read tool): no gate trusts it.
   */
  brain?: { runId: string; layer: string; dataDay: string; goalBidCents: number | null }
}

/**
 * Strip undefined keys so the stored JSON stays small and comparable, and return null
 * when there is nothing worth recording — a column full of `{}` is worse than a null,
 * because it looks like evidence was captured when it wasn't.
 */
export function packEvidence(e: AdWriteEvidence | null | undefined): AdWriteEvidence | null {
  if (!e) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    // W1-5 — an empty `sources` map is no provenance, like an empty string is no note.
    const emptyMap = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0
    if (v !== undefined && v !== null && v !== '' && !emptyMap) out[k] = v
  }
  return Object.keys(out).length > 0 ? (out as AdWriteEvidence) : null
}

/** True when the evidence rests on less data than `minDays`. Used to flag thin decisions. */
export function isThinEvidence(e: AdWriteEvidence | null | undefined, minDays = 7): boolean {
  if (!e) return false
  if (e.sampleUnit === 'days' && typeof e.sampleSize === 'number') return e.sampleSize < minDays
  if (typeof e.windowDays === 'number' && typeof e.sampleSize === 'number' && e.sampleUnit === 'rows') {
    return e.sampleSize === 0
  }
  return false
}
