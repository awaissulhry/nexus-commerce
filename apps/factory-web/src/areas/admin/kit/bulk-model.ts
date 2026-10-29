import type { Notice } from '../shared/model'
import type { BulkResult } from '../shared/bulk'

/**
 * The rules every B-W0-28 bulk action shares, pure: which of the selected rows an action applies to (and why each other
 * one is left out), why its button is held, and the ONE notice after the run. The pages' own models say, per action,
 * which rows it applies to; the tests hold each.
 */

/** The selected rows an action applies to, and each other one with why it is left out (a message key of the page). */
export interface Reach<T> {
  applies: T[]
  left: Array<{ item: T; why: string }>
}

/** Splits the selection: `leftOut` names why a row is left out (a message key), or null when the action applies to it. */
export function reachOf<T>(items: readonly T[], leftOut: (item: T) => string | null): Reach<T> {
  const reach: Reach<T> = { applies: [], left: [] }
  for (const item of items) {
    const why = leftOut(item)
    if (why === null) reach.applies.push(item)
    else reach.left.push({ item, why })
  }
  return reach
}

/** The left-out rows counted per reason, in the order the reasons first appear ("2 closed already", "1 not connected"). */
export function leftCounts(reach: Pick<Reach<unknown>, 'left'>): Array<{ why: string; count: number }> {
  const counts = new Map<string, number>()
  for (const { why } of reach.left) counts.set(why, (counts.get(why) ?? 0) + 1)
  return [...counts].map(([why, count]) => ({ why, count }))
}

/**
 * Why a bulk button is held, as a message key: the person lacks the right (`right`), or the action applies to none of
 * the selected rows (`none`); null when it may run.
 */
export function bulkHeld(reach: Pick<Reach<unknown>, 'applies'>, allowed: boolean, keys: { right: string; none: string }): string | null {
  if (!allowed) return keys.right
  if (reach.applies.length === 0) return keys.none
  return null
}

/** The notice after a bulk run, with each refused row (its id, and the problem as a message key) said under it. */
export interface BulkNotice extends Notice {
  /** Each refused row's id (`PageNotice` names it with `nameOf`) and its problem. */
  refusedIds?: ReadonlyArray<{ id: string; problem: string }>
}

/**
 * The ONE notice after a bulk run: every row done (`done`, count = done), some refused (`partial`: count = done, with
 * refused and total), or none done (`failed`, count = refused). Each refused row is listed by id with its problem; the
 * view names it.
 */
export function bulkNotice<T>(result: BulkResult<T>, keys: { done: string; partial: string; failed: string }, idOf: (item: T) => string): BulkNotice {
  const done = result.done.length
  const refused = result.refused.length
  const total = done + refused
  const list = result.refused.map((entry) => ({ id: idOf(entry.item), problem: entry.problem }))
  if (refused === 0) return { key: keys.done, tone: 'success', params: { count: done, total } }
  if (done === 0) return { key: keys.failed, tone: 'danger', params: { count: refused, total }, refusedIds: list }
  return { key: keys.partial, tone: 'warning', params: { count: done, done, refused, total }, refusedIds: list }
}

/** The selected ids still among the rows on screen (a filter or a new read hides the others: no action reaches them). */
export function onScreen(selected: readonly string[] | undefined, rowIds: readonly string[]): string[] {
  if (!selected || selected.length === 0) return []
  const shown = new Set(rowIds)
  return selected.filter((id) => shown.has(id))
}
