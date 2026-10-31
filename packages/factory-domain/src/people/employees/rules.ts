import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * The employee record (B-W2b-26; MES-208, MES-211; design people.employees SCR-084 / SCR-085). Pure: the API
 * (apps/factory-api modules/people/employees) reads the facts in its command and writes the rows; the
 * …_people_w2b_guards triggers stay the last word for every login.
 *
 *   one person, one record   an Employee is made new, from a floor worker (Worker.employeeId: their floor sign-in, one
 *                            per site) or from an office user (Employee.userId: one account per person). Never two
 *                            records for one person: a worker already linked, or an account that already has its
 *                            record, is refused with the record it belongs to.
 *   what it keeps            a name, the name shown on the floor, the payroll's employee code (matricola), a type
 *                            (EMPLOYEE, AGENCY with its agency and contract end, EXTERNAL), a company and site, a home
 *                            line, a department and a role (mansione), a contract (full or part time, weekly minutes),
 *                            a default shift, a language, start and end dates. Nothing else (GDPR art. 5(1)(c); the
 *                            record's "What we do not keep": no address, tax code, IBAN, date of birth, photo, health
 *                            data or biometrics: the payroll provider and the company doctor keep them).
 *   lifecycle                STARTING (active, the start ahead), ACTIVE, LEAVING (an open leaver case), LEFT (the case
 *                            closed: set by the leaver steps, never by hand).
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): nothing here is a figure about one person's work; a name is
 * shown in the HR register and inside one record, never as a filter, a group or a total.
 */

export const EMPLOYEE_KINDS = ['EMPLOYEE', 'AGENCY', 'EXTERNAL'] as const
export type EmployeeKind = (typeof EMPLOYEE_KINDS)[number]
export const EMPLOYEE_CONTRACTS = ['FULL_TIME', 'PART_TIME'] as const
export type EmployeeContract = (typeof EMPLOYEE_CONTRACTS)[number]
export const EMPLOYEE_STATUSES = ['ACTIVE', 'LEFT'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]
export const LIFECYCLES = ['STARTING', 'ACTIVE', 'LEAVING', 'LEFT'] as const
export type Lifecycle = (typeof LIFECYCLES)[number]

/**
 * The list's tiles (design people.employees "Tiles": named saved filters for what needs HR now). UNLINKED_WORKERS
 * counts floor workers, not employees (its list is GET /people/employees/unlinked-workers).
 */
export const EMPLOYEE_TILES = ['ACTIVE', 'STARTING', 'LEAVING', 'AGENCY_ENDING', 'UNLINKED_WORKERS'] as const
export type EmployeeTile = (typeof EMPLOYEE_TILES)[number]
/** The toolbar's rows (design "Rows ▾"): agency workers, people leaving, records missing data (no employee code). */
export const EMPLOYEE_ROWS = ['AGENCY', 'LEAVING', 'MISSING_DATA', 'LEFT', 'ALL'] as const
export type EmployeeRows = (typeof EMPLOYEE_ROWS)[number]

export const EMPLOYEE_LIMITS = {
  name: 80,
  displayName: 40,
  code: 24,
  text: 80,
  reason: 500,
  weeklyMinutes: { min: 1, max: 4800 },
  /** "Starting in 14 days". */
  startingDays: 14,
  /** "Agency contracts ending in 30 days". */
  agencyEndingDays: 30,
} as const

/** A language code as the floor and the documents read it (`it`, `en`, `ro`, `fil`): the database's rule. */
export const LOCALE = /^[a-z]{2,3}$/
/** The payroll's employee code: letters, digits and . _ - /, no spaces (it is matched against the payroll file). */
export const EMPLOYEE_CODE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

/** The fields an employee record holds, as the rules read them (dates as YYYY-MM-DD). */
export interface EmployeeDraft {
  readonly firstName: string
  readonly lastName: string
  readonly displayName: string
  readonly employeeCode: string | null
  readonly kind: EmployeeKind
  readonly agencyPartyId: string | null
  readonly locale: string
  readonly startDate: BusinessDate
  readonly endDate: BusinessDate | null
  readonly department: string | null
  readonly jobRole: string | null
  readonly contract: EmployeeContract | null
  readonly weeklyMinutes: number | null
}

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

/**
 * What is wrong with an employee record as it would be stored (a new one, or the current one with a change merged in):
 * one issue per field, its path the field's name. The database refuses the same at the insert or update.
 */
export function employeeProblems(draft: EmployeeDraft): Issue[] {
  const problems: Issue[] = []
  const text = (field: keyof EmployeeDraft, value: string | null, max: number, required: boolean) => {
    if (blank(value)) {
      if (required) problems.push({ path: field, message: 'Required.' })
      return
    }
    if (value!.trim().length > max) problems.push({ path: field, message: `At most ${max} characters.` })
  }
  text('firstName', draft.firstName, EMPLOYEE_LIMITS.name, true)
  text('lastName', draft.lastName, EMPLOYEE_LIMITS.name, true)
  text('displayName', draft.displayName, EMPLOYEE_LIMITS.displayName, true)
  text('department', draft.department, EMPLOYEE_LIMITS.text, false)
  text('jobRole', draft.jobRole, EMPLOYEE_LIMITS.text, false)
  if (draft.employeeCode !== null) {
    if (draft.employeeCode.length > EMPLOYEE_LIMITS.code) problems.push({ path: 'employeeCode', message: `At most ${EMPLOYEE_LIMITS.code} characters.` })
    else if (!EMPLOYEE_CODE.test(draft.employeeCode)) problems.push({ path: 'employeeCode', message: 'Letters, digits and . _ - / only, no spaces: the code matches the payroll file.' })
  }
  if (!LOCALE.test(draft.locale)) problems.push({ path: 'locale', message: 'A language code of two or three small letters (it, en, ro).' })
  if (!isBusinessDate(draft.startDate)) problems.push({ path: 'startDate', message: 'A calendar day written YYYY-MM-DD.' })
  if (draft.endDate !== null && !isBusinessDate(draft.endDate)) problems.push({ path: 'endDate', message: 'A calendar day written YYYY-MM-DD.' })
  if (draft.kind === 'AGENCY') {
    if (draft.agencyPartyId === null) problems.push({ path: 'agencyPartyId', message: 'An agency worker names the agency that sends them.' })
    if (draft.endDate === null) problems.push({ path: 'endDate', message: "An agency worker's contract ends: give the end date." })
  } else if (draft.agencyPartyId !== null) {
    problems.push({ path: 'agencyPartyId', message: 'Only an agency worker names an agency.' })
  }
  if (draft.endDate !== null && isBusinessDate(draft.endDate) && isBusinessDate(draft.startDate) && draft.endDate < draft.startDate) {
    problems.push({ path: 'endDate', message: 'The end date is on or after the start date.' })
  }
  if (draft.weeklyMinutes !== null && (!Number.isInteger(draft.weeklyMinutes) || draft.weeklyMinutes < EMPLOYEE_LIMITS.weeklyMinutes.min || draft.weeklyMinutes > EMPLOYEE_LIMITS.weeklyMinutes.max)) {
    problems.push({ path: 'weeklyMinutes', message: `Whole minutes a week, from ${EMPLOYEE_LIMITS.weeklyMinutes.min} to ${EMPLOYEE_LIMITS.weeklyMinutes.max} (80 hours).` })
  }
  return problems
}

/** A name as typed: trimmed, inner runs of spaces made one. */
export const cleanName = (value: string): string => value.trim().replace(/\s+/g, ' ')

/** A text field as stored: trimmed, null when blank. */
export const cleanText = (value: string | null | undefined): string | null => (blank(value) ? null : value!.trim().replace(/\s+/g, ' '))

/** An employee code as stored: trimmed, null when blank (its case is kept: the payroll file's own). */
export const cleanCode = (value: string | null | undefined): string | null => (blank(value) ? null : value!.trim())

/** The name shown on the floor and the badge when none is given: the first name and the last name's initial. */
export function defaultDisplayName(firstName: string, lastName: string): string {
  const first = cleanName(firstName)
  const initial = cleanName(lastName).charAt(0)
  const name = initial ? `${first} ${initial}.` : first
  return name.slice(0, EMPLOYEE_LIMITS.displayName)
}

/**
 * The first and last name read from a floor worker's display name (the worker record keeps one name only): the first
 * word, then the rest. Null when it is one word (the caller must give the names).
 */
export function namesFromDisplayName(displayName: string): { readonly firstName: string; readonly lastName: string } | null {
  const words = cleanName(displayName).split(' ').filter((word) => word.length > 0)
  if (words.length < 2) return null
  return { firstName: words[0]!.slice(0, EMPLOYEE_LIMITS.name), lastName: words.slice(1).join(' ').slice(0, EMPLOYEE_LIMITS.name) }
}

/** The day `days` after a calendar day. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** The facts the lifecycle reads. */
export interface LifecycleFacts {
  readonly status: EmployeeStatus
  readonly startDate: BusinessDate
  /** An OPEN leaver case. */
  readonly leaving: boolean
}

/** The lifecycle pill (design "Lifecycle Pill"): STARTING · ACTIVE · LEAVING · LEFT. */
export function lifecycleOf(facts: LifecycleFacts, today: BusinessDate): Lifecycle {
  if (facts.status === 'LEFT') return 'LEFT'
  if (facts.leaving) return 'LEAVING'
  if (facts.startDate > today) return 'STARTING'
  return 'ACTIVE'
}

/** The facts the tiles read of one record. */
export interface TileFacts extends LifecycleFacts {
  readonly kind: EmployeeKind
  readonly endDate: BusinessDate | null
}

/** The tiles a record counts in (UNLINKED_WORKERS counts floor workers, never a record). */
export function tilesOf(facts: TileFacts, today: BusinessDate): EmployeeTile[] {
  if (facts.status === 'LEFT') return []
  const tiles: EmployeeTile[] = []
  const lifecycle = lifecycleOf(facts, today)
  if (lifecycle !== 'STARTING') tiles.push('ACTIVE')
  if (lifecycle === 'STARTING' && facts.startDate <= addDays(today, EMPLOYEE_LIMITS.startingDays)) tiles.push('STARTING')
  if (facts.leaving) tiles.push('LEAVING')
  if (facts.kind === 'AGENCY' && facts.endDate !== null && facts.endDate >= today && facts.endDate <= addDays(today, EMPLOYEE_LIMITS.agencyEndingDays)) tiles.push('AGENCY_ENDING')
  return tiles
}

/**
 * What the side panel says next, most urgent first (design "Next step in words"): each code has its words in the web.
 *   NOTICE_NOT_ACKNOWLEDGED   a floor sign-in of the person has not acknowledged the worker notice in force: their scans
 *                             are refused where the site names workers
 *   AGENCY_ENDING             an agency contract ends within 30 days (`days` left)
 *   LEAVING                   leaver steps are open (`days` to the last working day)
 *   NO_EMPLOYEE_CODE          no employee code: the payroll export holds the person
 *   STARTING                  the start date is ahead (`days` to it)
 */
export const NEXT_STEPS = ['NOTICE_NOT_ACKNOWLEDGED', 'AGENCY_ENDING', 'LEAVING', 'NO_EMPLOYEE_CODE', 'STARTING'] as const
export type NextStepCode = (typeof NEXT_STEPS)[number]

export interface NextStepFacts extends TileFacts {
  readonly employeeCode: string | null
  /** Linked floor sign-ins that have not acknowledged the notice in force. */
  readonly noticeMissing: number
  /** The open case's last working day. */
  readonly lastWorkingDay: BusinessDate | null
}

const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export function nextStepsOf(facts: NextStepFacts, today: BusinessDate): { readonly code: NextStepCode; readonly days: number | null }[] {
  if (facts.status === 'LEFT') return []
  const steps: { code: NextStepCode; days: number | null }[] = []
  if (facts.noticeMissing > 0) steps.push({ code: 'NOTICE_NOT_ACKNOWLEDGED', days: null })
  if (tilesOf(facts, today).includes('AGENCY_ENDING')) steps.push({ code: 'AGENCY_ENDING', days: daysBetween(today, facts.endDate!) })
  if (facts.leaving) steps.push({ code: 'LEAVING', days: facts.lastWorkingDay === null ? null : daysBetween(today, facts.lastWorkingDay) })
  if (facts.employeeCode === null && facts.kind !== 'AGENCY') steps.push({ code: 'NO_EMPLOYEE_CODE', days: null })
  if (facts.startDate > today) steps.push({ code: 'STARTING', days: daysBetween(today, facts.startDate) })
  return steps
}

/**
 * The refusals of the employee commands (a 409 whose issues are `refusal/<CODE>` and, when one field is at fault, that
 * field: the record shows the words at the field). The web has the words of each code; the API sends English ones too.
 */
export const EMPLOYEE_REFUSALS = [
  'CODE_TAKEN',
  'CODE_ON_WORKER',
  'WORKER_LINKED',
  'WORKER_OTHER_COMPANY',
  'WORKER_SITE_TAKEN',
  'WORKER_INACTIVE',
  'ACCOUNT_TAKEN',
  'ACCOUNT_DISAGREES',
  'ACCOUNT_INACTIVE',
  'SELF_LINK',
  'LEFT',
  'AGENCY_NOT_ORGANISATION',
  'LINE_NOT_OF_SITE',
  'SHIFT_NOT_OF_COMPANY',
  'SITE_ARCHIVED',
  'LEAVING',
  'LOAN_OPEN',
] as const
export type EmployeeRefusalCode = (typeof EMPLOYEE_REFUSALS)[number]
