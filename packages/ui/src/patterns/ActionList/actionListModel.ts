/**
 * ActionList's rules (B-W2b-155, design part ActionList): what waits for a partner, sorted by how soon it is due, and
 * the counts the portal's Home and the rail's badges read — ONE model for both, so a badge never counts what the list
 * does not show. Pure: no React, no clock (a due's state comes from the app, which knows the site's day).
 */

/** Where a request's due date stands today (the API's OVERDUE | TODAY | SOON | LATER | NONE, in lower case). */
export type ActionDueState = 'overdue' | 'today' | 'soon' | 'later' | 'none'

export const ACTION_DUE_STATES = ['overdue', 'today', 'soon', 'later', 'none'] as const satisfies readonly ActionDueState[]

/** The due of a request: when (an ISO instant) and its state; `text` is the date already written in the page's language. */
export interface ActionDue {
  at: string
  state: ActionDueState
  text?: string
}

/** The minimum an item needs for the model: its id, its due and whether it is done (Undo still offered). */
export interface ActionModelItem {
  id: string
  due?: ActionDue | null
  done?: unknown
}

export interface ActionModelGroup<T extends ActionModelItem = ActionModelItem> {
  id: string
  items: readonly T[]
}

const RANK: Readonly<Record<ActionDueState, number>> = { overdue: 0, today: 1, soon: 2, later: 3, none: 4 }

const stateOf = (item: ActionModelItem): ActionDueState => item.due?.state ?? 'none'
const timeOf = (item: ActionModelItem): number => {
  const t = item.due && item.due.state !== 'none' ? Date.parse(item.due.at) : Number.NaN
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/**
 * The order a person works in: overdue first, then due today, soon, later and without a date; inside a state the
 * earlier due first. Stable: items that tie keep the order they came in. A new array; the input is not changed.
 */
export function sortActionItems<T extends ActionModelItem>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => RANK[stateOf(a.item)] - RANK[stateOf(b.item)] || timeOf(a.item) - timeOf(b.item) || a.index - b.index)
    .map(({ item }) => item)
}

/** An item that still waits: not done (a row showing "Done · Undo" no longer counts). */
export const actionItemOpen = (item: ActionModelItem): boolean => !item.done

export interface ActionListCounts {
  /** Everything that still waits. */
  open: number
  /** Of those, past their due. */
  overdue: number
  /** Of those, due today or soon. */
  dueSoon: number
  /** Group id → what still waits in it (the rail's badge per area). */
  byGroup: Record<string, number>
}

/** The counts of the list and the badges: open requests, overdue, due today or soon, per group. */
export function actionListCounts(groups: readonly ActionModelGroup[]): ActionListCounts {
  const counts: ActionListCounts = { open: 0, overdue: 0, dueSoon: 0, byGroup: {} }
  for (const group of groups) {
    let open = 0
    for (const item of group.items) {
      if (!actionItemOpen(item)) continue
      open++
      const state = stateOf(item)
      if (state === 'overdue') counts.overdue++
      else if (state === 'today' || state === 'soon') counts.dueSoon++
    }
    counts.byGroup[group.id] = (counts.byGroup[group.id] ?? 0) + open
    counts.open += open
  }
  return counts
}

/** How a due is drawn: a danger word with the date, a live countdown, the date, or nothing. */
export type ActionDueView = { kind: 'overdue'; text?: string } | { kind: 'countdown'; at: string; tone: 'warning' | 'info' } | { kind: 'date'; text: string } | { kind: 'none' }

export function actionDueView(due: ActionDue | null | undefined): ActionDueView {
  if (!due || due.state === 'none') return { kind: 'none' }
  if (due.state === 'overdue') return { kind: 'overdue', text: due.text }
  if (due.state === 'today' || due.state === 'soon') return { kind: 'countdown', at: due.at, tone: due.state === 'today' ? 'warning' : 'info' }
  // Later: the written date; without one the countdown still says how far it is ("Due in 6 d").
  return due.text ? { kind: 'date', text: due.text } : { kind: 'countdown', at: due.at, tone: 'info' }
}
