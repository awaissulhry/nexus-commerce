import { lockPhrases, monthLabel, phraseMatches } from '../../accounting/periods'
import { daysFrom, plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { monthPeriod } from '../overtime/timesheets'

/**
 * The month close (B-W2b-48; MES-231; D.L. 112/2008 art. 39: the labour consultant keeps the Libro Unico del Lavoro, Nexus
 * gives the calendar of presence), pure.
 *
 *   the checklist   design people.attendance "Month close": all days approved, anomalies cleared, absence codes complete,
 *                   production days closed per line, manual entries reviewed; and overtime decided, which the database
 *                   asks too (…_time_w2b_guards) and the design's tiles call "what blocks the month close". Each item says
 *                   how many are left; the close is held while any is
 *   timesheets      NOT a condition (the design's checklist has none): a note, because a timesheet not approved by then stays
 *                   as it is for good (the database freezes a closed month's timesheets)
 *   the deadline    the LUL is filled by the end of the following month (art. 39 c.3)
 *   the phrase      Owner answer P1: the final month close is confirmed by a typed phrase, in either language
 *   corrections     a closed day never changes: a correction is a new entry, and a figure's value is the closed one
 *                   replaced by its latest correction (per kind and absence code). The sealed calendar stays what it was
 */

export const CLOSE_ITEMS = ['DAYS_APPROVED', 'ANOMALIES_CLEARED', 'ABSENCE_CODES', 'PRODUCTION_DAYS', 'MANUAL_REVIEWED', 'OVERTIME_DECIDED'] as const
export type CloseItem = (typeof CLOSE_ITEMS)[number]

export const CLOSE_HOLDS = ['ALREADY_CLOSED', 'MONTH_NOT_OVER', 'NO_DAYS', 'GATE_OFF', ...CLOSE_ITEMS] as const
export type CloseHold = (typeof CLOSE_HOLDS)[number]

export const CLOSE_NOTES = ['TIMESHEETS_NOT_APPROVED', 'CODES_WITHOUT_LUL', 'AGENCY_WORKERS'] as const
export type CloseNote = (typeof CLOSE_NOTES)[number]

/** What the close reads of a company's month. */
export interface MonthFacts {
  readonly month: string
  /** The earliest "today" of the company's sites (a month is over when it is over everywhere). */
  readonly today: BusinessDate
  readonly closed: boolean
  /** The company's attendance days of the month. */
  readonly days: number
  /** Still OPEN or NEEDS_FIX. */
  readonly daysOpen: number
  readonly anomaliesOpen: number
  /** A day of planned work with no presence and no absence code. */
  readonly absencesMissing: number
  /** Line days something happened on, not closed (Production › Labour). */
  readonly lineDaysOpen: number
  /** Days entered or fixed by hand that nobody has approved yet. */
  readonly manualOpen: number
  readonly overtimePending: number
  /** Sites holding days of the month whose ATTENDANCE gate is off. */
  readonly gateOffSites: number
  /** The month's timesheets not approved by HR. */
  readonly timesheetsOpen: number
  /** Absence codes used this month with no LUL code from the labour consultant yet. */
  readonly codesWithoutLul: number
  /** People on the calendar employed by an agency or external. */
  readonly notEmployees: number
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

const ITEM_LEFT: Readonly<Record<CloseItem, (facts: MonthFacts) => number>> = Object.freeze({
  DAYS_APPROVED: (facts) => facts.daysOpen,
  ANOMALIES_CLEARED: (facts) => facts.anomaliesOpen,
  ABSENCE_CODES: (facts) => facts.absencesMissing,
  PRODUCTION_DAYS: (facts) => facts.lineDaysOpen,
  MANUAL_REVIEWED: (facts) => facts.manualOpen,
  OVERTIME_DECIDED: (facts) => facts.overtimePending,
})

const ITEM_WORDS: Readonly<Record<CloseItem, { readonly done: string; readonly left: (count: number) => string }>> = Object.freeze({
  DAYS_APPROVED: { done: 'All days approved.', left: (count) => `${plural(count, 'day', 'days')} left to approve.` },
  ANOMALIES_CLEARED: { done: 'Anomalies cleared.', left: (count) => `${plural(count, 'anomaly', 'anomalies')} still open.` },
  ABSENCE_CODES: { done: 'Absence codes complete.', left: (count) => `${plural(count, 'day', 'days')} with nobody clocked in and no absence code.` },
  PRODUCTION_DAYS: { done: 'Production days closed on every line.', left: (count) => `${plural(count, 'line day', 'line days')} still to close in Production › Labour.` },
  MANUAL_REVIEWED: { done: 'Manual entries reviewed.', left: (count) => `${plural(count, 'day', 'days')} entered or fixed by hand not reviewed yet.` },
  OVERTIME_DECIDED: { done: 'Overtime decided.', left: (count) => `${plural(count, 'overtime entry', 'overtime entries')} waiting for a decision (overtime is paid only once approved).` },
})

export interface ChecklistItem {
  readonly item: CloseItem
  readonly left: number
  readonly done: boolean
  readonly words: string
}

/** The checklist, in the design's order. */
export function closeChecklist(facts: MonthFacts): ChecklistItem[] {
  return CLOSE_ITEMS.map((item) => {
    const left = ITEM_LEFT[item](facts)
    return { item, left, done: left === 0, words: left === 0 ? ITEM_WORDS[item].done : ITEM_WORDS[item].left(left) }
  })
}

const monthEnd = (month: string): BusinessDate => monthPeriod(month)?.periodEnd ?? `${month}-28`

/** The month's last day has passed. */
export const monthOver = (month: string, today: BusinessDate): boolean => monthEnd(month) < today

/** What holds the close, in the order the words read best: nothing here means it can close. */
export function closeHolds(facts: MonthFacts): CloseHold[] {
  if (facts.closed) return ['ALREADY_CLOSED']
  const holds: CloseHold[] = []
  if (!monthOver(facts.month, facts.today)) holds.push('MONTH_NOT_OVER')
  if (facts.days === 0) holds.push('NO_DAYS')
  if (facts.gateOffSites > 0) holds.push('GATE_OFF')
  for (const item of closeChecklist(facts)) if (!item.done) holds.push(item.item)
  return holds
}

/** A hold in words. */
export function holdWords(hold: CloseHold, facts: MonthFacts): string {
  switch (hold) {
    case 'ALREADY_CLOSED':
      return 'This month is closed already: it changes only by a correction.'
    case 'MONTH_NOT_OVER':
      return `${monthLabel(facts.month)} is not over yet: it closes from the day after its last day.`
    case 'NO_DAYS':
      return `There is no attendance day in ${monthLabel(facts.month)}: there is nothing to close.`
    case 'GATE_OFF':
      return `${plural(facts.gateOffSites, 'site holds', 'sites hold')} attendance days of this month with attendance switched off (Statuto dei Lavoratori art. 4 c.2): switch it on again in Admin › Privacy, or it cannot close.`
    default:
      return closeChecklist(facts).find((entry) => entry.item === hold)!.words
  }
}

/** What the person should know before closing: never a hold. */
export function closeNotes(facts: MonthFacts): { readonly note: CloseNote; readonly words: string }[] {
  const notes: { note: CloseNote; words: string }[] = []
  if (facts.timesheetsOpen > 0) notes.push({ note: 'TIMESHEETS_NOT_APPROVED', words: `${plural(facts.timesheetsOpen, 'timesheet is', 'timesheets are')} not approved by HR. The month can close; after that they stay as they are.` })
  if (facts.codesWithoutLul > 0) notes.push({ note: 'CODES_WITHOUT_LUL', words: `${plural(facts.codesWithoutLul, 'absence code', 'absence codes')} used this month ${facts.codesWithoutLul === 1 ? 'has' : 'have'} no LUL code yet: the calendar prints our own code until the labour consultant gives theirs.` })
  if (facts.notEmployees > 0) notes.push({ note: 'AGENCY_WORKERS', words: `${plural(facts.notEmployees, 'person', 'people')} on the calendar ${facts.notEmployees === 1 ? 'is' : 'are'} not employed by this company (an agency or external): marked on it, for the labour consultant to judge.` })
  return notes
}

/** The month after this one. */
export function nextMonth(month: string): string {
  return plusDays(monthEnd(month), 1).slice(0, 7)
}

/** The last day to fill the LUL for this month: the end of the following month (D.L. 112/2008 art. 39 c.3). */
export function lulDueBy(month: string): BusinessDate {
  return monthEnd(nextMonth(month))
}

export const lulDaysLeft = (month: string, today: BusinessDate): number => daysFrom(today, lulDueBy(month))

/** "close October 2026" / "chiudi ottobre 2026": the same phrase as a month closed for good in accounting (Owner answer P1). */
export const closePhrases = lockPhrases
export const closePhraseMatches = phraseMatches

/** What the typed confirmation says happens. */
export const CLOSE_CONSEQUENCES = 'The days lock. A change after the close is a correction with its reason, and goes in a correction export.'

export const CORRECT_WORDS = "A closed day never changes: this entry stands beside it, with its reason, and reaches the payroll's correction export. The sealed LUL calendar stays as it was."

/** How long our copy of the calendar is kept at least (five years from the last entry; the LUL itself is the consultant's). */
export const LUL_RETENTION_YEARS = 5

// ---- corrections -----------------------------------------------------------------------------------------------------

export const CORRECTION_KINDS = ['PRESENT', 'ORDINARY', 'NIGHT', 'HOLIDAY', 'OVERTIME_DAY', 'OVERTIME_NIGHT', 'OVERTIME_HOLIDAY', 'ABSENCE'] as const
export type CorrectionKind = (typeof CORRECTION_KINDS)[number]

export const CORRECTION_RULES = Object.freeze({ reasonMin: 3, reasonMax: 500, minutesMax: 1440 })

export interface CorrectionDraft {
  readonly kind: CorrectionKind
  readonly absenceCodeId: string | null
  readonly minutesAfter: number
  readonly reason: string
}

/** The draft's problems (paths without `body/`). */
export function correctionProblems(draft: CorrectionDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.kind === 'ABSENCE' && draft.absenceCodeId === null) problems.push({ path: 'absenceCodeId', message: 'Name the absence code whose minutes change.' })
  if (draft.kind !== 'ABSENCE' && draft.absenceCodeId !== null) problems.push({ path: 'absenceCodeId', message: 'An absence code goes only with a correction of an absence.' })
  if (!Number.isInteger(draft.minutesAfter) || draft.minutesAfter < 0 || draft.minutesAfter > CORRECTION_RULES.minutesMax) problems.push({ path: 'minutesAfter', message: `Give the new figure in whole minutes, 0 to ${CORRECTION_RULES.minutesMax}.` })
  const reason = draft.reason.trim()
  if (reason.length < CORRECTION_RULES.reasonMin) problems.push({ path: 'reason', message: 'Say why this closed day is corrected.' })
  if (reason.length > CORRECTION_RULES.reasonMax) problems.push({ path: 'reason', message: `Keep the reason to ${CORRECTION_RULES.reasonMax} characters.` })
  return problems
}

/** One person's day as closed, in minutes: the day's columns, the APPROVED overtime by class, the absences by code id. */
export interface DayCells {
  readonly present: number
  readonly ordinary: number
  readonly night: number
  readonly holiday: number
  readonly overtimeDay: number
  readonly overtimeNight: number
  readonly overtimeHoliday: number
  readonly absences: ReadonlyMap<string, number>
}

export const NO_CELLS: DayCells = Object.freeze({ present: 0, ordinary: 0, night: 0, holiday: 0, overtimeDay: 0, overtimeNight: 0, overtimeHoliday: 0, absences: new Map<string, number>() })

/** A correction as these rules read it. */
export interface CorrectionFact {
  readonly id: string
  readonly kind: CorrectionKind
  readonly absenceCodeId: string | null
  readonly minutesAfter: number
  readonly createdAt: Date
}

const CELL_OF = {
  PRESENT: 'present',
  ORDINARY: 'ordinary',
  NIGHT: 'night',
  HOLIDAY: 'holiday',
  OVERTIME_DAY: 'overtimeDay',
  OVERTIME_NIGHT: 'overtimeNight',
  OVERTIME_HOLIDAY: 'overtimeHoliday',
} as const satisfies Record<Exclude<CorrectionKind, 'ABSENCE'>, keyof Omit<DayCells, 'absences'>>

/** The figure a kind (and absence code) has in these cells. */
export function cellOf(cells: DayCells, kind: CorrectionKind, absenceCodeId: string | null): number {
  return kind === 'ABSENCE' ? (cells.absences.get(absenceCodeId ?? '') ?? 0) : cells[CELL_OF[kind]]
}

const cellKey = (entry: Pick<CorrectionFact, 'kind' | 'absenceCodeId'>): string => `${entry.kind}|${entry.absenceCodeId ?? ''}`

/** Per kind and code, the latest correction: by creation time, then id (as the database's chain reads it). */
export function latestCorrections(corrections: readonly CorrectionFact[]): CorrectionFact[] {
  const latest = new Map<string, CorrectionFact>()
  for (const entry of corrections) {
    const seen = latest.get(cellKey(entry))
    if (!seen || entry.createdAt > seen.createdAt || (entry.createdAt.getTime() === seen.createdAt.getTime() && entry.id > seen.id)) latest.set(cellKey(entry), entry)
  }
  return [...latest.values()]
}

/**
 * The figures of a closed day as they stand: each replaced by its latest correction (B-W2b-54's correction export and the
 * attendance report read this one rule).
 */
export function effectiveCells(cells: DayCells, corrections: readonly CorrectionFact[]): DayCells {
  const absences = new Map(cells.absences)
  const out: { -readonly [K in keyof Omit<DayCells, 'absences'>]: number } = { present: cells.present, ordinary: cells.ordinary, night: cells.night, holiday: cells.holiday, overtimeDay: cells.overtimeDay, overtimeNight: cells.overtimeNight, overtimeHoliday: cells.overtimeHoliday }
  for (const entry of latestCorrections(corrections)) {
    if (entry.kind === 'ABSENCE') absences.set(entry.absenceCodeId ?? '', entry.minutesAfter)
    else out[CELL_OF[entry.kind]] = entry.minutesAfter
  }
  return { ...out, absences }
}

export interface CellDifference {
  readonly kind: CorrectionKind
  readonly absenceCodeId: string | null
  readonly closedMinutes: number
  readonly nowMinutes: number
}

/** The cells that no longer say what the closed calendar says (a figure corrected and put back is no difference). */
export function differingCells(cells: DayCells, corrections: readonly CorrectionFact[]): CellDifference[] {
  return latestCorrections(corrections).flatMap((entry) => {
    const closedMinutes = cellOf(cells, entry.kind, entry.absenceCodeId)
    return closedMinutes === entry.minutesAfter ? [] : [{ kind: entry.kind, absenceCodeId: entry.absenceCodeId, closedMinutes, nowMinutes: entry.minutesAfter }]
  })
}
