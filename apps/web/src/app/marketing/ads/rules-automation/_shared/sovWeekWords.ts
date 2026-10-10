/**
 * Free visibility numbers (2026-10-10, integration) — why a Share of Voice market is skipped, in the gate's own terms.
 *
 * The API's week gate (ads-sov-keyword-share.service.ts) refuses a market for one of two reasons, and they need
 * different words: Amazon has not published a complete Brand Analytics week yet, or (A3) the newest complete week ended
 * longer ago than the engine's age limit (14 days). Calling the second one "no complete week" was false — the week is
 * there, it is too old to move bids. The age said here is the one the limit compares: days since the week ENDED.
 * Pure: the census strip (SovRulesClient) and the rule preview (RuleBuilder) both read it.
 */

/** One market's gate answer, as the strip and the preview carry it (older payloads lack the A3 fields). */
export interface SovPeriodWords {
  marketplace: string
  refused: boolean
  reason?: string
  weekEndAgeDays?: number | null
  maxAgeDays?: number
  note?: string
}

/** The words of a market refused as too old: the age and the limit the gate compared, else the gate's own note. */
export function tooOldWords(p: SovPeriodWords): string {
  if (p.weekEndAgeDays != null && p.maxAgeDays != null) {
    return `newest complete week ended ${p.weekEndAgeDays} ${p.weekEndAgeDays === 1 ? 'day' : 'days'} ago (limit ${p.maxAgeDays} days)`
  }
  const note = p.note?.replace(new RegExp(`^${p.marketplace}: `), '')
  return note || 'newest complete week is older than the age limit'
}

/** The refused markets, split by why: no complete week yet, or a complete week too old to use (with its words). */
export function refusedSovMarkets(periods: readonly SovPeriodWords[]): {
  incomplete: string[]
  tooOld: Array<{ marketplace: string; words: string }>
} {
  const refused = periods.filter((p) => p.refused)
  return {
    incomplete: refused.filter((p) => p.reason !== 'too-old').map((p) => p.marketplace),
    tooOld: refused.filter((p) => p.reason === 'too-old').map((p) => ({ marketplace: p.marketplace, words: tooOldWords(p) })),
  }
}
