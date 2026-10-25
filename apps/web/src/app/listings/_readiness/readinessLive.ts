/**
 * Listing readiness — what a live event refreshes.
 *
 * `readiness.updated` (`{ rootProductId }`) names ONE family: only that family, if it is open, and the top level are
 * read again. Any other event (a product or listing changed) gives no family, so every open family is read again.
 * Events are gathered for about a second first, so a burst of rebuilds is one refresh.
 *
 * Pure — the page owns the timer and the grid.
 */
export const READINESS_EVENT = 'readiness.updated'
export const LIVE_DEBOUNCE_MS = 1_000
export const LIVE_INTERVAL_MS = 30_000

export interface LiveEventLike { type: string; id?: string; meta?: Record<string, unknown> }

/** The family a `readiness.updated` event names: its subject id, else the payload's `rootProductId`. */
export function readinessRootOf(event: LiveEventLike): string | null {
  if (event.type !== READINESS_EVENT) return null
  if (typeof event.id === 'string' && event.id) return event.id
  const root = event.meta?.rootProductId
  return typeof root === 'string' && root ? root : null
}

export interface RefreshPlan { all: boolean; roots: ReadonlySet<string> }
export const EMPTY_PLAN: RefreshPlan = { all: false, roots: new Set() }

export function addToPlan(plan: RefreshPlan, event: LiveEventLike): RefreshPlan {
  const root = readinessRootOf(event)
  if (!root) return { all: true, roots: plan.roots }
  return { all: plan.all, roots: new Set([...plan.roots, root]) }
}

/** The open families to read again, of those on screen. The top level is always read again. */
export function familiesToRefresh(plan: RefreshPlan, openFamilies: readonly string[]): string[] {
  return plan.all ? [...openFamilies] : openFamilies.filter((id) => plan.roots.has(id))
}

/** Coming back to the tab fires `focus` and `visibilitychange` together: one read, not two. */
export const RETURN_DEDUPE_MS = 2_000

/** Whether a re-read may start now, given when the last one started (null: never). */
export function mayRefreshAgain(lastAt: number | null, now: number): boolean {
  return lastAt == null || now - lastAt >= RETURN_DEDUPE_MS
}
