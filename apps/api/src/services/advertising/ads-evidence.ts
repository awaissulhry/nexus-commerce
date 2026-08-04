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
    if (v !== undefined && v !== null && v !== '') out[k] = v
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
