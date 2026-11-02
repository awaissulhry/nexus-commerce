import { z } from 'zod'
import { ABSENCE_CATEGORIES, ABSENCE_STATES } from '@nexus/factory-domain/people/attendance/absences'
import { ANOMALY_KINDS, ANOMALY_RESOLUTIONS, APPROVAL_HOLDS, DAY_STATUSES, type ManualReason } from '@nexus/factory-domain/people/attendance/rules'
import { CLOCK_FLAGS, CLOCK_KINDS, CLOCK_SOURCES } from '@nexus/factory-domain/people/clock/rules'
import { CLOSE_HOLDS, CLOSE_ITEMS, CLOSE_NOTES, CORRECTION_KINDS, type CorrectionKind } from '@nexus/factory-domain/people/close/rules'
import { CHECKED_LIMITS, LIMIT_STATES } from '@nexus/factory-domain/people/limits/checks'
import { RULE_ACTIONS } from '@nexus/factory-domain/people/limits/rules'
import { ENTRY_HOLDS, ENTRY_STATUSES, OVERTIME_CLASSES } from '@nexus/factory-domain/people/overtime/rules'
import { TIMESHEET_HOLDS, TIMESHEET_STAGES, TIMESHEET_STATUSES } from '@nexus/factory-domain/people/overtime/timesheets'
import { OVERTIME_STATUSES } from '@nexus/factory-domain/people/shifts/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { Sight } from '../_shared/api'

/**
 * Every call of People › Attendance (B-W2b-61 on the API of B-W2b-37 days and who is in, B-W2b-42 overtime, timesheets and
 * limits, B-W2b-48 the month close, the LUL calendar and corrections), with the answer's shape checked (zod; unknown fields
 * and the API's English `words` are dropped: the screens say their own words from codes and figures). A list carries no
 * name and no minutes (Owner answer W1; Statuto dei Lavoratori art. 4): those open one record at a time. Every read of a
 * person goes behind the site's ATTENDANCE gate: the API answers 409 `gate/ATTENDANCE`, `isGateClosed` in model.ts.
 */

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

// ---- what you see here ---------------------------------------------------------------------------------------------------------

const sightSchema = z.object({ siteId: z.string(), purpose: z.enum(['ATTENDANCE', 'PERFORMANCE']), open: z.boolean(), level: z.enum(['GROUPS_ONLY', 'ONE_PERSON_ON_REQUEST']), minimumGroupSize: z.number(), leadsSeeFigures: z.boolean() })

/** The site's ATTENDANCE gate in words (any office person, a site in reach): read before any person is read. */
export const readSight = (api: ApiClient, siteId: string): Promise<Sight> => api.get('/people/privacy/what-you-see', { query: { siteId, purpose: 'ATTENDANCE' }, schema: sightSchema })

// ---- the days -------------------------------------------------------------------------------------------------------------------

const planned = z.object({ label: z.string().nullable(), startMinute: z.number(), endMinute: z.number(), minutes: z.number() }).nullable()
export type Planned = z.infer<typeof planned>

const dayRow = z.object({
  id: z.string(),
  date: z.string(),
  siteId: z.string(),
  teamId: z.string().nullable(),
  lineId: z.string().nullable(),
  status: z.enum(DAY_STATUSES),
  planned,
  presence: z.boolean(),
  anomalies: z.object({ open: z.number(), kinds: z.array(z.enum(ANOMALY_KINDS)) }),
  manual: z.boolean(),
  absence: z.enum(ABSENCE_STATES),
  approvedAt: z.string().nullable(),
  version: z.number(),
})
export type DayRow = z.infer<typeof dayRow>

export interface DaysQuery {
  siteId: string
  from: string
  to: string
  teamId?: string | null
  lineId?: string | null
  status?: DayRow['status'] | null
  anomaly?: DayRow['anomalies']['kinds'][number] | null
  manual?: boolean | null
  cursor?: string | null
  limit?: number
}

const dayPage = z.object({ days: z.array(dayRow), nextCursor: z.string().nullable(), today: z.string() })
export type DayPage = z.infer<typeof dayPage>

export const readDays = (api: ApiClient, query: DaysQuery): Promise<DayPage> =>
  api.get('/people/attendance/days', {
    query: clean({ siteId: query.siteId, from: query.from, to: query.to, teamId: query.teamId, lineId: query.lineId, status: query.status, anomaly: query.anomaly, manual: query.manual === null || query.manual === undefined ? null : String(query.manual), cursor: query.cursor, limit: query.limit }),
    schema: dayPage,
  })

const tile = z.number().nullable()
const countsSchema = z.object({ people: tile, tooFew: z.boolean(), tiles: z.object({ openAnomalies: tile, daysToApprove: tile, cleanDaysToApprove: tile, absencesWithoutCode: tile, manualDays: tile, clockedInNow: tile }) })
export type DayCounts = z.infer<typeof countsSchema>

export interface Selection {
  siteId: string
  from: string
  to: string
  teamId?: string | null
  lineId?: string | null
}

export const readCounts = (api: ApiClient, query: Selection): Promise<DayCounts> =>
  api.get('/people/attendance/counts', { query: clean({ siteId: query.siteId, from: query.from, to: query.to, teamId: query.teamId, lineId: query.lineId }), schema: countsSchema })

const entryCountsSchema = z.object({ tooFew: z.boolean(), tiles: z.object({ waitingEntries: tile, waitingMinutes: tile, notPlanned: tile }) })
export type EntryCounts = z.infer<typeof entryCountsSchema>

export const readEntryCounts = (api: ApiClient, query: Selection): Promise<EntryCounts> =>
  api.get('/people/overtime/counts', { query: clean({ siteId: query.siteId, from: query.from, to: query.to, teamId: query.teamId, lineId: query.lineId }), schema: entryCountsSchema })

// ---- one person's day -----------------------------------------------------------------------------------------------------------

const clockEvent = z.object({
  id: z.string(),
  kind: z.enum(CLOCK_KINDS),
  source: z.enum(CLOCK_SOURCES),
  occurredAt: z.string(),
  siteId: z.string(),
  flags: z.array(z.enum(CLOCK_FLAGS)),
  reason: z.string().nullable(),
  offSite: z.boolean(),
  voidsEventId: z.string().nullable(),
  voided: z.boolean(),
})
export type ClockEvent = z.infer<typeof clockEvent>

const anomaly = z.object({
  id: z.string(),
  kind: z.enum(ANOMALY_KINDS),
  ruleKey: z.string(),
  clockEventId: z.string().nullable(),
  raisedAt: z.string(),
  resolution: z.enum(ANOMALY_RESOLUTIONS).nullable(),
  resolvedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
})
export type Anomaly = z.infer<typeof anomaly>

const absence = z.object({
  id: z.string(),
  codeId: z.string(),
  code: z.string(),
  label: z.record(z.string(), z.string()),
  category: z.enum(ABSENCE_CATEGORIES),
  lulCode: z.string().nullable(),
  minutes: z.number(),
  documentRef: z.string().nullable(),
  version: z.number(),
})
export type DayAbsence = z.infer<typeof absence>

const figures = z.object({
  firstInAt: z.string().nullable(),
  lastOutAt: z.string().nullable(),
  presentMinutes: z.number(),
  breakMinutes: z.number(),
  ordinaryMinutes: z.number(),
  overtimeMinutes: z.number(),
  nightMinutes: z.number(),
  holidayMinutes: z.number(),
  absenceMinutes: z.number(),
})
export type DayFigures = z.infer<typeof figures>

const person = z.object({ employeeId: z.string(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable() })

const daySchema = z.object({
  id: z.string(),
  date: z.string(),
  siteId: z.string(),
  companyId: z.string(),
  status: z.enum(DAY_STATUSES),
  version: z.number(),
  person,
  planned,
  figures,
  computedAt: z.string().nullable(),
  manual: z.boolean(),
  approvedAt: z.string().nullable(),
  events: z.array(clockEvent),
  anomalies: z.array(anomaly),
  absences: z.array(absence),
  holds: z.array(z.object({ code: z.enum(APPROVAL_HOLDS) })),
  actions: z.object({ approve: z.boolean(), fix: z.boolean(), reopen: z.boolean() }),
})
export type DayRecord = z.infer<typeof daySchema>

export const readDay = (api: ApiClient, dayId: string): Promise<DayRecord> => api.get(`/people/attendance/days/${seg(dayId)}`, { schema: daySchema })

export const approveDay = (api: ApiClient, dayId: string, version: number): Promise<DayRecord> => api.post(`/people/attendance/days/${seg(dayId)}/approve`, { body: { version }, schema: daySchema, idempotencyKey: newIdempotencyKey() })

const approvedMany = z.object({ approved: z.array(z.string()), held: z.array(z.object({ dayId: z.string(), codes: z.array(z.enum(APPROVAL_HOLDS)) })) })
export type ApprovedMany = z.infer<typeof approvedMany>

export const approveDays = (api: ApiClient, dayIds: readonly string[]): Promise<ApprovedMany> => api.post('/people/attendance/days/approve', { body: { dayIds }, schema: approvedMany, idempotencyKey: newIdempotencyKey() })

export const reopenDay = (api: ApiClient, dayId: string, body: { version: number; reason: string }): Promise<DayRecord> => api.post(`/people/attendance/days/${seg(dayId)}/reopen`, { body, schema: daySchema, idempotencyKey: newIdempotencyKey() })

export const acceptAnomaly = (api: ApiClient, anomalyId: string, note: string): Promise<DayRecord> => api.post(`/people/attendance/anomalies/${seg(anomalyId)}/accept`, { body: { note }, schema: daySchema, idempotencyKey: newIdempotencyKey() })

export type FixAction =
  | { kind: 'ADD_EVENT'; event: 'IN' | 'OUT' | 'BREAK_OUT' | 'BREAK_IN'; at: string; offSite?: boolean }
  | { kind: 'VOID_EVENT'; clockEventId: string }
  | { kind: 'SET_ABSENCE'; codeId: string; minutes?: number; documentRef?: string | null }
  | { kind: 'REMOVE_ABSENCE'; absenceId: string }

export const fixDay = (api: ApiClient, dayId: string, body: { version: number; action: FixAction; reasonCode?: ManualReason; reason: string }): Promise<DayRecord> =>
  api.post(`/people/attendance/days/${seg(dayId)}/fix`, { body, schema: daySchema, idempotencyKey: newIdempotencyKey() })

/** The inline code of a day nobody clocked in (autosave; not a manual entry). */
export const setDayAbsence = (api: ApiClient, dayId: string, body: { version: number; codeId: string | null }): Promise<DayRecord> =>
  api.post(`/people/attendance/days/${seg(dayId)}/absence`, { body, schema: daySchema, idempotencyKey: newIdempotencyKey() })

export interface ManualEntry {
  employeeId: string
  date: string
  in?: string
  out?: string
  offSite?: boolean
  absence?: { codeId: string; minutes?: number; documentRef?: string | null }
  reasonCode?: ManualReason
  reason: string
}

export const addManualEntry = (api: ApiClient, body: ManualEntry): Promise<DayRecord> => api.post('/people/attendance/entries', { body, schema: daySchema, idempotencyKey: newIdempotencyKey() })

const code = z.object({ id: z.string(), code: z.string(), labelI18n: z.record(z.string(), z.string()), category: z.enum(ABSENCE_CATEGORIES), lulCode: z.string().nullable(), documentRequired: z.boolean(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type AbsenceCode = z.infer<typeof code>

export const readAbsenceCodes = (api: ApiClient, companyId: string): Promise<AbsenceCode[]> =>
  api.get('/people/attendance/absence-codes', { query: { companyId, status: 'ACTIVE' }, schema: z.object({ codes: z.array(code) }) }).then((answer) => answer.codes)

// ---- overtime to approve --------------------------------------------------------------------------------------------------------

const tone = z.object({ rule: z.enum(CHECKED_LIMITS), state: z.enum(LIMIT_STATES), level: z.enum(RULE_ACTIONS) })
export type LimitTone = z.infer<typeof tone>

const entryRow = z.object({
  id: z.string(),
  date: z.string(),
  siteId: z.string(),
  teamId: z.string().nullable(),
  lineId: z.string().nullable(),
  class: z.enum(OVERTIME_CLASSES),
  status: z.enum(ENTRY_STATUSES),
  requestId: z.string().nullable(),
  checks: z.array(tone),
  version: z.number(),
})
export type EntryRow = z.infer<typeof entryRow>

export const readEntries = (api: ApiClient, query: Selection & { status?: EntryRow['status'] | null; cursor?: string | null; limit?: number }) =>
  api.get('/people/overtime/entries', {
    query: clean({ siteId: query.siteId, from: query.from, to: query.to, teamId: query.teamId, lineId: query.lineId, status: query.status, cursor: query.cursor, limit: query.limit }),
    schema: z.object({ entries: z.array(entryRow), nextCursor: z.string().nullable() }),
  })

const check = tone.extend({ date: z.string(), law: z.string(), values: z.record(z.string(), z.union([z.number(), z.string()])) })
export type LimitCheck = z.infer<typeof check>

const entrySchema = z.object({
  id: z.string(),
  date: z.string(),
  siteId: z.string(),
  companyId: z.string(),
  class: z.enum(OVERTIME_CLASSES),
  minutes: z.number(),
  status: z.enum(ENTRY_STATUSES),
  version: z.number(),
  person,
  day: z.object({ id: z.string(), status: z.enum(DAY_STATUSES), overtimeMinutes: z.number(), nightMinutes: z.number(), holidayMinutes: z.number(), manual: z.boolean() }).nullable(),
  request: z.object({ id: z.string(), date: z.string(), minutes: z.number(), status: z.enum(OVERTIME_STATUSES) }).nullable(),
  beyondRequestMinutes: z.number().nullable(),
  decision: z.object({ approvedAt: z.string().nullable(), approvedBy: z.string().nullable(), rejectedAt: z.string().nullable(), rejectedBy: z.string().nullable(), rejectReason: z.string().nullable() }),
  checks: z.array(check),
  holds: z.array(z.object({ code: z.enum(ENTRY_HOLDS) })),
  actions: z.object({ approve: z.boolean(), reject: z.boolean(), reopen: z.boolean() }),
})
export type EntryRecord = z.infer<typeof entrySchema>

export const readEntry = (api: ApiClient, entryId: string): Promise<EntryRecord> => api.get(`/people/overtime/entries/${seg(entryId)}`, { schema: entrySchema })
export const approveEntry = (api: ApiClient, entryId: string, body: { version: number; overrideReason?: string }): Promise<EntryRecord> =>
  api.post(`/people/overtime/entries/${seg(entryId)}/approve`, { body, schema: entrySchema, idempotencyKey: newIdempotencyKey() })
export const rejectEntry = (api: ApiClient, entryId: string, body: { version: number; reason: string }): Promise<EntryRecord> =>
  api.post(`/people/overtime/entries/${seg(entryId)}/reject`, { body, schema: entrySchema, idempotencyKey: newIdempotencyKey() })
export const reopenEntry = (api: ApiClient, entryId: string, body: { version: number; reason: string }): Promise<EntryRecord> =>
  api.post(`/people/overtime/entries/${seg(entryId)}/reopen`, { body, schema: entrySchema, idempotencyKey: newIdempotencyKey() })

// ---- timesheets -----------------------------------------------------------------------------------------------------------------

const timesheetRow = z.object({
  id: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(TIMESHEET_STATUSES),
  stage: z.enum(TIMESHEET_STAGES),
  teamId: z.string().nullable(),
  lineId: z.string().nullable(),
  ready: z.boolean(),
  returned: z.boolean(),
  version: z.number(),
})
export type TimesheetRow = z.infer<typeof timesheetRow>

const timesheetPage = z.object({ timesheets: z.array(timesheetRow), nextCursor: z.string().nullable(), canPrepare: z.boolean() })
export type TimesheetPage = z.infer<typeof timesheetPage>

export const readTimesheets = (api: ApiClient, query: { siteId: string; month: string; teamId?: string | null; lineId?: string | null; cursor?: string | null; limit?: number }): Promise<TimesheetPage> =>
  api.get('/people/timesheets', { query: clean({ siteId: query.siteId, month: query.month, teamId: query.teamId, lineId: query.lineId, cursor: query.cursor, limit: query.limit }), schema: timesheetPage })

export const prepareTimesheets = (api: ApiClient, body: { siteId: string; month: string }) =>
  api.post('/people/timesheets/prepare', { body, schema: z.object({ created: z.number(), existing: z.number() }), idempotencyKey: newIdempotencyKey() })

const holdCode = z.object({ code: z.enum(TIMESHEET_HOLDS) })
const timesheetSchema = z.object({
  id: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(TIMESHEET_STATUSES),
  stage: z.enum(TIMESHEET_STAGES),
  version: z.number(),
  person: person.extend({ siteId: z.string() }),
  lead: z.object({ approvedAt: z.string().nullable(), approvedBy: z.string().nullable() }),
  hr: z.object({ approvedAt: z.string().nullable(), approvedBy: z.string().nullable() }),
  returned: z.object({ at: z.string(), by: z.string().nullable(), reason: z.string() }).nullable(),
  figuresShown: z.boolean(),
  days: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      status: z.enum(DAY_STATUSES),
      plannedLabel: z.string().nullable(),
      presence: z.boolean(),
      absent: z.boolean(),
      anomaliesOpen: z.number(),
      manual: z.boolean(),
      figures: z.object({ firstInAt: z.string().nullable(), lastOutAt: z.string().nullable(), presentMinutes: z.number(), ordinaryMinutes: z.number(), nightMinutes: z.number(), holidayMinutes: z.number(), absenceMinutes: z.number() }).nullable(),
      absences: z.array(z.object({ code: z.string(), category: z.enum(ABSENCE_CATEGORIES), minutes: z.number() })).nullable(),
      overtime: z.array(z.object({ class: z.enum(OVERTIME_CLASSES), minutes: z.number(), status: z.enum(ENTRY_STATUSES) })).nullable(),
    }),
  ),
  summary: z.object({ daysPresent: z.number(), presentMinutes: z.number(), ordinaryMinutes: z.number(), nightMinutes: z.number(), holidayMinutes: z.number(), absenceMinutes: z.number(), overtimeApprovedMinutes: z.number(), overtimePendingMinutes: z.number(), overtimeRejectedMinutes: z.number() }).nullable(),
  holds: z.object({ lead: z.array(holdCode), hr: z.array(holdCode) }),
  changedSince: z.boolean(),
  actions: z.object({ leadApprove: z.boolean(), hrApprove: z.boolean(), sendBack: z.boolean() }),
})
export type TimesheetRecord = z.infer<typeof timesheetSchema>

export const readTimesheet = (api: ApiClient, id: string): Promise<TimesheetRecord> => api.get(`/people/timesheets/${seg(id)}`, { schema: timesheetSchema })
export const approveAsLead = (api: ApiClient, id: string, version: number): Promise<TimesheetRecord> => api.post(`/people/timesheets/${seg(id)}/lead-approve`, { body: { version }, schema: timesheetSchema, idempotencyKey: newIdempotencyKey() })
export const approveAsHr = (api: ApiClient, id: string, version: number): Promise<TimesheetRecord> => api.post(`/people/timesheets/${seg(id)}/hr-approve`, { body: { version }, schema: timesheetSchema, idempotencyKey: newIdempotencyKey() })
export const sendBackTimesheet = (api: ApiClient, id: string, body: { version: number; reason: string }): Promise<TimesheetRecord> =>
  api.post(`/people/timesheets/${seg(id)}/send-back`, { body, schema: timesheetSchema, idempotencyKey: newIdempotencyKey() })

// ---- the month close ------------------------------------------------------------------------------------------------------------

const panelSchema = z.object({
  companyId: z.string(),
  month: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  closeId: z.string().nullable(),
  monthOver: z.boolean(),
  due: z.object({ by: z.string(), daysLeft: z.number() }),
  checklist: z.array(z.object({ item: z.enum(CLOSE_ITEMS), left: z.number(), done: z.boolean() })),
  notes: z.array(z.object({ note: z.enum(CLOSE_NOTES) })),
  holds: z.array(z.object({ code: z.enum(CLOSE_HOLDS) })),
  days: z.number(),
  sites: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), gateOpen: z.boolean() })),
  corrections: z.number(),
  seal: z.object({ closedAt: z.string(), closedBy: z.string().nullable(), sealed: z.boolean(), sha256: z.string().nullable(), fileId: z.string().nullable() }).nullable(),
  confirm: z.object({ phrases: z.object({ en: z.string(), it: z.string() }) }),
  toConfirm: z.array(z.string()),
  actions: z.object({ close: z.boolean(), seal: z.boolean(), openLul: z.boolean() }),
})
export type MonthPanel = z.infer<typeof panelSchema>

export const readMonthPanel = (api: ApiClient, companyId: string, month: string): Promise<MonthPanel> => api.get('/people/month-close', { query: { companyId, month }, schema: panelSchema })

export const closeMonth = (api: ApiClient, body: { companyId: string; month: string; phrase: string }): Promise<MonthPanel> => api.post('/people/month-close', { body, schema: panelSchema, idempotencyKey: newIdempotencyKey() })

export const sealMonth = (api: ApiClient, closeId: string): Promise<MonthPanel> => api.post(`/people/month-close/${seg(closeId)}/seal`, { body: {}, schema: panelSchema, idempotencyKey: newIdempotencyKey() })

const closeMonths = z.object({ months: z.array(z.object({ closeId: z.string(), month: z.string(), state: z.enum(['OPEN', 'CLOSED']), closedAt: z.string().nullable(), sealed: z.boolean() })) })
export type CloseMonth = z.infer<typeof closeMonths>['months'][number]

export const readCloseMonths = (api: ApiClient, companyId: string): Promise<CloseMonth[]> => api.get('/people/month-close/months', { query: { companyId, limit: 120 }, schema: closeMonths }).then((answer) => answer.months)

const presigned = z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const lulOpened = z.object({ closeId: z.string(), format: z.enum(['PDF', 'CSV']), fileName: z.string(), sha256: z.string(), download: presigned })
export type LulOpened = z.infer<typeof lulOpened>

/** Each opening is recorded (people.openLulCalendar): the key keeps a page's one opening one row. */
export const openLul = (api: ApiClient, closeId: string, format: 'PDF' | 'CSV', idempotencyKey: string): Promise<LulOpened> =>
  api.post(`/people/month-close/${seg(closeId)}/lul/open`, { body: { format }, schema: lulOpened, idempotencyKey })

const cells = z.object({
  presentMinutes: z.number(),
  ordinaryMinutes: z.number(),
  nightMinutes: z.number(),
  holidayMinutes: z.number(),
  overtimeDayMinutes: z.number(),
  overtimeNightMinutes: z.number(),
  overtimeHolidayMinutes: z.number(),
  absences: z.array(z.object({ codeId: z.string(), code: z.string(), minutes: z.number() })),
})
export type DayCells = z.infer<typeof cells>

const correctionsSchema = z.object({
  dayId: z.string(),
  date: z.string(),
  siteId: z.string(),
  status: z.string(),
  closeId: z.string().nullable(),
  person: z.object({ employeeId: z.string(), name: z.string(), displayName: z.string().nullable(), employeeCode: z.string().nullable() }),
  closedFigures: cells,
  figuresNow: cells,
  differs: z.boolean(),
  corrections: z.array(z.object({ id: z.string(), kind: z.enum(CORRECTION_KINDS), absenceCode: z.string().nullable(), minutesBefore: z.number(), minutesAfter: z.number(), reason: z.string(), at: z.string(), by: z.string().nullable() })),
  actions: z.object({ correct: z.boolean() }),
})
export type DayCorrections = z.infer<typeof correctionsSchema>

export const readCorrections = (api: ApiClient, dayId: string): Promise<DayCorrections> => api.get(`/people/attendance/days/${seg(dayId)}/corrections`, { schema: correctionsSchema })

export const correctDay = (api: ApiClient, dayId: string, body: { kind: CorrectionKind; absenceCodeId?: string | null; minutesBefore: number; minutesAfter: number; reason: string }): Promise<DayCorrections> =>
  api.post(`/people/attendance/days/${seg(dayId)}/corrections`, { body, schema: correctionsSchema, idempotencyKey: newIdempotencyKey() })

// ---- who is in now and the roll call ----------------------------------------------------------------------------------------------

const presenceLine = z.object({ lineId: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: z.number().nullable(), tooFew: z.boolean() })
const presenceArea = z.object({ areaId: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: z.number().nullable(), tooFew: z.boolean(), lines: z.array(presenceLine) })
const whoSchema = z.object({ asOf: z.string(), people: z.number().nullable(), tooFew: z.boolean(), areas: z.array(presenceArea) })
export type WhoIsIn = z.infer<typeof whoSchema>

export const readWhoIsIn = (api: ApiClient, siteId: string): Promise<WhoIsIn> => api.get('/people/attendance/who-is-in', { query: { siteId }, schema: whoSchema })

const rollSchema = z.object({
  asOf: z.string(),
  people: z.number(),
  groups: z.array(z.object({ areaId: z.string().nullable(), areaName: z.string().nullable(), lineId: z.string().nullable(), lineName: z.string().nullable(), people: z.array(z.object({ employeeId: z.string(), name: z.string(), onBreak: z.boolean() })) })),
})
export type RollCall = z.infer<typeof rollSchema>

/** The names of who is in now (an evacuation, D.Lgs. 81/2008 art. 43): each opening is recorded, so it is a POST. */
export const readRollCall = (api: ApiClient, siteId: string): Promise<RollCall> => api.post('/people/attendance/roll-call', { body: { siteId }, schema: rollSchema, idempotencyKey: newIdempotencyKey() })

// ---- one person's month: the employee's Attendance tab ---------------------------------------------------------------------------

const employeeDays = z.object({
  person: z.object({ employeeId: z.string(), name: z.string(), displayName: z.string(), siteId: z.string() }),
  from: z.string(),
  to: z.string(),
  days: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      siteId: z.string(),
      status: z.enum(DAY_STATUSES),
      planned,
      figures,
      manual: z.boolean(),
      anomaliesOpen: z.number(),
      absences: z.array(z.object({ code: z.string(), category: z.enum(ABSENCE_CATEGORIES), minutes: z.number() })),
      version: z.number(),
    }),
  ),
})
export type EmployeeDays = z.infer<typeof employeeDays>
export type EmployeeDay = EmployeeDays['days'][number]

export const readEmployeeDays = (api: ApiClient, employeeId: string, from: string, to: string): Promise<EmployeeDays> => api.get(`/people/employees/${seg(employeeId)}/attendance`, { query: { from, to }, schema: employeeDays })

const personMonth = z.object({
  month: z.string(),
  monthState: z.enum(['OPEN', 'CLOSED']),
  closedAt: z.string().nullable(),
  figures: z.object({ ordinaryMinutes: z.number(), presentMinutes: z.number(), nightMinutes: z.number(), holidayMinutes: z.number(), overtimeDayMinutes: z.number(), overtimeNightMinutes: z.number(), overtimeHolidayMinutes: z.number(), absenceMinutes: z.number() }),
  differs: z.boolean(),
})
export type PersonMonth = z.infer<typeof personMonth>

export const readPersonMonth = (api: ApiClient, employeeId: string, month: string): Promise<PersonMonth> => api.get(`/people/reports/attendance/people/${seg(employeeId)}`, { query: { month }, schema: personMonth })
