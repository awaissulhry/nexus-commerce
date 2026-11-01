import { clockText, isoWeekday } from '../../calendars/dates'
import { shiftsOf, weekdaysWithShifts, type Pattern } from '../../calendars/patterns'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The roster and planned overtime (B-W2b-32; MES-218, MES-222; design people.shifts), pure. The API (apps/factory-api
 * modules/people/shifts) reads the facts and writes the rows through command(); the …_time_w2b_guards triggers stay the
 * last word for every login.
 *
 *   cell        one person's day: a roster row (RosterEntry: a shift, or a day off) or, without one, the person's
 *               default shift. The shift's window is COPIED from a planning pattern (Planning › Settings owns the
 *               patterns: one owner, PLN-002) or typed by hand, so a later change of the pattern never rewrites a
 *               published roster. A night shift runs past 1440 minutes (22:00-06:00 is 1320-1800), at most 24 hours.
 *   default     the person's default pattern (Employee.defaultShiftPatternId), else the pattern the calendar of their
 *               home line or site works that day; a day the calendar closes (holiday, shutdown, outside the working
 *               week) is OFF; a weekday the pattern has no shift on is OFF; a pattern with several shifts that weekday
 *               (two shifts: morning and afternoon) gives no default: the roster says which one.
 *   publish     a new or changed cell is a DRAFT the workers do not see; publishing makes the cells of a range the roster
 *               the workers read. A published cell that is changed again stays published (the worker sees the change at
 *               once); clearing it returns the day to the default shift.
 *   overtime    a request for a date (and a line) asks some people; each answers (on their tablet, or by telling the
 *               lead, who records it); it is approved once somebody agreed, and only the people who said yes work it
 *               (D.Lgs. 66/2003 art. 5: overtime by agreement, never automatic). The answers change until it is approved.
 *
 * The roster is planning (who is planned on which shift), not attendance (what a person did): Statuto dei Lavoratori
 * art. 4 c.2 governs the tools that RECORD attendance (clock-in, attendance days), behind the site's ATTENDANCE gate.
 */

export const SHIFT_LIMITS = Object.freeze({
  /** The days a roster read, an assignment or a publication covers at most (a month view plus a week). */
  rangeDays: 42,
  /** Cells one autosave writes at most (a fill across days). */
  cells: 200,
  /** People one assignment names at most. */
  assignPeople: 200,
  /** People one roster read shows at most (narrow by line or team beyond it). */
  rosterPeople: 500,
  /** People one overtime request asks at most. */
  overtimePeople: 50,
  label: 60,
  note: 300,
  reason: 500,
  /** Overtime per person: 1 minute to 12 hours (the database's bound). */
  overtimeMinutes: { min: 1, max: 720 },
})

export const ROSTER_KINDS = ['WORK', 'OFF'] as const
export type RosterKind = (typeof ROSTER_KINDS)[number]
export const ROSTER_STATUSES = ['DRAFT', 'PUBLISHED'] as const
export type RosterStatus = (typeof ROSTER_STATUSES)[number]

/** Where a cell's value comes from: a roster row, the default shift, or nothing (no default, not employed that day). */
export const CELL_SOURCES = ['ROSTER', 'DEFAULT', 'NONE'] as const
export type CellSource = (typeof CELL_SOURCES)[number]

/** Why a cell has no value, or may not take a shift. */
export const CELL_ISSUES = ['NOT_EMPLOYED', 'AFTER_LAST_DAY', 'NO_DEFAULT', 'SEVERAL_SHIFTS'] as const
export type CellIssue = (typeof CELL_ISSUES)[number]

/** A shift's window: minutes from the date's midnight in the site's time zone, the unpaid break inside it. */
export interface ShiftWindow {
  readonly label: string | null
  readonly startMinute: number
  readonly endMinute: number
  readonly breakMinutes: number
}

/** What a cell holds: a shift (from a pattern, or typed), or a day off. */
export type CellValue = { readonly kind: 'WORK'; readonly shift: ShiftWindow; readonly patternId: string | null } | { readonly kind: 'OFF' }

/** A shift a cell can take: one shift of a planning pattern (a pattern with two shifts gives two choices). */
export interface ShiftChoice extends ShiftWindow {
  readonly patternId: string
  readonly patternCode: string
  readonly patternName: string
  /** The weekdays (ISO, 1 Monday … 7 Sunday) the pattern has this shift on. */
  readonly weekdays: readonly number[]
  /** The letter typed in a cell ("M" Morning, "A" Afternoon, "D" Day), when one letter names one choice; "O" is a day off. */
  readonly key: string | null
}

/** The letter typed for a day off. */
export const OFF_KEY = 'O'

const breaksOf = (shift: ReturnType<typeof shiftsOf>[number]): number => shift.breaks.reduce((sum, pause) => sum + pause.endMinute - pause.startMinute, 0)

/**
 * The shifts the patterns offer, each once: a pattern's shift is its label and window (with the breaks inside it) on the
 * weekdays it is on. A letter is given when one letter names one choice and is not the day off's.
 */
export function choicesOf(patterns: readonly Pattern[]): ShiftChoice[] {
  const out: Omit<ShiftChoice, 'key'>[] = []
  for (const pattern of patterns) {
    const seen = new Map<string, { choice: Omit<ShiftChoice, 'key'>; weekdays: number[] }>()
    for (const weekday of weekdaysWithShifts(pattern.segments)) {
      for (const shift of shiftsOf(pattern.segments, weekday)) {
        const key = `${shift.label ?? ''}|${shift.startMinute}|${shift.endMinute}|${breaksOf(shift)}`
        const found = seen.get(key)
        if (found) found.weekdays.push(weekday)
        else seen.set(key, { choice: { patternId: pattern.id, patternCode: pattern.code, patternName: pattern.name, label: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, breakMinutes: breaksOf(shift), weekdays: [] }, weekdays: [weekday] })
      }
    }
    for (const { choice, weekdays } of seen.values()) out.push({ ...choice, weekdays })
  }
  const letter = (choice: Omit<ShiftChoice, 'key'>): string | null => {
    const first = choice.label?.trim().charAt(0).toUpperCase() ?? ''
    return /^[A-Z]$/.test(first) && first !== OFF_KEY ? first : null
  }
  const counts = new Map<string, Set<string>>()
  for (const choice of out) {
    const key = letter(choice)
    if (key) counts.set(key, (counts.get(key) ?? new Set()).add(`${choice.label}|${choice.startMinute}|${choice.endMinute}`))
  }
  return out
    .map((choice) => {
      const key = letter(choice)
      return { ...choice, key: key && counts.get(key)!.size === 1 ? key : null }
    })
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.patternCode.localeCompare(b.patternCode))
}

/**
 * The shift a pattern gives a date for a label (and a window, when the pattern has that label twice): the weekday's own;
 * on a weekday the pattern has no such shift (an extra Saturday), the first weekday that has it. Null: the pattern has
 * no shift with that label (and window).
 */
export function shiftFromPattern(pattern: Pattern, date: BusinessDate, pick: { readonly label: string | null; readonly startMinute?: number | undefined }): ShiftWindow | null {
  const matches = (shift: ReturnType<typeof shiftsOf>[number]) => shift.label === pick.label && (pick.startMinute === undefined || shift.startMinute === pick.startMinute)
  const weekday = isoWeekday(date)
  const order = [weekday, ...weekdaysWithShifts(pattern.segments).filter((day) => day !== weekday)]
  for (const day of order) {
    const found = shiftsOf(pattern.segments, day).find(matches)
    if (found) return { label: found.label, startMinute: found.startMinute, endMinute: found.endMinute, breakMinutes: breaksOf(found) }
  }
  return null
}

/** What is wrong with a typed shift window (paths `label`, `startMinute`, `endMinute`, `breakMinutes`). */
export function windowProblems(window: ShiftWindow): Issue[] {
  const issues: Issue[] = []
  if (window.label !== null && (window.label.trim() === '' || window.label.length > SHIFT_LIMITS.label)) issues.push({ path: 'label', message: `A shift's name has 1 to ${SHIFT_LIMITS.label} characters, or none.` })
  if (!Number.isInteger(window.startMinute) || window.startMinute < 0 || window.startMinute > 1439) issues.push({ path: 'startMinute', message: 'A shift starts in its day: 0 (00:00) to 1439 (23:59).' })
  else if (!Number.isInteger(window.endMinute) || window.endMinute <= window.startMinute || window.endMinute - window.startMinute > 1440) {
    issues.push({ path: 'endMinute', message: 'It ends after it starts, at most 24 hours later (a night shift ends past 1440: 22:00-06:00 is 1320-1800).' })
  } else if (!Number.isInteger(window.breakMinutes) || window.breakMinutes < 0 || window.breakMinutes >= window.endMinute - window.startMinute) {
    issues.push({ path: 'breakMinutes', message: 'The break is 0 or more minutes and shorter than the shift.' })
  }
  return issues
}

/** The facts of one person's day that decide the default shift. */
export interface DefaultFacts {
  /** The person's own default pattern, else the pattern the calendar of their home line or site works that day. */
  readonly pattern: Pattern | null
  /** The calendar keeps the day open (not a holiday, a shutdown or outside the working week). */
  readonly open: boolean
}

export type DefaultCell = { readonly value: CellValue; readonly issue: null } | { readonly value: null; readonly issue: 'NO_DEFAULT' | 'SEVERAL_SHIFTS' }

/**
 * The default shift of a date: OFF when the calendar closes the day or the pattern has no shift that weekday; the one
 * shift of the weekday; none when there is no pattern, or the pattern has several shifts that weekday.
 */
export function defaultCellOf(date: BusinessDate, facts: DefaultFacts): DefaultCell {
  if (!facts.open) return { value: { kind: 'OFF' }, issue: null }
  if (!facts.pattern) return { value: null, issue: 'NO_DEFAULT' }
  const shifts = shiftsOf(facts.pattern.segments, isoWeekday(date))
  if (shifts.length === 0) return { value: { kind: 'OFF' }, issue: null }
  if (shifts.length > 1) return { value: null, issue: 'SEVERAL_SHIFTS' }
  const shift = shifts[0]!
  return { value: { kind: 'WORK', patternId: facts.pattern.id, shift: { label: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, breakMinutes: breaksOf(shift) } }, issue: null }
}

/** Two cell values say the same (the same window and break, or both a day off; the pattern it came from aside). */
export function sameCell(a: CellValue | null, b: CellValue | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'OFF' || b.kind === 'OFF') return true
  return a.shift.label === b.shift.label && a.shift.startMinute === b.shift.startMinute && a.shift.endMinute === b.shift.endMinute && a.shift.breakMinutes === b.shift.breakMinutes
}

/** One line for a cell: "Morning 06:00-14:00", "Off", "No shift". */
export function cellWords(value: CellValue | null): string {
  if (value === null) return 'No shift'
  if (value.kind === 'OFF') return 'Off'
  return `${value.shift.label ? `${value.shift.label} ` : ''}${clockText(value.shift.startMinute)}-${clockText(value.shift.endMinute)}`
}

/** The Monday of a date's ISO week. */
export const mondayOf = (date: BusinessDate): BusinessDate => {
  const weekday = isoWeekday(date)
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day - (weekday - 1))).toISOString().slice(0, 10)
}

// ---- overtime --------------------------------------------------------------------------------------------------------

export const OVERTIME_STATUSES = ['DRAFT', 'ASKED', 'AGREED', 'APPROVED', 'DONE', 'CANCELLED'] as const
export type OvertimeStatus = (typeof OVERTIME_STATUSES)[number]
export const OVERTIME_ANSWERS = ['PENDING', 'AGREED', 'DECLINED'] as const
export type OvertimeAnswer = (typeof OVERTIME_ANSWERS)[number]

/**
 * The stage a request shows: its status, with ASKED shown AGREED once somebody said yes. The stored status stays ASKED
 * until it is approved (then ASKED → AGREED → APPROVED in one command), so a worker may always take a yes back before
 * the approval, on the tablet too (the floor records its answer and nothing else).
 */
export function overtimeStageOf(status: OvertimeStatus, agreed: number): OvertimeStatus {
  return status === 'ASKED' && agreed > 0 ? 'AGREED' : status
}

export const OVERTIME_ACTIONS = ['EDIT', 'ASK', 'ADD_PEOPLE', 'REMOVE_PEOPLE', 'ANSWER', 'APPROVE', 'CANCEL'] as const
export type OvertimeAction = (typeof OVERTIME_ACTIONS)[number]

/** Why a request may not take an action now (in words), or null. */
export function overtimeActionRefusal(action: OvertimeAction, request: { readonly status: OvertimeStatus; readonly asked: number; readonly agreed: number }): string | null {
  const { status } = request
  if (status === 'DONE' || status === 'CANCELLED') return `This request is ${status === 'DONE' ? 'done' : 'cancelled'}: it no longer changes.`
  switch (action) {
    case 'EDIT':
      return status === 'DRAFT' ? null : 'The people were asked: what it asks no longer changes (cancel it and ask again).'
    case 'ASK':
      if (status !== 'DRAFT') return 'The people were asked already.'
      return request.asked === 0 ? 'Add the people to ask first.' : null
    case 'ADD_PEOPLE':
    case 'REMOVE_PEOPLE':
      return status === 'APPROVED' ? 'The request is approved: the people asked no longer change.' : null
    case 'ANSWER':
      return status === 'ASKED' || status === 'AGREED' ? null : status === 'DRAFT' ? 'The people are not asked yet.' : 'The request is approved: the answers no longer change.'
    case 'APPROVE':
      if (status === 'APPROVED') return 'The request is approved already.'
      if (status === 'DRAFT') return 'The people are not asked yet.'
      return request.agreed === 0 ? 'Nobody agreed yet: overtime is worked only by agreement (D.Lgs. 66/2003 art. 5).' : null
    case 'CANCEL':
      return null
  }
}

/** What is wrong with a request's plan (paths `minutes`, `startMinute`, `reason`). */
export function overtimePlanProblems(plan: { readonly minutes: number; readonly startMinute: number | null; readonly reason: string }): Issue[] {
  const issues: Issue[] = []
  if (!Number.isInteger(plan.minutes) || plan.minutes < SHIFT_LIMITS.overtimeMinutes.min || plan.minutes > SHIFT_LIMITS.overtimeMinutes.max) issues.push({ path: 'minutes', message: 'Overtime is 1 minute to 12 hours per person.' })
  if (plan.startMinute !== null && (!Number.isInteger(plan.startMinute) || plan.startMinute < 0 || plan.startMinute > 1439)) issues.push({ path: 'startMinute', message: 'It starts in its day: 0 (00:00) to 1439 (23:59).' })
  if (plan.reason.trim() === '') issues.push({ path: 'reason', message: 'Say why the overtime is needed.' })
  else if (plan.reason.length > SHIFT_LIMITS.reason) issues.push({ path: 'reason', message: `At most ${SHIFT_LIMITS.reason} characters.` })
  return issues
}
