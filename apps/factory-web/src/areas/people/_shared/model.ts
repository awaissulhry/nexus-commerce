import { EMPLOYEE_REFUSALS } from '@nexus/factory-domain/people/employees/rules'
import { LEAVER_REFUSALS } from '@nexus/factory-domain/people/leavers/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { DataProblem, Employee, EmployeeKind, EmployeeRows, EmployeeTile, Lifecycle, LeaverStep, StepPlace } from './api'

/**
 * The pure rules of People › Employees (B-W2b-55): what this person may do (from the session's permissions; the API
 * checks each again), the list's address (tiles, rows, search, view, dialogs) and the API's own filters, the data notice
 * one at a time, the words of the API's refusals by code, and the small text rules (weekly minutes as hours, CSV). No
 * per-person figure: a name is shown in the HR register and inside one record, never as a filter, a group or a total.
 */

export type Words = { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }
export const TIME_ZONE = 'Europe/Rome'
/** J / K on the record: the order of the list last read (session storage only). */
export const ORDER_KEY = 'people.employees.order'

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface PeopleCan {
  /** people.view: the HR register of the sites in reach. */
  view: boolean
  /** people.team.view: My team (a lead's or member's own teams only). */
  team: boolean
  manageEmployees: boolean
  manageTeams: boolean
  manageLoans: boolean
  manageLeavers: boolean
  /** workers.manage: "Also create floor sign-in" (Admin › Users keeps the badge and PIN). */
  manageWorkers: boolean
  /** imports.run + files.upload: Import employees (imports.apply applies). */
  runImport: boolean
  applyImport: boolean
  /** people.skills.view: the loan's skill check. */
  skills: boolean
  /** sites.view / workorders.view: where the lines come from. */
  sites: boolean
  floorLines: boolean
  /** audit.read: the record's Activity. */
  audit: boolean
  /** parties.view: choose an agency. */
  parties: boolean
  /** users.view: "Manage sign-in" opens Admin › Users. */
  users: boolean
}

export function peopleCan(permissions: readonly string[]): PeopleCan {
  const held = new Set(permissions)
  return {
    view: held.has('people.view'),
    team: held.has('people.team.view'),
    manageEmployees: held.has('people.employees.manage'),
    manageTeams: held.has('people.teams.manage'),
    manageLoans: held.has('people.loans.manage'),
    manageLeavers: held.has('people.leavers.manage'),
    manageWorkers: held.has('workers.manage'),
    runImport: held.has('imports.run') && held.has('files.upload'),
    applyImport: held.has('imports.apply'),
    skills: held.has('people.skills.view'),
    sites: held.has('sites.view'),
    floorLines: held.has('workorders.view'),
    audit: held.has('audit.read'),
    parties: held.has('parties.view'),
    users: held.has('users.view') || held.has('workers.view'),
  }
}

// ---- the list's address ------------------------------------------------------------------------------------------------------

export const LIST_TILES = ['ACTIVE', 'STARTING', 'LEAVING', 'AGENCY_ENDING', 'UNLINKED_WORKERS'] as const satisfies readonly EmployeeTile[]
/** Rows ▾: everyone active (default), my team, agency, leaving, missing data, left, all. */
export const ROW_CHOICES = ['ACTIVE', 'MY_TEAM', 'AGENCY', 'LEAVING', 'MISSING_DATA', 'LEFT', 'ALL'] as const
export type RowChoice = (typeof ROW_CHOICES)[number]
export const VIEWS = ['people', 'teams'] as const
export type PeopleView = (typeof VIEWS)[number]

export interface EmployeesAddress {
  tile: EmployeeTile | null
  rows: RowChoice
  q: string
  view: PeopleView
  /** ?new=1 (`c`, the palette's New employee). */
  isNew: boolean
  /** ?import=1 (the band's Import). */
  isImport: boolean
  /** ?line=<id>: the Teams view on one line (a loan row's link). */
  lineId: string | null
}

const oneOf = <T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T => ((values as readonly string[]).includes(value ?? '') ? (value as T) : fallback)

export function employeesAddressOf(params: URLSearchParams | null): EmployeesAddress {
  const tile = params?.get('tile') ?? null
  return {
    tile: (LIST_TILES as readonly string[]).includes(tile ?? '') ? (tile as EmployeeTile) : null,
    rows: oneOf(ROW_CHOICES, params?.get('rows'), 'ACTIVE'),
    q: params?.get('q')?.slice(0, 80) ?? '',
    view: oneOf(VIEWS, params?.get('view'), 'people'),
    isNew: params?.get('new') === '1',
    isImport: params?.get('import') === '1',
    lineId: params?.get('line') || null,
  }
}

/** The address terms of a list state (defaults left out, so a saved view stays short). Other terms (`mode`, `print`) are kept. */
export function employeesAddressText(address: EmployeesAddress, keep?: URLSearchParams | null): string {
  const terms = new URLSearchParams()
  for (const [name, value] of keep?.entries() ?? []) if (!['tile', 'rows', 'q', 'view', 'new', 'import', 'line'].includes(name)) terms.set(name, value)
  if (address.view !== 'people') terms.set('view', address.view)
  if (address.tile) terms.set('tile', address.tile)
  if (address.rows !== 'ACTIVE') terms.set('rows', address.rows)
  if (address.q.trim()) terms.set('q', address.q.trim())
  if (address.lineId) terms.set('line', address.lineId)
  if (address.isNew) terms.set('new', '1')
  if (address.isImport) terms.set('import', '1')
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** The API's own filters for the list (a tile wins over Rows ▾; My team asks for the person's own team). */
export function employeesQuery(address: Pick<EmployeesAddress, 'tile' | 'rows' | 'q'>, myTeamId: string | null): { tile?: Exclude<EmployeeTile, 'UNLINKED_WORKERS'>; rows?: EmployeeRows; teamId?: string; q?: string } {
  const q = address.q.trim() ? { q: address.q.trim() } : {}
  if (address.tile && address.tile !== 'UNLINKED_WORKERS') return { tile: address.tile, ...q }
  if (address.rows === 'MY_TEAM') return myTeamId ? { teamId: myTeamId, ...q } : { ...q }
  if (address.rows === 'ACTIVE') return { ...q }
  return { rows: address.rows, ...q }
}

/** The list is narrowed (a tile, a row choice or a search): an empty answer says "nothing matches", not "add your people". */
export const isFiltered = (address: Pick<EmployeesAddress, 'tile' | 'rows' | 'q'>): boolean => address.tile !== null || address.rows !== 'ACTIVE' || address.q.trim() !== ''

// ---- the data notice ---------------------------------------------------------------------------------------------------------

/** A dismissal is kept by value: the same problem with another count comes back. */
export const noticeKey = (problem: DataProblem): string => `${problem.code}:${problem.count}`

/** The notice shown now (the most serious not dismissed) and how many more wait behind it. */
export function currentNotice(problems: readonly DataProblem[], dismissed: readonly string[], skip = 0): { problem: DataProblem; more: number } | null {
  const open = problems.filter((problem) => problem.count > 0 && !dismissed.includes(noticeKey(problem)))
  if (open.length === 0) return null
  const index = ((skip % open.length) + open.length) % open.length
  return { problem: open[index]!, more: open.length - 1 }
}

// ---- words of API answers ----------------------------------------------------------------------------------------------------

/** Every people refusal the screens say in words (`refusal/<CODE>`). */
export const PEOPLE_REFUSALS = [
  ...EMPLOYEE_REFUSALS,
  ...LEAVER_REFUSALS,
  'TEAM_ARCHIVED',
  'TEAM_NOT_EMPTY',
  'TEAM_OTHER_SITE',
  'TEAM_OTHER_LINE',
  'NOT_MEMBER',
  'MOVES_REFUSED',
  'LOAN_OVERLAP',
  'LOAN_BEGUN',
  'LOAN_NOT_BEGUN',
  'LOAN_ENDED',
  'LINE_ARCHIVED',
] as const
export type PeopleRefusal = (typeof PEOPLE_REFUSALS)[number]

export function refusalOf(error: unknown): PeopleRefusal | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((PEOPLE_REFUSALS as readonly string[]).includes(code)) return code as PeopleRefusal
  }
  return null
}

/** The body field a refusal or a 400 names (`body/<field>`), or null. */
export function fieldOf(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!/^body[./]/.test(path)) continue
    const field = path.replace(/^body[./]/, '').split(/[./]/)[0]
    if (field) return field
  }
  return null
}

/** Fields whose 400 the screens word at the field. */
const FIELD_PROBLEMS = new Set(['firstName', 'lastName', 'displayName', 'employeeCode', 'locale', 'startDate', 'endDate', 'agencyPartyId', 'weeklyMinutes', 'department', 'jobRole', 'homeLineId', 'reason', 'lastWorkingDay', 'startsAt', 'endsAt', 'toLineId', 'code', 'name'])

/** The words of a failed call: a refusal by its code, a field's problem, else the kind of failure. */
export function problemOf(error: unknown): Words {
  const refusal = refusalOf(error)
  if (refusal) return { key: `refusal.${refusal}` }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  if (error.kind === 'invalid') {
    const field = fieldOf(error)
    if (field && FIELD_PROBLEMS.has(field)) return { key: `problem.field.${field}` }
    return { key: 'problem.invalid' }
  }
  switch (error.kind) {
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'forbidden':
      return { key: 'problem.forbidden' }
    case 'step_up':
      return { key: 'problem.stepUp' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    default:
      return { key: 'problem.unavailable' }
  }
}

/** A failed read in one message key (a list, a record). */
export const readProblem = (error: unknown): string => (isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : 'problem.unavailable')

// ---- small text rules --------------------------------------------------------------------------------------------------------

export const LIFECYCLE_TONE: Readonly<Record<Lifecycle, 'success' | 'info' | 'warning' | 'neutral'>> = { STARTING: 'info', ACTIVE: 'success', LEAVING: 'warning', LEFT: 'neutral' }
export const KIND_TONE: Readonly<Record<EmployeeKind, 'neutral' | 'info' | 'warning'>> = { EMPLOYEE: 'neutral', AGENCY: 'info', EXTERNAL: 'warning' }

/** Weekly minutes as hours a week ("37.5" in English, "37,5" in Italian); null when not set. */
export function hoursText(minutes: number | null, locale: string): string | null {
  if (minutes === null) return null
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(minutes / 60)
}

/** Hours a week as typed ("37,5" or "37.5") → whole minutes, or null (blank), or undefined (not a number). */
export function minutesOfHours(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.')
  if (!value) return null
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value)) return undefined
  return Math.round(Number(value) * 60)
}

/** The days from `today` to `day` (both YYYY-MM-DD); negative when past. */
export function daysUntil(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** Today in the site's zone (YYYY-MM-DD). */
export const todayIn = (timeZone: string = TIME_ZONE, now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/**
 * A wall-clock time on a calendar day in the site's zone as a UTC instant (the loan's "until 18:00"): the zone's offset at
 * that moment, found by asking Intl what the guess reads as.
 */
export function zonedInstant(day: string, time: string, timeZone: string = TIME_ZONE): string {
  const [hours, minutes] = time.split(':').map(Number)
  const guess = new Date(`${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).map((part) => [part.type, part.value]))
  const read = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
  return new Date(guess.getTime() - (read - guess.getTime())).toISOString()
}

/** Where a leaver step is done: an address in the Office, or null (done here, or in a later wave's page). */
export function stepHref(prefix: string, step: Pick<LeaverStep, 'place'>, record: { userId: string | null; workerIds: readonly string[] }): string | null {
  const places: Partial<Record<StepPlace, string | null>> = {
    FLOOR_SIGN_IN: record.workerIds[0] ? `${prefix}/admin/users/floor/${encodeURIComponent(record.workerIds[0])}` : `${prefix}/admin/users`,
    OFFICE_ACCOUNT: record.userId ? `${prefix}/admin/users/${encodeURIComponent(record.userId)}` : `${prefix}/admin/users`,
    OPEN_WORK: `${prefix}/home/tasks`,
  }
  return places[step.place] ?? null
}

/** CSV with a header row; values quoted when they need it (`;` is the Italian spreadsheet's separator). */
export function csvText(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>, separator = ';'): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /["\n\r;,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [header, ...rows].map((row) => row.map(cell).join(separator)).join('\r\n')
}

/** The register's CSV columns: no pay, attendance, health or per-person work figure (none exists in the answer). */
export const CSV_COLUMNS = ['name', 'floorName', 'code', 'kind', 'company', 'site', 'department', 'homeLine', 'team', 'lead', 'role', 'contract', 'hours', 'start', 'end', 'language', 'badge', 'notice', 'status'] as const

export function csvRowOf(row: Employee, words: { kind: string; contract: string; badge: string; notice: string; status: string }, locale: string): Array<string | null> {
  return [
    row.name,
    row.displayName,
    row.employeeCode,
    words.kind,
    row.companyCode,
    row.site.code,
    row.department,
    row.homeLine?.code ?? null,
    row.team ? `${row.team.code} · ${row.team.name}` : null,
    row.lead?.name ?? null,
    row.jobRole,
    words.contract,
    hoursText(row.weeklyMinutes, locale),
    row.startDate,
    row.endDate,
    row.locale,
    words.badge,
    words.notice,
    words.status,
  ]
}

// ---- the record's Activity -----------------------------------------------------------------------------------------------------

/** The audit actions on an employee's record the Activity says in words (`activity.action.<name>`); another: "Other change". */
export const ACTIVITY_ACTIONS = [
  'createEmployee',
  'updateEmployee',
  'linkWorker',
  'unlinkWorker',
  'setAccount',
  'lendToLine',
  'endLoan',
  'removeLoan',
  'moveTeamMembers',
  'endMembership',
  'setTeamLead',
  'startLeaving',
  'cancelLeaving',
  'leaverStepTicked',
  'leaverClosed',
  'settleLeaver',
  'openPersonFigures',
  'addSkill',
  'setSkillLevel',
  'changeSkill',
  'removeSkillLevel',
  'signOffTrainee',
  'authoriseMachine',
  'changeMachineAuthorisation',
  'endMachineAuthorisation',
  'revokeMachineAuthorisation',
] as const

export function activityAction(action: string): string {
  const name = action.startsWith('people.') ? action.slice('people.'.length) : action
  return (ACTIVITY_ACTIONS as readonly string[]).includes(name) ? `activity.action.${name}` : 'activity.action.other'
}

/** The fields of the record a change is said by (`field.<name>`); ids and other keys are left out. */
export const ACTIVITY_FIELDS = ['firstName', 'lastName', 'displayName', 'employeeCode', 'kind', 'locale', 'startDate', 'endDate', 'department', 'jobRole', 'contract', 'weeklyMinutes', 'reason', 'lastWorkingDay', 'purpose'] as const

const shown = (value: unknown): string | null => (value === null || value === undefined ? null : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null)

/** What a change changed, field by field (before → after), for the fields the Activity says. */
export function activityChanges(before: unknown, after: unknown): Array<{ field: string; before: string | null; after: string | null }> {
  const a = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>
  const b = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>
  return ACTIVITY_FIELDS.flatMap((field) => {
    if (!(field in a) && !(field in b)) return []
    const was = shown(a[field])
    const now = shown(b[field])
    return was === now ? [] : [{ field, before: was, after: now }]
  })
}
