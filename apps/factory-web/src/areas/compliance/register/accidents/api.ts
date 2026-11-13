import { z } from 'zod'
import { ACCIDENT_OUTCOMES, HELD_CODES, REPORT_ACTIONS, REPORT_STATUSES, REPORT_VIEWS, SAFETY_SOURCES } from '@nexus/factory-domain/sales/safety-reports/rules'
import type { ApiClient } from '../../../../lib/api/client'
import type { IntakeBody } from '../../../../lib/safety-reports/intake'
import type { PhotoDoor } from '../../../../lib/safety-reports/photos'

/**
 * Product-safety reports and the accident log in the office (B-W2b-357 on B-W2b-351's `sales.safety-reports` routes; SAL-414,
 * SAL-415, SAL-423). Every call is checked with zod; the API's English (sourceWords, the log's words, law, Q37) is never
 * shown — the screens say it from codes. Writes carry an Idempotency-Key and the report's `version`.
 *   GET   /sales/safety-reports(?view,status,source,serial,batch,owner,q,cursor,limit)    the list (never the reporter, the words or an injury)
 *   GET   /sales/safety-reports/counts                                                     the tiles
 *   GET   /sales/safety-reports/accident-log(?from,to,outcome,told,limit)                  the log: the newest revision per report
 *   POST  /sales/safety-reports                                                            the office intake (a call, a visit, a mail)
 *   GET   /sales/safety-reports/:id                                                        the record
 *   PATCH /sales/safety-reports/:id                                                        owner, garment, day, worn as intended
 *   POST  …/:id/seen · …/:id/status · …/:id/register-entry · …/:id/reporter/erase
 *   POST  …/:id/injury/open · …/:id/injury · …/:id/injury/erase                            sales.safety.injury only
 *   GET   …/:id/accident-log · POST …/:id/accident-log                                     the revisions; a new one (sales.safety.log)
 *   POST  …/:id/photos (+ /:fileId/complete) · …/:id/photos/:fileId/open
 */

const person = z.object({ id: z.string(), name: z.string() })
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })
const party = z.object({ id: z.string(), code: z.string(), legalName: z.string() })
const action = z.object({ action: z.enum(REPORT_ACTIONS), allowed: z.boolean(), held: z.enum([...HELD_CODES, 'NO_PERMISSION']).nullable() })

export const revisionSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  occurredOn: z.string(),
  place: z.string(),
  styleId: z.string().nullable(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  outcome: z.enum(ACCIDENT_OUTCOMES),
  authority: z.object({ toldAt: z.string(), byId: z.string(), reference: z.string().nullable(), noticeId: z.string().nullable() }).nullable(),
  note: z.string().nullable(),
  recordedAt: z.string(),
  recordedById: z.string().nullable(),
})
export type Revision = z.infer<typeof revisionSchema>

const logState = z.object({ told: z.boolean(), mustTell: z.boolean(), words: z.string() })

export const reportRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  source: z.enum(SAFETY_SOURCES),
  receivedAt: z.string(),
  status: z.enum(REPORT_STATUSES),
  seen: z.boolean(),
  party: party.nullable(),
  style: style.nullable(),
  serial: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  size: z.string().nullable(),
  occurredOn: z.string().nullable(),
  case: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  filed: z.boolean(),
  accident: z.object({ outcome: z.enum(ACCIDENT_OUTCOMES), told: z.boolean(), mustTell: z.boolean() }).nullable(),
  ownerId: z.string().nullable(),
  version: z.number().int(),
})
export type ReportRow = z.infer<typeof reportRowSchema>

export const reportSchema = reportRowSchema.extend({
  contact: z.object({ id: z.string(), name: z.string() }).nullable(),
  reporter: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  reporterHidden: z.boolean(),
  colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  whatHappened: z.string(),
  wornAsIntended: z.boolean().nullable(),
  seenAt: z.string().nullable(),
  seenById: z.string().nullable(),
  registerEntry: z.object({ id: z.string(), reference: z.string(), status: z.string() }).nullable(),
  closed: z.object({ at: z.string(), byId: z.string().nullable(), note: z.string().nullable() }).nullable(),
  injury: z.object({ recorded: z.boolean(), mayOpen: z.boolean() }),
  accidentLog: z.object({ revisions: z.number().int(), newest: revisionSchema.nullable(), state: logState }),
  photos: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: z.string().nullable() })),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  actions: z.array(action),
  people: z.array(person),
})
export type Report = z.infer<typeof reportSchema>
export type ReportAction = Report['actions'][number]
export type Person = z.infer<typeof person>

const listAnswer = z.object({ reports: z.array(reportRowSchema), nextCursor: z.string().nullable(), people: z.array(person), asOf: z.string() })
export type ReportList = z.infer<typeof listAnswer>
const countsAnswer = z.object({
  tiles: z.object({ notSeen: z.number().int(), assessing: z.number().int(), accidentsToTell: z.number().int() }),
  rows: z.object({ open: z.number().int(), new: z.number().int(), assessing: z.number().int(), closed: z.number().int(), all: z.number().int() }),
  asOf: z.string(),
})
export type ReportCounts = z.infer<typeof countsAnswer>

export const logEntrySchema = revisionSchema.extend({ reportId: z.string(), companyId: z.string(), number: z.string(), reportStatus: z.enum(REPORT_STATUSES), style: style.nullable(), revisions: z.number().int(), mustTell: z.boolean() })
export type LogEntry = z.infer<typeof logEntrySchema>
const logAnswer = z.object({ entries: z.array(logEntrySchema), total: z.number().int(), tiles: z.object({ entries: z.number().int(), toTell: z.number().int(), told: z.number().int() }), people: z.array(person), asOf: z.string() })
export type AccidentLog = z.infer<typeof logAnswer>

const oneReport = z.object({ report: reportSchema })
const injurySchema = z.object({
  injury: z.object({ reportId: z.string(), number: z.string(), injured: z.boolean(), consentAt: z.string().nullable(), words: z.string().nullable(), erased: z.object({ at: z.string(), byId: z.string().nullable() }).nullable(), recordedAt: z.string(), recordedById: z.string().nullable() }),
})
export type Injury = z.infer<typeof injurySchema>['injury']
const revisionsAnswer = z.object({ reportId: z.string(), number: z.string(), revisions: z.array(revisionSchema), state: logState, people: z.array(person) })
export type Revisions = z.infer<typeof revisionsAnswer>
const presigned = z.object({ method: z.enum(['GET', 'PUT']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

export const SAFETY_VIEWS = REPORT_VIEWS

export interface ListQuery {
  readonly view: (typeof REPORT_VIEWS)[number]
  readonly source: (typeof SAFETY_SOURCES)[number] | null
  readonly q: string
  readonly cursor?: string | null
}

export function listReports(api: ApiClient, query: ListQuery, signal?: AbortSignal): Promise<ReportList> {
  return api.get('/sales/safety-reports', { query: { view: query.view, source: query.source ?? undefined, q: query.q.trim() || undefined, cursor: query.cursor ?? undefined, limit: 50 }, schema: listAnswer, signal })
}

export function reportCounts(api: ApiClient, signal?: AbortSignal): Promise<ReportCounts> {
  return api.get('/sales/safety-reports/counts', { schema: countsAnswer, signal })
}

export interface LogQuery {
  readonly from: string | null
  readonly to: string | null
  readonly outcome: (typeof ACCIDENT_OUTCOMES)[number] | null
  readonly told: 'yes' | 'no' | null
}

export function accidentLog(api: ApiClient, query: LogQuery, signal?: AbortSignal): Promise<AccidentLog> {
  return api.get('/sales/safety-reports/accident-log', { query: { from: query.from ?? undefined, to: query.to ?? undefined, outcome: query.outcome ?? undefined, told: query.told ?? undefined, limit: 200 }, schema: logAnswer, signal })
}

/** Whether the doors from outside are open (the public read; the office says it on the list). */
export async function outsideOpen(api: ApiClient, signal?: AbortSignal): Promise<boolean> {
  return (await api.get('/public/safety-reports/status', { schema: z.object({ open: z.boolean(), words: z.string().nullable() }), signal })).open
}

export interface RecordBody extends IntakeBody {
  companyId: string
  source: 'OFFICE' | 'MAIL'
  partyId: string | null
  styleId: string | null
  receivedAt: string | null
}

export function recordReport(api: ApiClient, body: RecordBody, idempotencyKey: string): Promise<{ report: Report; serviceCase: { id: string; number: string }; warnings: { path: string; message: string }[] }> {
  return api.post('/sales/safety-reports', { body, schema: z.object({ report: reportSchema, serviceCase: z.object({ id: z.string(), number: z.string() }), warnings: z.array(z.object({ path: z.string(), message: z.string() })) }), idempotencyKey })
}

export function getReport(api: ApiClient, id: string, signal?: AbortSignal): Promise<Report> {
  return api.get(`/sales/safety-reports/${encodeURIComponent(id)}`, { schema: oneReport, signal }).then((answer) => answer.report)
}

const at = (id: string, rest = '') => `/sales/safety-reports/${encodeURIComponent(id)}${rest}`

export interface FactsPatch {
  serial?: string | null
  batchNumber?: string | null
  size?: string | null
  occurredOn?: string | null
  wornAsIntended?: boolean | null
}

export function changeReport(api: ApiClient, id: string, version: number, patch: FactsPatch, key: string): Promise<Report> {
  return api.request('PATCH', at(id), { body: { version, ...patch }, schema: z.object({ report: reportSchema, warnings: z.array(z.unknown()) }), idempotencyKey: key }).then((answer) => answer.report)
}

export function markSeen(api: ApiClient, id: string, version: number, key: string): Promise<Report> {
  return api.post(at(id, '/seen'), { body: { version }, schema: oneReport, idempotencyKey: key }).then((answer) => answer.report)
}

export function moveReport(api: ApiClient, id: string, version: number, to: 'ASSESSING' | 'CLOSED', note: string | null, key: string): Promise<Report> {
  return api.post(at(id, '/status'), { body: { version, to, ...(note ? { note } : {}) }, schema: oneReport, idempotencyKey: key }).then((answer) => answer.report)
}

export function fileReport(api: ApiClient, id: string, version: number, key: string): Promise<{ report: Report; registerEntry: { id: string; reference: string; opened: boolean } }> {
  return api.post(at(id, '/register-entry'), { body: { version }, schema: z.object({ report: reportSchema, registerEntry: z.object({ id: z.string(), reference: z.string(), opened: z.boolean() }) }), idempotencyKey: key })
}

export function eraseReporter(api: ApiClient, id: string, version: number, reason: string, key: string): Promise<Report> {
  return api.post(at(id, '/reporter/erase'), { body: { version, reason }, schema: oneReport, idempotencyKey: key }).then((answer) => answer.report)
}

export function openInjury(api: ApiClient, id: string, key: string): Promise<Injury> {
  return api.post(at(id, '/injury/open'), { schema: injurySchema, idempotencyKey: key }).then((answer) => answer.injury)
}

export function recordInjury(api: ApiClient, id: string, version: number, body: { injured: boolean; consent?: boolean; words?: string | null }, key: string): Promise<Report> {
  return api.post(at(id, '/injury'), { body: { version, ...body }, schema: oneReport, idempotencyKey: key }).then((answer) => answer.report)
}

export function eraseInjury(api: ApiClient, id: string, version: number, reason: string, key: string): Promise<Report> {
  return api.post(at(id, '/injury/erase'), { body: { version, reason }, schema: oneReport, idempotencyKey: key }).then((answer) => answer.report)
}

export function reportRevisions(api: ApiClient, id: string, signal?: AbortSignal): Promise<Revisions> {
  return api.get(at(id, '/accident-log'), { schema: revisionsAnswer, signal })
}

export interface ReviseBody {
  occurredOn?: string
  place?: string
  outcome?: (typeof ACCIDENT_OUTCOMES)[number]
  authorityToldAt?: string
  authorityReference?: string | null
  note?: string | null
}

export function reviseAccident(api: ApiClient, id: string, version: number, body: ReviseBody, key: string): Promise<{ report: Report; entry: Revision }> {
  return api.post(at(id, '/accident-log'), { body: { version, ...body }, schema: z.object({ report: reportSchema, entry: revisionSchema }), idempotencyKey: key })
}

export const officePhotoDoor = (id: string): PhotoDoor => ({ announce: at(id, '/photos'), complete: (fileId) => at(id, `/photos/${encodeURIComponent(fileId)}/complete`) })

export function openPhoto(api: ApiClient, id: string, fileId: string, key: string): Promise<z.infer<typeof presigned>> {
  return api.post(at(id, `/photos/${encodeURIComponent(fileId)}/open`), { schema: z.object({ download: presigned }), idempotencyKey: key }).then((answer) => answer.download)
}
