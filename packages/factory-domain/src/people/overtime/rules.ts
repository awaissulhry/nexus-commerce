import type { BusinessDate } from '../../core/time'

/**
 * Overtime worked (B-W2b-42; MES-229 "Overtime calculation and approval"; D.Lgs. 66/2003 art. 5; design people.attendance
 * "Overtime to approve": overtime is paid only after approval), pure. B-W2b-37's attendance day says how much overtime a
 * day has (the time beyond the roster, in whole units); here it becomes one OvertimeEntry per class:
 *
 *   HOLIDAY   worked on a day planned off (a rest day or a day the calendar closes): all of that day's overtime
 *   NIGHT     the overtime worked between 22:00 and 06:00 (D.Lgs. 66/2003 art. 1)
 *   DAY       the rest
 *
 * An entry is born PENDING and is recomputed while it is. Only a person decides it (never the system, never on their own
 * overtime, and only on a day that is approved: its figures no longer move). When a reopened day changes the figures, a
 * decision no longer matches what was worked, so it is taken back and the entry waits for a person again: it is never
 * paid on figures nobody saw. Planned overtime that nobody worked makes no entry; overtime nobody planned makes one, and
 * says so.
 */

export const OVERTIME_CLASSES = ['DAY', 'NIGHT', 'HOLIDAY'] as const
export type OvertimeClass = (typeof OVERTIME_CLASSES)[number]

export const ENTRY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const
export type EntryStatus = (typeof ENTRY_STATUSES)[number]

export const ENTRY_CHANGES = ['COMPUTED', 'REMOVED', 'TAKEN_BACK', 'APPROVED', 'REJECTED', 'REOPENED'] as const
export type EntryChange = (typeof ENTRY_CHANGES)[number]

export const OVERTIME_RULES = Object.freeze({ listLimit: 200, reasonMin: 3, reasonMax: 500 })

/** A day's overtime figures. */
export interface DayOvertime {
  readonly overtimeMinutes: number
  /** Of them, worked at night (B-W2b-37 `computeDay`). */
  readonly nightOvertimeMinutes: number
  /** Above 0: the day was planned off. */
  readonly holidayMinutes: number
}

/** A day's overtime by class (what the entries should say). */
export function overtimeSplit(day: DayOvertime): Readonly<Record<OvertimeClass, number>> {
  const total = Math.max(0, day.overtimeMinutes)
  if (day.holidayMinutes > 0) return { DAY: 0, NIGHT: 0, HOLIDAY: total }
  const night = Math.min(total, Math.max(0, day.nightOvertimeMinutes))
  return { DAY: total - night, NIGHT: night, HOLIDAY: 0 }
}

/** An entry as it stands. */
export interface StoredEntry {
  readonly id: string
  readonly kind: OvertimeClass
  readonly minutes: number
  readonly requestId: string | null
  readonly status: EntryStatus
}

export interface EntryPlan {
  readonly create: readonly { readonly kind: OvertimeClass; readonly minutes: number }[]
  /** PENDING entries whose figures (or planned request) changed. */
  readonly update: readonly { readonly id: string; readonly kind: OvertimeClass; readonly minutes: number }[]
  /** PENDING entries with nothing left to approve. */
  readonly remove: readonly string[]
  /** Decided entries that no longer match what was worked: the decision is taken back first, then they update or go. */
  readonly takeBack: readonly { readonly id: string; readonly kind: OvertimeClass; readonly minutes: number }[]
}

/** What the entries of a day need so they say `wanted` (read first: nothing to do writes nothing). */
export function planEntries(stored: readonly StoredEntry[], wanted: Readonly<Record<OvertimeClass, number>>, requestId: string | null): EntryPlan {
  const create: { kind: OvertimeClass; minutes: number }[] = []
  const update: { id: string; kind: OvertimeClass; minutes: number }[] = []
  const remove: string[] = []
  const takeBack: { id: string; kind: OvertimeClass; minutes: number }[] = []
  for (const kind of OVERTIME_CLASSES) {
    const minutes = wanted[kind]
    const entry = stored.find((row) => row.kind === kind)
    if (!entry) {
      if (minutes > 0) create.push({ kind, minutes })
    } else if (entry.status === 'PENDING') {
      if (minutes === 0) remove.push(entry.id)
      else if (minutes !== entry.minutes || requestId !== entry.requestId) update.push({ id: entry.id, kind, minutes })
    } else if (minutes !== entry.minutes) {
      takeBack.push({ id: entry.id, kind, minutes })
    }
  }
  return { create, update, remove, takeBack }
}

export const hasWork = (plan: EntryPlan): boolean => plan.create.length + plan.update.length + plan.remove.length + plan.takeBack.length > 0

/** Why overtime cannot be decided now. */
export const ENTRY_HOLDS = ['NOT_PENDING', 'DAY_NOT_APPROVED', 'OWN_OVERTIME', 'MONTH_CLOSED'] as const
export type EntryHold = (typeof ENTRY_HOLDS)[number]

export const ENTRY_HOLD_WORDS: Readonly<Record<EntryHold, string>> = Object.freeze({
  NOT_PENDING: 'This overtime has been decided already: take the decision back first.',
  DAY_NOT_APPROVED: 'Approve the attendance day first: its figures can still change.',
  OWN_OVERTIME: 'Nobody decides about their own overtime: another person does (D.Lgs. 152/1997 art. 1-bis).',
  MONTH_CLOSED: 'This month is closed: it changes only by a correction.',
})

export interface EntryFacts {
  readonly status: EntryStatus
  /** The attendance day's status; null: no day (it cannot be approved). */
  readonly dayStatus: string | null
  readonly own: boolean
  readonly monthClosed: boolean
}

/** What holds approving an entry. */
export function entryHolds(facts: EntryFacts): EntryHold[] {
  const holds: EntryHold[] = []
  if (facts.status !== 'PENDING') holds.push('NOT_PENDING')
  if (facts.monthClosed) holds.push('MONTH_CLOSED')
  // CLOSED: the close under way moved the day on; it cannot finish while overtime waits (the database's rule).
  else if (facts.dayStatus !== 'APPROVED' && facts.dayStatus !== 'CLOSED') holds.push('DAY_NOT_APPROVED')
  if (facts.own) holds.push('OWN_OVERTIME')
  return holds
}

/** A reason a person types: not blank, within the limits. */
export function overtimeReasonProblems(reason: string, path: string): { readonly path: string; readonly message: string }[] {
  const text = reason.trim()
  if (text.length < OVERTIME_RULES.reasonMin) return [{ path, message: 'Say why, in a few words.' }]
  if (text.length > OVERTIME_RULES.reasonMax) return [{ path, message: `Keep it to ${OVERTIME_RULES.reasonMax} characters.` }]
  return []
}

/** The year of a day (the yearly cap). */
export const yearOfDay = (date: BusinessDate): string => date.slice(0, 4)
