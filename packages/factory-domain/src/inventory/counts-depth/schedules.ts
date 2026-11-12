import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { plusCalendarDays } from '../../timers/rules'
import { COUNT_ITEM_KINDS } from '../counts/rules'

/**
 * Count schedules (B-W2b-299; SCM-227; design warehouse.counts cn-schedule "Due counts", the tile "Due this week"): a site's
 * stock under a location (a warehouse, a zone or a bin and everything inside it), a class of materials (A, B, C by the value
 * they use: ./abc.ts) or a kind of material, counted every N days. The next date is set when a count that covered the
 * schedule closes (its differences applied): that day plus the days. A due schedule makes a COUNT task (B-W2b-292's hourly
 * source, modules/inventory/tasks/sources/count-schedules). Rule 2: the year-end count is a legal duty met in one session; a
 * schedule spreads the counting over the year. Pure.
 */

export const ABC_CLASSES = ['A', 'B', 'C'] as const
export type AbcClass = (typeof ABC_CLASSES)[number]

export const SCHEDULE_LIMITS = Object.freeze({ name: 200, note: 1000, minDays: 1, maxDays: 366, list: 500, dueWithinDays: 7 })

export interface ScheduleScope {
  readonly locationId: string | null
  readonly abcClass: AbcClass | null
  readonly itemKind: string | null
}

export interface ScheduleDraft extends ScheduleScope {
  readonly name: string
  readonly everyDays: number
  readonly nextDueOn: string | null
}

/** What is wrong with a schedule as it would be written (paths `body/…`). */
export function scheduleProblems(draft: ScheduleDraft): Issue[] {
  const problems: Issue[] = []
  const name = draft.name.trim()
  if (name.length === 0 || name.length > SCHEDULE_LIMITS.name) problems.push({ path: 'body/name', message: `A schedule has a name of 1 to ${SCHEDULE_LIMITS.name} characters.` })
  if (draft.locationId === null && draft.abcClass === null && draft.itemKind === null) {
    problems.push({ path: 'body/locationId', message: 'A schedule counts something: a location, a class of materials (A, B, C) or a kind of material.' })
  }
  if (draft.itemKind !== null && !(COUNT_ITEM_KINDS as readonly string[]).includes(draft.itemKind)) problems.push({ path: 'body/itemKind', message: `${draft.itemKind} is not a kind of material.` })
  if (!Number.isInteger(draft.everyDays) || draft.everyDays < SCHEDULE_LIMITS.minDays || draft.everyDays > SCHEDULE_LIMITS.maxDays) {
    problems.push({ path: 'body/everyDays', message: `A schedule counts every ${SCHEDULE_LIMITS.minDays} to ${SCHEDULE_LIMITS.maxDays} days.` })
  }
  if (draft.nextDueOn !== null && !isBusinessDate(draft.nextDueOn)) problems.push({ path: 'body/nextDueOn', message: 'The next count is a calendar day written YYYY-MM-DD.' })
  return problems
}

/** The day the next count is due after one closed on `closedOn`. */
export const nextDueAfter = (closedOn: BusinessDate, everyDays: number): BusinessDate => plusCalendarDays(closedOn, everyDays)

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysFrom(from: BusinessDate, to: BusinessDate): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

export type DueState = 'OVERDUE' | 'DUE_TODAY' | 'DUE_SOON' | 'LATER' | 'RETIRED'

export interface DueFacts {
  readonly active: boolean
  readonly nextDueOn: BusinessDate
}

/**
 * Where a schedule stands today: OVERDUE (its day passed), DUE_TODAY, DUE_SOON (within `withinDays`, the "Due this week"
 * tile: today and the next six days), LATER, or RETIRED. `overdueDays` counts the days past its day (0 otherwise).
 */
export function dueStateOf(schedule: DueFacts, today: BusinessDate, withinDays: number = SCHEDULE_LIMITS.dueWithinDays): { readonly state: DueState; readonly overdueDays: number; readonly inDays: number } {
  const inDays = daysFrom(today, schedule.nextDueOn)
  if (!schedule.active) return { state: 'RETIRED', overdueDays: 0, inDays }
  if (inDays < 0) return { state: 'OVERDUE', overdueDays: -inDays, inDays }
  if (inDays === 0) return { state: 'DUE_TODAY', overdueDays: 0, inDays }
  if (inDays < withinDays) return { state: 'DUE_SOON', overdueDays: 0, inDays }
  return { state: 'LATER', overdueDays: 0, inDays }
}

/** Due this week: overdue, due today or within the next six days (the design's tile). */
export const dueThisWeek = (schedule: DueFacts, today: BusinessDate): boolean => {
  const { state } = dueStateOf(schedule, today)
  return state === 'OVERDUE' || state === 'DUE_TODAY' || state === 'DUE_SOON'
}

/** The order of the Due counts list: most overdue first, then by day, then by name. */
export function dueOrder<Row extends DueFacts & { readonly name: string; readonly id: string }>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => (a.nextDueOn === b.nextDueOn ? (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1) : a.nextDueOn < b.nextDueOn ? -1 : 1))
}

/** A stock key a schedule or a count holds (one line of a count). */
export interface KeyFacts {
  readonly locationId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
}

export const keyOf = (key: KeyFacts): string => [key.locationId, key.itemId, key.itemColourId ?? '', key.lotId ?? '', key.hideId ?? ''].join('|')

/**
 * Whether a closed count counted what a schedule counts: every stock key the schedule's scope held at the count's snapshot is
 * a line of the count (so a count of a wider scope, a whole site or the year-end inventory, counts the schedule too, and a
 * count started by hand moves it as well as one started from its row). A scope that held nothing at the snapshot is counted
 * by a count whose own scope holds it (`scopeContains`).
 */
export function countCovers(scheduleKeys: readonly KeyFacts[], countLineKeys: readonly KeyFacts[], scopeContains: boolean): boolean {
  if (scheduleKeys.length === 0) return scopeContains
  const lines = new Set(countLineKeys.map(keyOf))
  return scheduleKeys.every((key) => lines.has(keyOf(key)))
}

export const SCOPE_WORDS = {
  location: { en: (code: string) => `Location ${code} and everything inside it`, it: (code: string) => `Ubicazione ${code} e tutto ciò che contiene` },
  abcClass: { en: (abc: AbcClass) => `Class ${abc} materials`, it: (abc: AbcClass) => `Materiali di classe ${abc}` },
  itemKind: { en: (kind: string) => `${kind.charAt(0)}${kind.slice(1).toLowerCase()}`, it: (kind: string) => `${kind.charAt(0)}${kind.slice(1).toLowerCase()}` },
} as const

/** The schedule's scope in words ("Location A1-LEA and everything inside it · Class A materials"). */
export function scopeWords(scope: ScheduleScope & { readonly locationCode: string | null }, language: 'en' | 'it'): string {
  const parts: string[] = []
  if (scope.locationId && scope.locationCode) parts.push(SCOPE_WORDS.location[language](scope.locationCode))
  if (scope.abcClass) parts.push(SCOPE_WORDS.abcClass[language](scope.abcClass))
  if (scope.itemKind) parts.push(SCOPE_WORDS.itemKind[language](scope.itemKind))
  return parts.join(' · ')
}
