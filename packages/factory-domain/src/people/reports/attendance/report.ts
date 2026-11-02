import { Dec } from '../../../tax/decimal'
import { DEFAULT_MINIMUM_GROUP, groupShown } from '../../privacy/groups'
import type { DayCells } from '../../close/rules'

/**
 * The attendance report and attendance against production (B-W2b-48; MES-303, MES-236; design people.reports "Attendance
 * report", people.attendance "Scan minutes · Gap"), pure. Never a person in a list (Owner answer W1): a group's sums, a group
 * under the company's minimum size emptied (ANA-075), and one person's month opens one record at a time. Minutes are whole
 * for attendance; production minutes are decimal strings from the labour records (never a float in a figure that is stored).
 */

export const REPORT_GROUPS = ['line', 'team'] as const
export type ReportGroup = (typeof REPORT_GROUPS)[number]

export const REPORT_WORDS = {
  groups: "The report shows lines and teams: one person's month opens one record at a time (Statuto dei Lavoratori art. 4).",
  open: 'This month is not closed: its figures can still change, and overtime counts once it is approved.',
  production: 'Attended minutes are the people of the line that month (a running loan counts on the line lent to). Production minutes are the standard minutes earned on the line. The gap is neither of them: time nobody coded.',
} as const

export interface GroupSum {
  ordinaryMinutes: number
  presentMinutes: number
  nightMinutes: number
  holidayMinutes: number
  overtimeDayMinutes: number
  overtimeNightMinutes: number
  overtimeHolidayMinutes: number
  absenceMinutes: number
  readonly absences: Map<string, number>
}

export const emptySum = (): GroupSum => ({ ordinaryMinutes: 0, presentMinutes: 0, nightMinutes: 0, holidayMinutes: 0, overtimeDayMinutes: 0, overtimeNightMinutes: 0, overtimeHolidayMinutes: 0, absenceMinutes: 0, absences: new Map() })

/** Adds one person's day to a sum. */
export function addCells(sum: GroupSum, cells: DayCells): GroupSum {
  sum.ordinaryMinutes += cells.ordinary
  sum.presentMinutes += cells.present
  sum.nightMinutes += cells.night
  sum.holidayMinutes += cells.holiday
  sum.overtimeDayMinutes += cells.overtimeDay
  sum.overtimeNightMinutes += cells.overtimeNight
  sum.overtimeHolidayMinutes += cells.overtimeHoliday
  for (const [codeId, minutes] of cells.absences) {
    sum.absenceMinutes += minutes
    sum.absences.set(codeId, (sum.absences.get(codeId) ?? 0) + minutes)
  }
  return sum
}

/**
 * The sum of the whole selection may show: nothing is hidden, or what is hidden is itself a group of the minimum size or
 * more. Otherwise the sum less the groups shown would give away the hidden group.
 */
export function summaryShown(hiddenPeople: number, people: number, minimum: number = DEFAULT_MINIMUM_GROUP): boolean {
  return groupShown(people, minimum) && (hiddenPeople === 0 || groupShown(hiddenPeople, minimum))
}

export const MATCH_STATES = ['NOT_CLOSED', 'NOT_SEALED', 'MATCHES', 'DIFFERS'] as const
export type MatchState = (typeof MATCH_STATES)[number]

/** "Matches the closed LUL for October" or "Differs in 2 cells". */
export function matchOf(input: { readonly closed: boolean; readonly sealed: boolean; readonly differing: number; readonly monthWords: string }): { readonly state: MatchState; readonly cells: number; readonly words: string } {
  if (!input.closed) return { state: 'NOT_CLOSED', cells: 0, words: `${input.monthWords} is not closed yet: there is no LUL calendar to match.` }
  if (!input.sealed) return { state: 'NOT_SEALED', cells: input.differing, words: `${input.monthWords} is closed, but its LUL calendar is not sealed yet.` }
  if (input.differing === 0) return { state: 'MATCHES', cells: 0, words: `Matches the closed LUL for ${input.monthWords}.` }
  return { state: 'DIFFERS', cells: input.differing, words: `Differs in ${input.differing} ${input.differing === 1 ? 'cell' : 'cells'} from the closed LUL for ${input.monthWords}: corrections made after the close.` }
}

/** Attended less production and coded off-standard time, three decimals; a negative gap is shown as it is. */
export function gapMinutes(attended: number, production: string, offStandard: number): string {
  return new Dec(attended).minus(new Dec(production)).minus(offStandard).toFixed(3)
}

/** Production as a share of attended time, percent with one decimal; null with no attended time. */
export function coveredPct(attended: number, production: string): string | null {
  return attended > 0 ? new Dec(production).times(100).dividedBy(attended).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : null
}
