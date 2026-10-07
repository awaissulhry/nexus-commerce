/**
 * ADS AUTONOMY — auto-undo's numbers, in ONE place: what "clearly worse" means, how much data a judgement needs, how
 * long a change waits, how far an undo may raise and how many undos a day. Per market: `AUTO_UNDO_BY_MARKET` overrides
 * any field of `AUTO_UNDO_DEFAULTS` for one Amazon market (its code, IT, DE …). Conservative on purpose: a judgement
 * needs real clicks and spend after the change, "worse" must be worse than the comparable entities AND by a margin, and
 * no data is never worse.
 *
 * A LEAF: pure, no imports from the API.
 */

export interface AutoUndoThresholds {
  /** A change is judged only once this many days after it are settled (each day ended this many hours ago, below). */
  settledDaysAfter: number
  /** Amazon restates a day for this long: a day counts as settled only once it ended this many hours ago. */
  settleHours: number
  /** Changes older than this are not judged (and never undone). */
  lookbackDays: number
  /** Enough data: at least this many clicks on the entity in the days after the change. */
  minClicks: number
  /** Enough data: at least this much ad spend on the entity in the days after the change, in minor units (cents). */
  minSpendCents: number
  /** Clearly worse (ACoS): its ACoS rose by more than this many percentage points, and its sales did not rise. */
  acosPointsUp: number
  /** Clearly worse (a raise with no sales): its spend rose by more than this percent and it sold nothing after. */
  spendUpPct: number
  /** An undo that RAISES (the undo of a cut) may raise by at most this percent, and never past the ads strategy's own limits. */
  maxRaisePct: number
  /** The most undos (would undo, asked, or done) per market per UTC day. */
  maxUndosPerDay: number
}

export const AUTO_UNDO_DEFAULTS: Readonly<AutoUndoThresholds> = Object.freeze({
  settledDaysAfter: 3,
  settleHours: 72,
  lookbackDays: 14,
  minClicks: 20,
  minSpendCents: 1_000,
  acosPointsUp: 10,
  spendUpPct: 50,
  maxRaisePct: 25,
  maxUndosPerDay: 5,
})

/** Per-market overrides of the defaults (an Amazon market code → the fields that differ). Empty: every market alike. */
export const AUTO_UNDO_BY_MARKET: Readonly<Record<string, Partial<AutoUndoThresholds>>> = Object.freeze({})

/** The thresholds of one market (its code, any case; null: the defaults). */
export function autoUndoThresholds(market: string | null | undefined, overrides: Readonly<Record<string, Partial<AutoUndoThresholds>>> = AUTO_UNDO_BY_MARKET): AutoUndoThresholds {
  const code = (market ?? '').trim().toUpperCase()
  return { ...AUTO_UNDO_DEFAULTS, ...(code ? overrides[code] ?? {} : {}) }
}
