import { z } from 'zod'
import { CORRECTION_KINDS } from '@nexus/factory-domain/people/close/rules'
import { MATCH_STATES, REPORT_GROUPS, type ReportGroup } from '@nexus/factory-domain/people/reports/attendance/report'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › People reports (B-W2b-64 on the API of B-W2b-48 and B-W2b-43), with the answer's shape checked (zod;
 * unknown fields are dropped). The reports are lines, teams and months: no call takes a person key, and a group under the
 * company's minimum size answers no figure. Two calls name one person or many, each behind its own right: a day's record
 * (one person), and the earnings per worker, which is a recorded opening (a POST; HR pays from it) and stays in the
 * page's state only. The API's English is never drawn: the screen has its own words, from the codes.
 */

export type { ReportGroup }
export { REPORT_GROUPS }

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const sightSchema = z.object({ siteId: z.string(), open: z.boolean(), minimumGroupSize: z.number() })
export type AttendanceSight = z.infer<typeof sightSchema>

/** "What you see here" for the ATTENDANCE purpose: read before the report. */
export const attendanceSight = (api: ApiClient, siteId: string) => api.get('/people/privacy/what-you-see', { query: { siteId, purpose: 'ATTENDANCE' }, schema: sightSchema })

const groupFigures = z.object({
  ordinaryMinutes: z.number(),
  presentMinutes: z.number(),
  nightMinutes: z.number(),
  holidayMinutes: z.number(),
  overtimeDayMinutes: z.number(),
  overtimeNightMinutes: z.number(),
  overtimeHolidayMinutes: z.number(),
  absenceMinutes: z.number(),
  absences: z.array(z.object({ code: z.string(), minutes: z.number() })),
})
export type GroupFigures = z.infer<typeof groupFigures>

const groupRow = z.object({ id: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: z.number().nullable(), tooFew: z.boolean(), figures: groupFigures.nullable() })
export type GroupRow = z.infer<typeof groupRow>

const reportSchema = z.object({
  siteId: z.string(),
  month: z.string(),
  groupBy: z.enum(REPORT_GROUPS),
  groups: z.array(groupRow),
  summary: z.object({ people: z.number(), figures: groupFigures }).nullable(),
  match: z.object({ state: z.enum(MATCH_STATES), cells: z.number() }),
  final: z.boolean(),
})
export type AttendanceReport = z.infer<typeof reportSchema>
export type MatchState = (typeof MATCH_STATES)[number]

const differencesSchema = z.object({ siteId: z.string(), month: z.string(), cells: z.array(z.object({ dayId: z.string(), date: z.string(), kind: z.enum(CORRECTION_KINDS), absenceCode: z.string().nullable() })) })
export type Differences = z.infer<typeof differencesSchema>
export type DifferenceCell = Differences['cells'][number]
export type CorrectionKind = (typeof CORRECTION_KINDS)[number]

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

const dayRecordSchema = z.object({
  dayId: z.string(),
  date: z.string(),
  person: z.object({ employeeId: z.string(), name: z.string(), employeeCode: z.string().nullable() }),
  closedFigures: cells,
  figuresNow: cells,
  differs: z.boolean(),
  corrections: z.array(z.object({ id: z.string(), kind: z.enum(CORRECTION_KINDS), absenceCode: z.string().nullable(), minutesBefore: z.number(), minutesAfter: z.number(), reason: z.string(), at: z.string(), by: z.string() })),
})
export type DayRecord = z.infer<typeof dayRecordSchema>

export interface AttendanceQuery {
  siteId: string
  month: string
  groupBy: ReportGroup
  teamId?: string | null
}

/** GET /people/reports/attendance (people.attendance.view; 409 gate/ATTENDANCE while the site's purpose is off). */
export const getAttendance = (api: ApiClient, query: AttendanceQuery) => api.get('/people/reports/attendance', { query: clean({ ...query }), schema: reportSchema })

/** "Differs in 2 cells · Show": no figure and no person, only which day and which kind of cell. */
export const getDifferences = (api: ApiClient, siteId: string, month: string) => api.get('/people/reports/attendance/differences', { query: { siteId, month }, schema: differencesSchema })

/** One closed day as one record: the person, the closed figures, the figures now, the corrections with who and why. */
export const getDay = (api: ApiClient, dayId: string) => api.get(`/people/attendance/days/${seg(dayId)}/corrections`, { schema: dayRecordSchema })

const earningFigures = { people: z.number().nullable(), pieces: z.string().nullable(), earnings: z.number().nullable(), makeUp: z.number().nullable(), makeUpSharePct: z.string().nullable(), tooFew: z.boolean() }
const earningsSchema = z.object({
  companyId: z.string(),
  from: z.string(),
  to: z.string(),
  lines: z.array(z.object({ line: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), ...earningFigures })),
  months: z.array(z.object({ month: z.string(), ...earningFigures })),
  asOf: z.string(),
})
export type EarningsReport = z.infer<typeof earningsSchema>

const workersSchema = z.object({ workers: z.array(z.object({ employeeId: z.string(), name: z.string(), code: z.string().nullable(), pieces: z.string(), earnings: z.number(), makeUp: z.number(), makeUpSharePct: z.string().nullable() })) })
export type EarningsWorkers = z.infer<typeof workersSchema>

export interface EarningsQuery {
  companyId: string
  from: string
  to: string
  siteId?: string | null
}

/** GET /people/reports/earnings (people.earnings.view + the pay grain): per line and per month. */
export const getEarnings = (api: ApiClient, query: EarningsQuery) => api.get('/people/reports/earnings', { query: clean({ ...query }), schema: earningsSchema })

/** Per worker: only with people.earnings.records and the pay grain; every call is written down. */
export const openEarningsByWorker = (api: ApiClient, query: EarningsQuery) =>
  api.post('/people/reports/earnings/by-worker', { body: clean({ ...query }), idempotencyKey: newIdempotencyKey(), schema: workersSchema })
