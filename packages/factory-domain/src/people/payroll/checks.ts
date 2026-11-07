import { monthLabel } from '../../accounting/periods'

/**
 * The checks before a payroll export (B-W2b-54; MES-272; design people.payroll "1 · Period and company", "2 · Checks"): nothing
 * reaches the consultant broken. Pure: the API counts, this decides and says it.
 *
 *   blocking   the month not closed, people with no employee code, days not approved, anomalies open, production days not
 *              closed, the pay period not locked (when piece pay is on in the month), codes the file needs and nobody
 *              mapped, a value too long for a fixed-width column
 *   warnings   agency and external people left out (MES-211), leavers flagged (MES-214), people who should be on the file
 *              and are not, a provider layout nobody confirmed
 *
 * A layout that prints only our own codes needs no mapping: there the unmapped codes are a warning, so the generic file works
 * with any consultant from day one (MES-270). A layout that prints the provider's code cannot go with a blank one.
 */

export const PAYROLL_CHECKS = ['MONTH_CLOSED', 'EMPLOYEE_CODES', 'DAYS_APPROVED', 'ANOMALIES_CLEARED', 'PRODUCTION_DAYS', 'PAY_PERIOD_LOCKED', 'CODES_MAPPED', 'LAYOUT_FITS', 'AGENCY_LEFT_OUT', 'LEAVERS', 'NOT_ON_FILE', 'LAYOUT_NOT_CONFIRMED'] as const
export type PayrollCheckCode = (typeof PAYROLL_CHECKS)[number]

/** Where "Show me" goes: the page that fixes it. */
export const CHECK_PLACES = ['ATTENDANCE', 'EMPLOYEES', 'PRODUCTION_LABOUR', 'PIECE_RATES', 'CODE_MAPPING', 'LAYOUTS'] as const
export type CheckPlace = (typeof CHECK_PLACES)[number]

const PLACES: Readonly<Record<PayrollCheckCode, CheckPlace>> = Object.freeze({
  MONTH_CLOSED: 'ATTENDANCE',
  EMPLOYEE_CODES: 'EMPLOYEES',
  DAYS_APPROVED: 'ATTENDANCE',
  ANOMALIES_CLEARED: 'ATTENDANCE',
  PRODUCTION_DAYS: 'PRODUCTION_LABOUR',
  PAY_PERIOD_LOCKED: 'PIECE_RATES',
  CODES_MAPPED: 'CODE_MAPPING',
  LAYOUT_FITS: 'LAYOUTS',
  AGENCY_LEFT_OUT: 'EMPLOYEES',
  LEAVERS: 'EMPLOYEES',
  NOT_ON_FILE: 'EMPLOYEES',
  LAYOUT_NOT_CONFIRMED: 'LAYOUTS',
})

/** Where a check's "Show me" goes. */
export const placeOfCheck = (code: PayrollCheckCode): CheckPlace => PLACES[code]

/** Checks whose "Show me" lists people: names only with people.payroll.records, each opening recorded. */
export const PEOPLE_CHECKS: readonly PayrollCheckCode[] = Object.freeze(['EMPLOYEE_CODES', 'AGENCY_LEFT_OUT', 'LEAVERS', 'NOT_ON_FILE'])

export interface CheckFacts {
  readonly month: string
  readonly closed: boolean
  readonly noEmployeeCode: number
  readonly daysOpen: number
  readonly anomaliesOpen: number
  readonly lineDaysOpen: number
  /** Piece pay reaches the month: a site's switch window, or earnings booked in its period. */
  readonly piecePayOn: boolean
  /** The status of the month's pay period; null: there is none. */
  readonly payPeriodStatus: string | null
  /** Codes the file carries with no provider code. */
  readonly unmapped: number
  /** The layout prints the provider's code (or no layout is chosen yet). */
  readonly printsProviderCode: boolean
  /** Values too long for their fixed-width column. */
  readonly overflowing: number
  /** Agency and external people with days or earnings in the month. */
  readonly leftOut: number
  /** People on the file whose last working day falls in or before this month. */
  readonly leavers: number
  /** Active employees of the company in the month with no day and no earnings. */
  readonly notOnFile: number
  /** The provider layout chosen is not confirmed by the consultant yet. */
  readonly layoutNotConfirmed: boolean
}

export interface PayrollCheck {
  readonly code: PayrollCheckCode
  readonly blocking: boolean
  readonly passed: boolean
  readonly count: number
  readonly words: string
  readonly place: CheckPlace
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** Every check of the month, blocking ones first, in the design's order. */
export function payrollChecks(facts: CheckFacts): PayrollCheck[] {
  const label = monthLabel(facts.month)
  const periodLocked = !facts.piecePayOn || facts.payPeriodStatus === 'LOCKED'
  const check = (code: PayrollCheckCode, blocking: boolean, count: number, done: string, left: string): PayrollCheck => ({ code, blocking, passed: count === 0, count, words: count === 0 ? done : left, place: PLACES[code] })
  return [
    check('MONTH_CLOSED', true, facts.closed ? 0 : 1, `${label} is closed.`, `${label} is not closed: close it in Attendance first.`),
    check('EMPLOYEE_CODES', true, facts.noEmployeeCode, 'Every person has an employee code.', `${plural(facts.noEmployeeCode, 'person has', 'people have')} no employee code.`),
    check('DAYS_APPROVED', true, facts.daysOpen, 'Every day is approved.', `${plural(facts.daysOpen, 'day is', 'days are')} not approved.`),
    check('ANOMALIES_CLEARED', true, facts.anomaliesOpen, 'No anomaly is open.', `${plural(facts.anomaliesOpen, 'anomaly is', 'anomalies are')} still open.`),
    check('PRODUCTION_DAYS', true, facts.lineDaysOpen, 'Production days are closed.', `${plural(facts.lineDaysOpen, 'line day is', 'line days are')} not closed in Production › Labour.`),
    check('PAY_PERIOD_LOCKED', true, periodLocked ? 0 : 1, facts.piecePayOn ? 'The pay period is locked.' : 'Piece pay is not on in this month.', facts.payPeriodStatus === null ? `Piece pay is on in ${label} and it has no pay period yet.` : `The pay period of ${label} is not locked.`),
    check(
      'CODES_MAPPED',
      facts.printsProviderCode,
      facts.unmapped,
      'Every code the file needs is mapped.',
      facts.printsProviderCode ? `${plural(facts.unmapped, 'code has', 'codes have')} no provider code.` : `${plural(facts.unmapped, 'code has', 'codes have')} no provider code. This layout prints our own codes, so it can go.`,
    ),
    check('LAYOUT_FITS', true, facts.overflowing, 'Every value fits its column.', `${plural(facts.overflowing, 'value does', 'values do')} not fit a column of this layout.`),
    check('AGENCY_LEFT_OUT', false, facts.leftOut, 'Nobody is left out.', `${plural(facts.leftOut, 'agency or external person is', 'agency or external people are')} left out: their employer pays them.`),
    check('LEAVERS', false, facts.leavers, 'No leaver this month.', `${plural(facts.leavers, 'leaver is', 'leavers are')} flagged on this file.`),
    check('NOT_ON_FILE', false, facts.notOnFile, 'Every active employee is on the file.', `${plural(facts.notOnFile, 'active employee has', 'active employees have')} no day and no earnings this month, so ${facts.notOnFile === 1 ? 'is' : 'are'} not on the file.`),
    check('LAYOUT_NOT_CONFIRMED', false, facts.layoutNotConfirmed ? 1 : 0, 'The layout is confirmed.', 'The provider layout is not confirmed by the labour consultant yet.'),
  ]
}

export const blockingLeft = (checks: readonly PayrollCheck[]): PayrollCheck[] => checks.filter((check) => check.blocking && !check.passed)

/** Stored on the export: the checks as they stood (what it carried is PayrollExport.correctionsCarried, B-W2b-89). */
export function storedChecks(checks: readonly PayrollCheck[]): unknown[] {
  return checks.map(({ code, blocking, passed, count, words }) => ({ code, blocking, passed, count, words }))
}

export interface StoredCheck {
  readonly code: PayrollCheckCode
  readonly blocking: boolean
  readonly passed: boolean
  readonly count: number
  readonly words: string
}

const isCheck = (code: unknown): code is PayrollCheckCode => (PAYROLL_CHECKS as readonly unknown[]).includes(code)

/** The checks as stored (a code this version does not know left out). */
export function parseChecks(stored: unknown): StoredCheck[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((entry): StoredCheck[] => {
    const row = entry as { code?: unknown; blocking?: unknown; passed?: unknown; count?: unknown; words?: unknown } | null
    return row && isCheck(row.code) ? [{ code: row.code, blocking: row.blocking === true, passed: row.passed === true, count: typeof row.count === 'number' ? row.count : 0, words: typeof row.words === 'string' ? row.words : '' }] : []
  })
}
