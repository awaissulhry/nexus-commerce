import { z } from 'zod'
import { LIMIT_KINDS, LIMIT_LEVELS } from '@nexus/factory-domain/people/shifts/limits'
import { CELL_ISSUES, CELL_SOURCES, OVERTIME_ANSWERS, OVERTIME_STATUSES, ROSTER_KINDS, ROSTER_STATUSES } from '@nexus/factory-domain/people/shifts/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › Shifts (B-W2b-60 on the API of B-W2b-32), with the answer's shape checked (zod; unknown fields
 * are dropped, so the API's English `words` never reach a screen: warnings are said from their rule and figures). A roster
 * names people inside the sheet; no figure about one person's work exists in any answer read here. Planned time only:
 * what a person did is Attendance's. Each write is one command with its own Idempotency-Key and the version the screen read.
 */

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>

// ---- the roster ------------------------------------------------------------------------------------------------------------

const shiftWindow = z.object({ label: z.string().nullable(), startMinute: z.number(), endMinute: z.number(), breakMinutes: z.number() })
export type ShiftWindow = z.infer<typeof shiftWindow>

const value = z.object({ kind: z.enum(ROSTER_KINDS), shift: shiftWindow.nullable(), patternId: z.string().nullable() })
export type RosterValue = z.infer<typeof value>

const warning = z.object({
  rule: z.enum(LIMIT_KINDS),
  level: z.enum(LIMIT_LEVELS),
  date: z.string(),
  law: z.string(),
  values: z.record(z.string(), z.union([z.number(), z.string()])),
  isNew: z.boolean(),
})
export type LimitWarning = z.infer<typeof warning>

const overtimeInCell = z.object({
  requestId: z.string(),
  agreementId: z.string(),
  startMinute: z.number().nullable(),
  minutes: z.number(),
  stage: z.enum(OVERTIME_STATUSES),
  answer: z.enum(OVERTIME_ANSWERS),
})
export type OvertimeInCell = z.infer<typeof overtimeInCell>

const cell = z.object({
  date: z.string(),
  source: z.enum(CELL_SOURCES),
  value: value.nullable(),
  issue: z.enum(CELL_ISSUES).nullable(),
  entry: z.object({ id: z.string(), status: z.enum(ROSTER_STATUSES), version: z.number(), note: z.string().nullable() }).nullable(),
  fallback: value.nullable(),
  open: z.boolean(),
  overtime: z.array(overtimeInCell),
  absence: z.object({ kind: z.enum(['HOLIDAY', 'PERMIT', 'ABSENT']), code: z.string().nullable(), minutes: z.number() }).nullable(),
  warnings: z.array(warning),
})
export type RosterCell = z.infer<typeof cell>

const day = z.object({ date: z.string(), weekday: z.number(), open: z.boolean(), reason: z.enum(['WEEK', 'DAY_OFF', 'HOLIDAY', 'CLOSURE', 'WORKING']), name: z.string().nullable() })
export type RosterDay = z.infer<typeof day>

const rule = z.object({
  kind: z.enum(LIMIT_KINDS),
  limitMinutes: z.number(),
  breakMinutes: z.number().nullable(),
  referenceMonths: z.number().nullable(),
  action: z.enum(LIMIT_LEVELS),
  source: z.enum(['LAW', 'CCNL', 'DEFAULT']),
  legalReference: z.string(),
  scope: z.enum(['SITE', 'COMPANY', 'TENANT', 'DEFAULT']),
})
export type RosterRule = z.infer<typeof rule>

const choice = z.object({
  patternId: z.string(),
  patternCode: z.string(),
  patternName: z.string(),
  label: z.string().nullable(),
  startMinute: z.number(),
  endMinute: z.number(),
  breakMinutes: z.number(),
  weekdays: z.array(z.number()),
  key: z.string().nullable(),
})
export type ShiftChoice = z.infer<typeof choice>

const row = z.object({
  employeeId: z.string(),
  name: z.string(),
  displayName: z.string(),
  site: ref,
  line: ref.nullable(),
  team: ref.nullable(),
  isLead: z.boolean(),
  defaultPattern: ref.nullable(),
  lastWorkingDay: z.string().nullable(),
  canEdit: z.boolean(),
  cells: z.array(cell),
})
export type RosterRow = z.infer<typeof row>

const footerDay = z.object({
  siteId: z.string(),
  lineId: z.string().nullable(),
  date: z.string(),
  shifts: z.array(z.object({ label: z.string().nullable(), startMinute: z.number(), endMinute: z.number(), people: z.number() })),
  off: z.number(),
  none: z.number(),
})
export type FooterDay = z.infer<typeof footerDay>

const roster = z.object({
  from: z.string(),
  to: z.string(),
  today: z.string(),
  sites: z.array(z.object({ site: ref, timeZone: z.string(), days: z.array(day), rules: z.array(rule), absences: z.object({ shown: z.boolean() }) })),
  choices: z.array(choice),
  rows: z.array(row),
  footer: z.array(footerDay),
  canEdit: z.enum(['ALL', 'TEAM', 'NONE']),
})
export type Roster = z.infer<typeof roster>

export interface RosterQuery {
  siteId?: string | null
  from: string
  to: string
  lineId?: string | null
  teamId?: string | null
}

export const readRoster = (api: ApiClient, query: RosterQuery) => api.get('/people/shifts/roster', { query: clean({ ...query }), schema: roster })

/** What a cell is set to: a day off, a shift of a planning pattern, or a shift typed by hand (a cell copied from one). */
export type ShiftSet =
  | { kind: 'OFF' }
  | { kind: 'WORK'; patternId: string; label: string | null; startMinute: number }
  | { kind: 'WORK'; patternId: null; label: string | null; startMinute: number; endMinute: number; breakMinutes: number }

export interface CellWrite {
  employeeId: string
  date: string
  /** The row's version when the cell had one; null when it showed the default. */
  version: number | null
  /** null: back to the default shift. */
  set: ShiftSet | null
}

const changedCell = z.object({ employeeId: z.string(), date: z.string(), cell })

export const writeCells = (api: ApiClient, cells: readonly CellWrite[], idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/people/shifts/roster/cells', { body: { cells }, schema: z.object({ cells: z.array(changedCell), warnings: z.number() }), idempotencyKey })

// ---- Assign, Copy last week, Publish ---------------------------------------------------------------------------------------

const change = z.object({ employeeId: z.string(), name: z.string(), date: z.string(), from: value.nullable(), fromSource: z.enum(CELL_SOURCES), to: value.nullable(), toSource: z.enum(CELL_SOURCES) })
export type PlanChange = z.infer<typeof change>

export const SKIP_REASONS = ['NOT_EMPLOYED', 'AFTER_LAST_DAY', 'CLOSED', 'ABSENT', 'NO_EDIT'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

const skipped = z.object({ employeeId: z.string(), name: z.string(), date: z.string(), why: z.enum(SKIP_REASONS) })
export type PlanSkipped = z.infer<typeof skipped>

const preview = z.object({
  changes: z.array(change),
  skipped: z.array(skipped),
  warnings: z.array(z.object({ employeeId: z.string(), name: z.string(), warning })),
  blocked: z.number(),
  people: z.number(),
  absences: z.object({ shown: z.boolean() }),
})
export type PlanPreview = z.infer<typeof preview>

const applied = z.object({ changed: z.number(), people: z.number(), skipped: z.number(), warnings: z.number() })

export interface AssignBody {
  employeeIds: readonly string[]
  from: string
  to: string
  weekdays?: readonly number[]
  set: ShiftSet | null
  skipClosedDays?: boolean
}

export const previewAssign = (api: ApiClient, body: AssignBody) => api.post('/people/shifts/roster/assign/preview', { body, schema: preview })
export const applyAssign = (api: ApiClient, body: AssignBody, idempotencyKey: string = newIdempotencyKey()) => api.post('/people/shifts/roster/assign', { body, schema: applied, idempotencyKey })

export interface CopyBody {
  siteId: string
  week: string
  lineId?: string
  teamId?: string
  employeeIds?: readonly string[]
}

export const previewCopy = (api: ApiClient, body: CopyBody) => api.post('/people/shifts/roster/copy-week/preview', { body, schema: preview })
export const applyCopy = (api: ApiClient, body: CopyBody, idempotencyKey: string = newIdempotencyKey()) => api.post('/people/shifts/roster/copy-week', { body, schema: applied, idempotencyKey })

export interface PublishBody {
  siteId: string
  from: string
  to: string
  lineId?: string
  teamId?: string
}

export const publishRoster = (api: ApiClient, body: PublishBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/people/shifts/roster/publish', { body, schema: z.object({ published: z.number(), people: z.number(), warnings: z.number() }), idempotencyKey })

/** The person's default shift (Employee › Job & team; B-W2b-26's one edit path, people.employees.manage). */
export const setDefaultShift = (api: ApiClient, employeeId: string, body: { version: number; defaultShiftPatternId: string | null }) =>
  api.request('PATCH', `/people/employees/${seg(employeeId)}`, { body, schema: z.object({}).passthrough(), idempotencyKey: newIdempotencyKey() })

// ---- overtime --------------------------------------------------------------------------------------------------------------

const request = z.object({
  id: z.string(),
  companyId: z.string(),
  site: ref,
  line: ref.nullable(),
  date: z.string(),
  startMinute: z.number().nullable(),
  minutes: z.number(),
  reason: z.string(),
  status: z.enum(OVERTIME_STATUSES),
  stage: z.enum(OVERTIME_STATUSES),
  counts: z.object({ asked: z.number(), agreed: z.number(), declined: z.number(), pending: z.number() }),
  askedAt: z.string().nullable(),
  askedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  doneAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string().nullable(),
  version: z.number(),
})
export type OvertimeRequest = z.infer<typeof request>

const listed = request.extend({ checks: z.object({ warn: z.number(), block: z.number() }) })
export type OvertimeListed = z.infer<typeof listed>

const person = z.object({
  agreementId: z.string(),
  employeeId: z.string(),
  name: z.string(),
  displayName: z.string(),
  answer: z.enum(OVERTIME_ANSWERS),
  answeredAt: z.string().nullable(),
  via: z.enum(['FLOOR', 'OFFICE']).nullable(),
  recordedBy: z.string().nullable(),
  version: z.number(),
  checks: z.array(warning),
})
export type OvertimePerson = z.infer<typeof person>

const record = z.object({ request, people: z.array(person), canManage: z.boolean(), canApprove: z.boolean(), today: z.string() })
export type OvertimeRecord = z.infer<typeof record>

export const listRequests = (api: ApiClient, query: { siteId?: string | null; lineId?: string | null; from?: string; to?: string }) =>
  api.get('/people/overtime-requests', { query: clean(query), schema: z.object({ requests: z.array(listed), today: z.string() }) })

export const requestRecord = (api: ApiClient, id: string) => api.get(`/people/overtime-requests/${seg(id)}`, { schema: record })

const checked = z.object({ employeeId: z.string(), name: z.string(), displayName: z.string(), checks: z.array(warning) })
export type CheckedPerson = z.infer<typeof checked>

export const checkOvertime = (api: ApiClient, body: { siteId: string; date: string; startMinute?: number | null; minutes: number; employeeIds: readonly string[] }) =>
  api.post('/people/overtime-requests/check', { body, schema: z.object({ people: z.array(checked) }) })

export interface NewRequest {
  siteId: string
  lineId: string | null
  date: string
  startMinute: number | null
  minutes: number
  reason: string
  employeeIds: readonly string[]
  /** Ask the people at once ("Ask 6 people"); false: a draft. */
  ask: boolean
}

export const createRequest = (api: ApiClient, body: NewRequest, idempotencyKey: string = newIdempotencyKey()) => api.post('/people/overtime-requests', { body, schema: record, idempotencyKey })

export const changeRequestPeople = (api: ApiClient, id: string, body: { version: number; add?: readonly string[]; remove?: readonly string[] }) =>
  api.post(`/people/overtime-requests/${seg(id)}/people`, { body, schema: record, idempotencyKey: newIdempotencyKey() })

export const askRequest = (api: ApiClient, id: string, version: number) =>
  api.post(`/people/overtime-requests/${seg(id)}/ask`, { body: { version }, schema: record, idempotencyKey: newIdempotencyKey() })

export const recordAnswer = (api: ApiClient, id: string, agreementId: string, body: { version: number; answer: 'AGREED' | 'DECLINED' }) =>
  api.post(`/people/overtime-requests/${seg(id)}/answers/${seg(agreementId)}`, { body, schema: record, idempotencyKey: newIdempotencyKey() })

export const approveRequest = (api: ApiClient, id: string, version: number) =>
  api.post(`/people/overtime-requests/${seg(id)}/approve`, { body: { version }, schema: record, idempotencyKey: newIdempotencyKey() })

export const cancelRequest = (api: ApiClient, id: string, body: { version: number; reason: string }) =>
  api.post(`/people/overtime-requests/${seg(id)}/cancel`, { body, schema: record, idempotencyKey: newIdempotencyKey() })
