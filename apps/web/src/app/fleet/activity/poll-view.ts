/**
 * NAF.SB.ACT.S3R Phase 0 — the list and its facet chips are ONE read, or they
 * are a lie.
 *
 * The bug this file exists to make impossible (study §18.9, caught on
 * production): the facet chips were fetched once per `includeSelfTest` change
 * and never again, while the list refetched every ten seconds. A sibling
 * session created and cleaned up four events, and for several minutes the page
 * showed a scope line reading **33 events** sixty pixels above chips summing to
 * **37** — including a whole category, `Asked permission 2`, for events the API
 * no longer returned.
 *
 * There are two ways for those numbers to disagree and the fix has to close
 * BOTH:
 *
 *  1. **Different cadences.** Solved by reading them in the same tick.
 *  2. **Different moments of adoption.** Subtler, and it would have re-created
 *     the bug in the other direction: when new events arrive the page does NOT
 *     insert them under the reader — it holds the fresh page behind a "N new
 *     events" button (Part 12: arrivals are pulled, never pushed). If the
 *     facets adopted immediately while the list waited, the chips would again
 *     be counting rows the list was not showing.
 *
 * So the page and its facets travel as one value, and the only two operations
 * are "adopt this pair" and "hold this pair". Neither is expressible on one
 * half. That is the invariant, and it is structural rather than remembered.
 *
 * Pure on purpose: this is the piece with the interesting logic, and the piece
 * a browser pass is worst at proving. `facets.vitest.test.ts` beside it.
 */

/** The facet vocabulary and its counts, read from the BASE scope.
 *
 *  Base scope means: narrowed by the scope toggles ONLY, never by the facet
 *  selections themselves. Taking it from the filtered response looks right and
 *  is broken — pick one worker and every other worker's chip vanishes, so a
 *  second can never be added. Multi-select was unreachable from the UI for
 *  exactly that reason (Part 16, defect 2). Keep base-scope semantics. */
export interface FacetSnapshot {
  actors: Array<{ key: string; name: string; kind: string }>
  countsByKind: Record<string, number>
  /** The scope's own size — what "filtered from N" counts against. */
  total: number
}

export interface PageLike {
  events: Array<{ id: string }>
  total: number
}

/** A page and the facets read in the SAME tick. Never assembled from two. */
export interface PollView<P extends PageLike> {
  page: P
  /** `null` only when the facet read failed; the pairing still holds. */
  facets: FacetSnapshot | null
}

export type Reconciled<P extends PageLike> =
  /** Nothing is on screen yet, or nothing arrived — show this pair now. */
  | { action: 'adopt'; view: PollView<P>; fresh: 0 }
  /** New events arrived. Keep what the reader is looking at; stage this pair. */
  | { action: 'hold'; view: PollView<P>; fresh: number }

/**
 * Decide what to do with a freshly-read pair.
 *
 * `seenIds` is what is currently rendered — "new" is measured on event ids at
 * the head, never on counts, because a cost ticking up a hundredth of a cent is
 * not news (Part 12).
 *
 * The returned `view` is always the WHOLE pair, so a caller cannot apply the
 * page without the facets that were read with it. That is the entire point.
 */
export function reconcilePoll<P extends PageLike>(
  shown: P | null,
  next: PollView<P>,
  seenIds: ReadonlySet<string>,
): Reconciled<P> {
  if (shown === null) return { action: 'adopt', view: next, fresh: 0 }
  let fresh = 0
  for (const e of next.page.events) if (!seenIds.has(e.id)) fresh++
  return fresh > 0 ? { action: 'hold', view: next, fresh } : { action: 'adopt', view: next, fresh: 0 }
}

/**
 * The one number S1 prints that is derived from BOTH reads: how much the
 * self-test toggle is hiding.
 *
 * `whole` is the entire history; `facets.total` is the base scope under the
 * current toggles. Both must come from the same adopted pair or the arithmetic
 * is quietly wrong — 33 shown + 86 hidden has to equal the 119 the operator
 * sees the moment they tick the box.
 */
export function hiddenByScope(whole: number | null, facets: FacetSnapshot | null): number {
  if (whole == null || facets == null) return 0
  return Math.max(0, whole - facets.total)
}
