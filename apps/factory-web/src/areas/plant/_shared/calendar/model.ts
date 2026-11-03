/**
 * CalendarView's rules (B-W2b-120; the area part on the DS CalendarGrid, plan "CalendarView (on the DS CalendarGrid) is
 * an area part in areas/plant/_shared/calendar; B-W2b-142 reads it"), pure: no React, no clock, no fetch. Every date is
 * an ISO day (`YYYY-MM-DD`), every month an ISO month (`YYYY-MM`); the arithmetic runs on UTC midnights.
 *
 * - A day is drawn as the WORST state of its items: overdue (danger) > due soon (warning) > to confirm / planned (info) >
 *   done (success) > cancelled (plain). A deadline the law or plan gives no fixed day for (TO_CONFIRM) is never late.
 * - The chosen day's agenda lists its items worst first, then by title.
 * - `[` / `]` move a month back / on (`monthStep`): the host listens (the page's keys) and calls `moveMonth`.
 */

/** The item states the calendar draws, worst first (the order of a day's agenda). */
export const CALENDAR_STATES = ['OVERDUE', 'DUE_SOON', 'TO_CONFIRM', 'PLANNED', 'DONE', 'CANCELLED'] as const
export type CalendarState = (typeof CALENDAR_STATES)[number]

/** One item on the calendar, already in words (the host composes the title from its own data). */
export interface CalendarViewItem {
  /** Unique among the items shown. */
  readonly key: string
  /** The day it falls due (`YYYY-MM-DD`). */
  readonly date: string
  /** What it is, in words. */
  readonly title: string
  readonly state: CalendarState
  /** A second line in words (the owner, a count). */
  readonly meta?: string | null
  /** The site's name, shown with "All sites". */
  readonly site?: string | null
}

/** The CalendarGrid kinds a day may take (the legend's entries). */
export const DAY_KINDS = ['overdue', 'dueSoon', 'planned', 'done', 'cancelled'] as const
export type DayKind = (typeof DAY_KINDS)[number]

/** An item state → the kind its day is drawn with (TO_CONFIRM and PLANNED share the info kind). */
export const DAY_KIND_OF: Readonly<Record<CalendarState, DayKind>> = Object.freeze({
  OVERDUE: 'overdue',
  DUE_SOON: 'dueSoon',
  TO_CONFIRM: 'planned',
  PLANNED: 'planned',
  DONE: 'done',
  CANCELLED: 'cancelled',
})

/** Smaller = worse. */
export const stateRank = (state: CalendarState): number => CALENDAR_STATES.indexOf(state)

/** The worst state of a day's items; null for none. */
export function worstState(states: readonly CalendarState[]): CalendarState | null {
  let worst: CalendarState | null = null
  for (const state of states) if (worst === null || stateRank(state) < stateRank(worst)) worst = state
  return worst
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const ISO_MONTH = /^\d{4}-\d{2}$/

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

export function isIsoMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_MONTH.test(value)) return false
  const m = Number(value.slice(5, 7))
  return m >= 1 && m <= 12
}

export const monthOfDay = (day: string): string => day.slice(0, 7)

/** A month `delta` months on (negative: back). */
export function moveMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 + delta
  const year = y + Math.floor(m / 12)
  const index = ((m % 12) + 12) % 12
  return `${String(year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`
}

/** The month's first and last day. */
export function monthBounds(month: string): { first: string; last: string } {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` }
}

export const dayInMonth = (day: string | null | undefined, month: string): boolean => !!day && monthOfDay(day) === month

/** `[` a month back, `]` a month on; anything else null. */
export function monthStep(key: string): -1 | 1 | null {
  if (key === '[') return -1
  if (key === ']') return 1
  return null
}

/** The items per day, each day's list worst first, then by title (the agenda's order). */
export function itemsByDay(items: readonly CalendarViewItem[]): Map<string, CalendarViewItem[]> {
  const days = new Map<string, CalendarViewItem[]>()
  for (const item of items) {
    if (!isIsoDay(item.date)) continue
    const list = days.get(item.date) ?? []
    list.push(item)
    days.set(item.date, list)
  }
  for (const list of days.values()) list.sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
  return days
}

/** What the grid draws per day: the worst state's kind and how many items fall on it. */
export function dayKinds(byDay: ReadonlyMap<string, readonly CalendarViewItem[]>): Record<string, { kind: DayKind; worst: CalendarState; count: number }> {
  const out: Record<string, { kind: DayKind; worst: CalendarState; count: number }> = {}
  for (const [day, list] of byDay) {
    const worst = worstState(list.map((item) => item.state))
    if (worst) out[day] = { kind: DAY_KIND_OF[worst], worst, count: list.length }
  }
  return out
}

/** How many items of each state the month holds (the summary over the agenda). */
export function monthCounts(items: readonly CalendarViewItem[], month: string): Record<CalendarState, number> {
  const counts = Object.fromEntries(CALENDAR_STATES.map((state) => [state, 0])) as Record<CalendarState, number>
  for (const item of items) if (dayInMonth(item.date, month)) counts[item.state] += 1
  return counts
}

/**
 * The day the agenda opens on when none is chosen: today when it is in the month shown, else the month's first day that
 * holds an item, else none.
 */
export function defaultDay(month: string, today: string, byDay: ReadonlyMap<string, readonly CalendarViewItem[]>): string | null {
  if (dayInMonth(today, month)) return today
  const days = [...byDay.keys()].filter((day) => dayInMonth(day, month)).sort()
  return days[0] ?? null
}
