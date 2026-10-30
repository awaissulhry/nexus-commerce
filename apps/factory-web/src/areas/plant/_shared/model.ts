import { JOB_MOVE_RULES, WAITING_MINUTES } from '@nexus/factory-domain/plant/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import type { JobMove, JobStatus, MachineAfter, MachineStatus, MaintenanceJob, MaintenanceRequest, Person, Priority, RequestStatus } from './api'

/**
 * The rules every Plant maintenance page shares (B-W2a-53; SCR-148 Machine requests, SCR-149 Maintenance jobs, SCR-150
 * Machines & tools), without React and without the API client: what a person may do (the permissions of factory-domain
 * plant/permissions; the cost grain for a machine's cost), the tones of each state, the words of a person (an office
 * user by name; a floor worker by name only inside one record; a station by its code), a plant refusal read from an
 * API error, the saved rows of each list and their address terms, and which job moves a person may make now.
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): no figure here is per person.
 */

export const TIME_ZONE = 'Europe/Rome'

// ---- what a person may do -------------------------------------------------------------------------------------------------

export const PLANT_PERMISSIONS = {
  view: 'plant.view',
  manageMachines: 'plant.machines.manage',
  report: 'plant.report',
  triage: 'plant.requests.triage',
  manageJobs: 'plant.jobs.manage',
  work: 'plant.jobs.work',
  signSafe: 'plant.signSafe',
  cost: 'money.cost',
  parties: 'parties.view',
  upload: 'files.upload',
  readFiles: 'files.read',
} as const

export type PlantAbility = keyof typeof PLANT_PERMISSIONS
export type PlantCan = Readonly<Record<PlantAbility, boolean>>

export function plantCan(permissions: readonly string[]): PlantCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(PLANT_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as PlantCan
}

// ---- states and tones -----------------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const MACHINE_TONE: Readonly<Record<MachineStatus, Tone>> = { RUNNING: 'success', DOWN: 'warning', UNDER_MAINTENANCE: 'info', DO_NOT_USE: 'danger', RETIRED: 'neutral' }
export const REQUEST_TONE: Readonly<Record<RequestStatus, Tone>> = { NEW: 'warning', ACKNOWLEDGED: 'info', JOB_MADE: 'success', MERGED: 'neutral', CLOSED: 'neutral' }
export const JOB_TONE: Readonly<Record<JobStatus, Tone>> = { NEW: 'warning', PLANNED: 'info', IN_PROGRESS: 'info', WAITING_PARTS: 'warning', HANDED_BACK: 'success', CLOSED: 'neutral', CANCELLED: 'neutral' }
export const PRIORITY_TONE: Readonly<Record<Priority, Tone>> = { P1: 'danger', P2: 'warning', P3: 'neutral' }

/** The age tone of a waiting request: over 30 minutes it waits too long (design "tone by escalation level"). */
export const ageTone = (request: Pick<MaintenanceRequest, 'ageMinutes' | 'status' | 'locking'>): Tone =>
  request.locking ? 'danger' : request.status === 'NEW' || request.status === 'ACKNOWLEDGED' ? (request.ageMinutes >= WAITING_MINUTES ? 'warning' : 'neutral') : 'neutral'

/** Minutes as the screens say them: "14 min", "3 h 05", "2 d" (the words come from the catalogue). */
export function ageWords(t: Translate, minutes: number): string {
  if (minutes < 60) return t('age.minutes', { count: Math.max(0, minutes) })
  if (minutes < 24 * 60) return t('age.hours', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') })
  return t('age.days', { count: Math.floor(minutes / (24 * 60)) })
}

// ---- words of the group's lists (classes and symptoms carry their own words) -------------------------------------------------

export interface Worded {
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string>>
}

/** A class's or symptom's words in the page's language. */
export const labelOf = (entry: Worded, locale: Locale): string => (locale === 'it' ? entry.labelIt : locale === 'en' ? entry.labelEn : (entry.labelI18n?.[locale] ?? entry.labelEn))

// ---- people ---------------------------------------------------------------------------------------------------------------

/**
 * Who a person view is, in words: an office user by name; a floor worker by name when the API gave it (only inside one
 * record, at a site that records workers), else "a floor worker"; a station by its code and name (the API's words:
 * "SEW-02 Sewing station 2"). Null: nobody.
 */
export function personWords(t: Translate, person: Person | null | undefined): string {
  if (!person) return t('person.nobody')
  if (person.kind === 'STATION') return person.name ?? t('person.aStation')
  if (person.kind === 'WORKER') return person.name ?? t('person.aWorker')
  return person.name ?? t('person.aColleague')
}

/** The assignee of a job in a list: an office user by name, a floor technician without a name (W1), or nobody. */
export function assigneeWords(t: Translate, job: Pick<MaintenanceJob, 'assignee' | 'ownership'>): string {
  if (!job.assignee) return t('person.nobody')
  if (job.ownership === 'MINE') return t('person.me')
  return personWords(t, job.assignee)
}

// ---- refusals and problems --------------------------------------------------------------------------------------------------

export const PLANT_REFUSAL_CODES = [
  'RETIRED',
  'CLASS_INACTIVE',
  'SYMPTOM_INACTIVE',
  'SYMPTOM_OTHER_CLASS',
  'DETAIL_NEEDED',
  'NO_REPORTER',
  'ALREADY_TRIAGED',
  'LOCKED_UNSAFE',
  'NOT_UNSAFE',
  'SIGNED_ALREADY',
  'MERGE_SELF',
  'MERGE_OTHER_MACHINE',
  'MERGE_TARGET_DONE',
  'JOB_OTHER_MACHINE',
  'JOB_DONE',
  'MOVE_NOT_ALLOWED',
  'NOT_YOUR_JOB',
  'OPEN_WORK',
] as const
export type RefusalCode = (typeof PLANT_REFUSAL_CODES)[number]

/** A message key and its params: the screens draw it in their language. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The plant refusal an API error carries (409, issues `refusal/<CODE>` and `fix`), or null. */
export function refusalOf(error: unknown): RefusalCode | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((PLANT_REFUSAL_CODES as readonly string[]).includes(code)) return code as RefusalCode
  }
  return null
}

/** The body field an API 400 names (`body/<field>` or `body.<field>`), or null. */
export function fieldOf(error: unknown): string | null {
  if (!isApiError(error) || error.kind !== 'invalid') return null
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/^body[./]/, '')
    if (path) return path.split(/[./]/)[0]!
  }
  return null
}

/** The words of a failed call (the plant catalogue): a refusal by its code, else the kind of failure. */
export function problemOf(error: unknown): Words {
  const refusal = refusalOf(error)
  if (refusal) return { key: `refusal.${refusal}` }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  if (error.kind === 'invalid') {
    const field = fieldOf(error)
    if (field && FIELD_PROBLEMS.has(field)) return { key: `problem.field.${field}` }
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
    case 'invalid':
      return { key: 'problem.invalid' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    case 'contract':
      return { key: 'problem.contract' }
    case 'unavailable':
      return { key: 'problem.unavailable' }
    default:
      return { key: 'problem.internal' }
  }
}

/** The fields whose 400 the screens say in their own words (the rest: "check what you typed"). */
const FIELD_PROBLEMS: ReadonlySet<string> = new Set(['assetNumber', 'assigneeId', 'assigneeWorkerId', 'machineId', 'stationId', 'workCentreId', 'supplierId', 'year', 'symptomId', 'jobs'])

/** A read that failed, as a message key (lists and records show it with Try again). */
export const readProblem = (error: unknown): string => problemOf(error).key

// ---- job moves ----------------------------------------------------------------------------------------------------------

/** The moves the office makes (plant.jobs.manage) and the ones a technician makes (plant.jobs.work). */
export const OFFICE_MOVES: ReadonlySet<JobMove> = new Set(['plan', 'close', 'cancel'])

/** Whether the job's state allows the move at all. */
export const moveAllowed = (move: JobMove, status: JobStatus): boolean => (JOB_MOVE_RULES[move].from as readonly string[]).includes(status)

/**
 * Why this person may not make the move on the job now (a message key), or null: no right (the office's moves need
 * plant.jobs.manage, the technician's plant.jobs.work), the state does not allow it, or the machine is still locked as
 * unsafe for a hand-back running (H1).
 */
export function moveHeld(move: JobMove, job: Pick<MaintenanceJob, 'status' | 'machine'>, can: Pick<PlantCan, 'manageJobs' | 'work'>, machineAfter?: MachineAfter): string | null {
  if (OFFICE_MOVES.has(move) ? !can.manageJobs : !can.work) return OFFICE_MOVES.has(move) ? 'held.noManageJobs' : 'held.noWork'
  if (!moveAllowed(move, job.status)) return `held.move.${move}`
  if (move === 'handBack' && machineAfter === 'RUNNING' && job.machine.locked) return 'held.lockedRunning'
  return null
}

/** The next step of a job shown as the record's primary action, by its state. */
export function nextMove(status: JobStatus): JobMove | null {
  switch (status) {
    case 'NEW':
      return 'start'
    case 'PLANNED':
      return 'start'
    case 'IN_PROGRESS':
      return 'handBack'
    case 'WAITING_PARTS':
      return 'start'
    case 'HANDED_BACK':
      return 'close'
    default:
      return null
  }
}

// ---- the jobs board (design plant.jobs "Board": New, Planned, In progress, Waiting parts, Hand-back, Closed) -----------------

export const BOARD_LANES = ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED'] as const satisfies readonly JobStatus[]
export type BoardLane = (typeof BOARD_LANES)[number]

/** The move a drop on a lane asks for, from the job's state; null when no move goes there. */
export function moveToLane(from: JobStatus, to: BoardLane): JobMove | null {
  if (from === to) return null
  switch (to) {
    case 'PLANNED':
      return from === 'NEW' ? 'plan' : null
    case 'IN_PROGRESS':
      return from === 'HANDED_BACK' ? 'reopen' : moveAllowed('start', from) ? 'start' : null
    case 'WAITING_PARTS':
      return from === 'IN_PROGRESS' ? 'wait' : null
    case 'HANDED_BACK':
      return from === 'IN_PROGRESS' ? 'handBack' : null
    case 'CLOSED':
      return from === 'HANDED_BACK' ? 'close' : null
    default:
      return null
  }
}

/** Why a card may not go to that lane (a message key), or null. */
export function laneHeld(job: Pick<MaintenanceJob, 'status' | 'machine'>, to: BoardLane, can: Pick<PlantCan, 'manageJobs' | 'work'>): string | null {
  const move = moveToLane(job.status, to)
  if (!move) return to === 'CLOSED' ? 'held.board.closedAfterHandBack' : to === 'NEW' ? 'held.board.notBackToNew' : `held.board.to.${to}`
  return moveHeld(move, job, can)
}

// ---- saved rows and the address ---------------------------------------------------------------------------------------------

export const REQUEST_VIEWS = ['open', 'unsafe', 'all', 'closed'] as const
export type RequestView = (typeof REQUEST_VIEWS)[number]

export const JOB_VIEWS = ['open', 'mine', 'overdue', 'unsafe', 'waiting', 'closedWeek', 'all', 'closed'] as const
export type JobView = (typeof JOB_VIEWS)[number]

export const MACHINE_VIEWS = ['inUse', 'down', 'doNotUse', 'underMaintenance', 'retired', 'all'] as const
export type MachineView = (typeof MACHINE_VIEWS)[number]

const pick = <T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T => (value && (list as readonly string[]).includes(value) ? (value as T) : fallback)

export interface ParamsLike {
  get(name: string): string | null
}

export interface RequestsAddress {
  view: RequestView
  /** A tile pressed (a saved filter of its own). */
  tile: 'NEW' | 'UNSAFE' | 'DOWN' | 'WAITING' | 'DUPLICATES' | null
  siteId: string | null
  /** The request open in its detail (`?open=`). */
  open: string | null
  /** The Report a problem dialog (`?report=1`), optionally for one machine (`?machine=`). */
  report: boolean
  machineId: string | null
}

const REQUEST_TILE_SET = ['NEW', 'UNSAFE', 'DOWN', 'WAITING', 'DUPLICATES'] as const

export function requestsAddressOf(params: ParamsLike | null): RequestsAddress {
  return {
    view: pick(REQUEST_VIEWS, params?.get('view'), 'open'),
    tile: (REQUEST_TILE_SET as readonly string[]).includes(params?.get('tile') ?? '') ? (params!.get('tile') as RequestsAddress['tile']) : null,
    siteId: params?.get('site') || null,
    open: params?.get('open') || null,
    report: params?.get('report') === '1',
    machineId: params?.get('machine') || null,
  }
}

export function requestsAddressText(address: RequestsAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.tile) query.set('tile', address.tile)
  if (address.siteId) query.set('site', address.siteId)
  if (address.open) query.set('open', address.open)
  if (address.report) query.set('report', '1')
  if (address.machineId) query.set('machine', address.machineId)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The API query of the requests list for a saved row or a tile (the queue: unsafe first, then the oldest). */
export function requestsQuery(address: Pick<RequestsAddress, 'view' | 'tile' | 'siteId'>): { open?: boolean; tile?: RequestsAddress['tile']; status?: RequestStatus[]; siteId: string | null } {
  if (address.tile) return { tile: address.tile, siteId: address.siteId }
  switch (address.view) {
    case 'unsafe':
      return { tile: 'UNSAFE', siteId: address.siteId }
    case 'all':
      return { siteId: address.siteId }
    case 'closed':
      return { status: ['JOB_MADE', 'MERGED', 'CLOSED'], siteId: address.siteId }
    default:
      return { open: true, siteId: address.siteId }
  }
}

export interface JobsAddress {
  view: JobView
  siteId: string | null
  machineId: string | null
  mode: 'list' | 'board'
  isNew: boolean
}

export function jobsAddressOf(params: ParamsLike | null): JobsAddress {
  return {
    view: pick(JOB_VIEWS, params?.get('view'), 'open'),
    siteId: params?.get('site') || null,
    machineId: params?.get('machine') || null,
    mode: params?.get('mode') === 'board' ? 'board' : 'list',
    isNew: params?.get('new') === '1',
  }
}

export function jobsAddressText(address: JobsAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.siteId) query.set('site', address.siteId)
  if (address.machineId) query.set('machine', address.machineId)
  if (address.mode === 'board') query.set('mode', 'board')
  if (address.isNew) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export function jobsQuery(address: Pick<JobsAddress, 'view' | 'siteId' | 'machineId'>): { open?: boolean; mine?: boolean; tile?: 'OPEN' | 'OVERDUE' | 'UNSAFE' | 'WAITING_PARTS' | 'CLOSED_THIS_WEEK'; status?: JobStatus[]; siteId: string | null; machineId: string | null } {
  const base = { siteId: address.siteId, machineId: address.machineId }
  switch (address.view) {
    case 'mine':
      return { ...base, open: true, mine: true }
    case 'overdue':
      return { ...base, tile: 'OVERDUE' }
    case 'unsafe':
      return { ...base, tile: 'UNSAFE' }
    case 'waiting':
      return { ...base, tile: 'WAITING_PARTS' }
    case 'closedWeek':
      return { ...base, tile: 'CLOSED_THIS_WEEK' }
    case 'closed':
      return { ...base, status: ['CLOSED', 'CANCELLED'] }
    case 'all':
      return base
    default:
      return { ...base, open: true }
  }
}

export interface MachinesAddress {
  view: MachineView
  q: string
  siteId: string | null
  classId: string | null
  isNew: boolean
}

export function machinesAddressOf(params: ParamsLike | null): MachinesAddress {
  return {
    view: pick(MACHINE_VIEWS, params?.get('view'), 'inUse'),
    q: params?.get('q') ?? '',
    siteId: params?.get('site') || null,
    classId: params?.get('class') || null,
    isNew: params?.get('new') === '1',
  }
}

export function machinesAddressText(address: MachinesAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'inUse') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.siteId) query.set('site', address.siteId)
  if (address.classId) query.set('class', address.classId)
  if (address.isNew) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export function machinesQuery(address: Pick<MachinesAddress, 'view' | 'q' | 'siteId' | 'classId'>): { tile?: 'DOWN' | 'DO_NOT_USE' | 'UNDER_MAINTENANCE'; status?: MachineStatus[]; q?: string; siteId: string | null; classId: string | null } {
  const base = { siteId: address.siteId, classId: address.classId, ...(address.q.trim().length > 0 ? { q: address.q.trim() } : {}) }
  switch (address.view) {
    case 'down':
      return { ...base, tile: 'DOWN' }
    case 'doNotUse':
      return { ...base, tile: 'DO_NOT_USE' }
    case 'underMaintenance':
      return { ...base, tile: 'UNDER_MAINTENANCE' }
    case 'retired':
      return { ...base, status: ['RETIRED'] }
    case 'all':
      return { ...base, status: ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'RETIRED'] }
    default:
      return base
  }
}

// ---- events the pages listen to ---------------------------------------------------------------------------------------------

export const isRequestEvent = (type: string): boolean => type.startsWith('maintenance_request.') || type === 'machine.status_changed'
export const isJobEvent = (type: string): boolean => type.startsWith('maintenance_job.') || type === 'machine.status_changed'
export const isMachineEvent = (type: string): boolean => type.startsWith('machine.') || type.startsWith('maintenance_job.') || type.startsWith('maintenance_request.')

// ---- small words ------------------------------------------------------------------------------------------------------------

/** The CSV of rows: every value quoted when it holds a separator, a quote or a line break; UTF-8 with its mark. */
export function csvText(header: readonly string[], lines: readonly (readonly (string | number | null | undefined)[])[]): string {
  const line = (values: readonly (string | number | null | undefined)[]) =>
    values
      .map((value) => {
        const text = value === null || value === undefined ? '' : String(value)
        return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      })
      .join(',')
  return [line(header), ...lines.map(line)].join('\r\n')
}

/** An amount in minor units as a decimal string for a CSV ("1234.50"). */
export const minorText = (minor: number | null | undefined): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2))

/** A date-time input's value (`YYYY-MM-DDTHH:mm`, the site's zone) → an ISO instant; '' → null. */
export function instantOf(local: string, timeZone: string = TIME_ZONE): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null
  const [date, time] = local.split('T') as [string, string]
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const offset = zoneOffsetMinutes(new Date(guess), timeZone)
  return new Date(guess - offset * 60_000).toISOString()
}

/** An ISO instant → the date-time input's value in the site's zone. */
export function localOf(instant: string | null | undefined, timeZone: string = TIME_ZONE): string {
  if (!instant) return ''
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/** A due time in words against the clock: "in 3 h 05", "overdue by 20 min"; null: no due time. */
export function dueWords(t: Translate, dueAt: string | null, now: string, done = false): string | null {
  if (!dueAt) return null
  const minutes = Math.round((new Date(dueAt).getTime() - new Date(now).getTime()) / 60_000)
  if (done) return null
  return minutes >= 0 ? t('due.in', { left: ageWords(t, minutes) }) : t('due.overdue', { late: ageWords(t, -minutes) })
}

/** The `USER:<id>` / `WORKER:<id>` picker value of a job's assignee ('' nobody). */
export function assigneeValue(job: Pick<MaintenanceJob, 'assignee'>): string {
  if (!job.assignee || !job.assignee.id) return ''
  if (job.assignee.kind === 'USER') return `USER:${job.assignee.id}`
  if (job.assignee.kind === 'WORKER') return `WORKER:${job.assignee.id}`
  return ''
}

/** A picker value → the API's two assignee fields (both null: nobody). */
export function assigneeFields(value: string): { assigneeId: string | null; assigneeWorkerId: string | null } {
  const [kind, id] = value.split(':') as [string, string | undefined]
  return { assigneeId: kind === 'USER' && id ? id : null, assigneeWorkerId: kind === 'WORKER' && id ? id : null }
}

// ---- a machine's fields as typed ---------------------------------------------------------------------------------------------

/**
 * A cost typed in the company's currency ("1.850,50", "1850.5", "1850") → minor units; '' → null; anything else →
 * undefined (the form says so). The last "," or "." with one or two digits after it is the decimal mark.
 */
export function costMinorOf(text: string): number | null | undefined {
  const value = text.trim().replace(/\s|€/g, '')
  if (value === '') return null
  const match = /^(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/.exec(value)
  if (!match) return undefined
  const whole = Number(match[1]!.replace(/[.,]/g, ''))
  const cents = match[2] ? Number(match[2].padEnd(2, '0')) : 0
  return whole * 100 + cents
}

/** Minor units → the text a cost field starts with ("1850,50" in Italian, "1850.50" in English). */
export const costTextOf = (minor: number | null | undefined, locale: Locale): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))

/** A year typed ("2019") → the number; '' → null; anything else → undefined. */
export function yearOf(text: string): number | null | undefined {
  const value = text.trim()
  if (value === '') return null
  if (!/^\d{4}$/.test(value)) return undefined
  const year = Number(value)
  return year >= 1900 && year <= 2100 ? year : undefined
}
