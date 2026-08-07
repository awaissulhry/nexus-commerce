/**
 * NAF.SB.W — which workers a view shows.
 *
 * Extracted from WorkersClient purely so it can be tested. The invariant it
 * exists to protect is one sentence, and it has now been broken twice by
 * features that touched the row set:
 *
 *   **A tile or chip that filters counts through THIS function, never through
 *   `rows.length` — so its number always equals the rows you get when you
 *   click it.**
 *
 * W.2 established it after a tile read 3 above a table showing 4. W.9 broke it
 * again the moment a Retired view existed: "All 3" over two visible rows,
 * because `rows.length` counted a retired worker that `all` excludes. Twice is
 * a pattern, and a pattern wants a test rather than vigilance — see
 * views.vitest.test.ts.
 */

export type View = 'all' | 'live' | 'attention' | 'eligible' | 'retired'

/** The minimum a row must expose for a view to judge it. */
export interface ViewableWorker {
  charter: {
    enabled: boolean
    autonomyLevel: string
    retired?: boolean
  }
  status: { word: string; needsAttention: boolean }
  promotionEligible: boolean
}

export function matchesView(r: ViewableWorker, v: View): boolean {
  /* A retired worker is kept for its history and appears in exactly ONE view.
     Leaving it in "All" would grow the roster forever with workers that cannot
     run; hiding it entirely would lose the history that is the whole reason
     retirement is a state and not a delete. */
  if (r.charter.retired) return v === 'retired'
  if (v === 'retired') return false

  switch (v) {
    case 'live':
      // A paused worker is not "switched on", whatever its dial says.
      return r.status.word !== 'paused'
        && r.charter.enabled
        && r.charter.autonomyLevel !== 'OFF'
    case 'attention':
      return r.status.needsAttention
    case 'eligible':
      return r.promotionEligible
    case 'all':
    default:
      return true
  }
}

/** The only correct way to count a view. Never `rows.length`. */
export function countIn(rows: ViewableWorker[], v: View): number {
  return rows.filter((r) => matchesView(r, v)).length
}
