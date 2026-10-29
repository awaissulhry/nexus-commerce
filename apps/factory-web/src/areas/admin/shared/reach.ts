import type { BulkResult } from './bulk'
import type { Notice } from './model'

/**
 * What a bulk action of an Admin list says before and after its run (Owner rule 2026-10-29): which ticked rows it
 * reaches ("Suspend 2" when 3 are ticked and 1 is suspended already) or why it is held, the names its confirm lists,
 * and the run's ONE notice. Pure. The run itself is `runBulk` (bulk.ts).
 */

/** Which selected rows an action applies to, and why it is held when it applies to none (a message key). */
export interface BulkReach<T> {
  /** The rows it applies to, in the list's order ("Suspend 2" when 3 are selected and 1 is suspended already). */
  items: T[]
  /** `right.<permission>` (a right the person lacks) or the rule's own sentence; null when it can run. */
  held: string | null
  /** Selected rows it leaves out. */
  skipped: number
}

/**
 * The reach of an action: the selected rows `applies` keeps. `rule.held` holds it whatever the rows (a right the person
 * lacks: `right.<permission>`, or a rule such as "nobody gives roles to themselves"); `rule.none` holds it when it
 * applies to none of them.
 */
export function reachOf<T>(selected: readonly T[], applies: (item: T) => boolean, rule: { held?: string | null; none: string }): BulkReach<T> {
  const items = selected.filter(applies)
  const held = rule.held ? rule.held : items.length === 0 ? rule.none : null
  return { items: held ? [] : items, held, skipped: held ? selected.length : selected.length - items.length }
}

/**
 * A run's ONE result notice: `doneKey` with the count done ("2 suspended"); the refused rows named with their problem
 * ("1 refused: Carlo Prova — changed by someone else"). All done: success; some refused: warning; none done: danger.
 */
export function bulkNotice<T>(result: BulkResult<T>, doneKey: string, nameOf: (item: T) => string): Notice {
  const refused = result.refused.map(({ item, problem }) => ({ name: nameOf(item), problem }))
  return {
    key: doneKey,
    tone: refused.length === 0 ? 'success' : result.done.length === 0 ? 'danger' : 'warning',
    params: { count: result.done.length },
    ...(refused.length > 0 ? { refused } : {}),
  }
}

/** The names a bulk confirm lists: up to five, then "and N more" (`more` words the rest). */
export function namesLine(names: readonly string[], more: (count: number) => string): string {
  return names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} ${more(names.length - 5)}`
}
