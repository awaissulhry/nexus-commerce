import { z } from 'zod'
import { FIGURE_ACCESS, FIGURE_REFUSALS, OPEN_REASONS, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import { DAY_BLOCKERS, DISPUTE_REASONS, DISPUTE_RECORD_TYPES, EDIT_KINDS, INBOX_KINDS, LINE_DAY_STATES, RECORD_STATES, SHEET_EXCEPTIONS, type DisputeOutcome, type EditKind, type InboxKind, type LineDayState } from '@nexus/factory-domain/production/labour/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Production › Floor control › Labour & corrections (B-W2b-57; SCR-139, SCR-143): every call of the page, each answer
 * checked by its schema (zod drops what the page does not read). The shapes mirror apps/factory-api
 * modules/production/labour/contract.ts (B-W2b-45), modules/production/offstandard/contract.ts (B-W2b-29) and the scans'
 * correction routes (B-W1-42). The API's English (`words`, a refusal's message) is never drawn: the page says its own
 * words from the codes and the counts.
 *
 * Nothing here reads a person into a list: the queue, the line days and the changes say where, when and what, and at most
 * that a record names someone (`named`). A worker's name is read from ONE record, where the API serves it: the labour
 * record, the dispute and the block answer it only where the site records workers and the site's PERFORMANCE legal gate
 * is in force (`legalGateFor`, server side). The correction's own read names people with no such gate (W1), so this
 * schema does not read them, and neither does the scans list "for context".
 */

const seg = (value: string) => encodeURIComponent(value)
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const someone = z.object({ id: z.string(), name: z.string() })
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const change = z.object({ field: z.string(), from: scalar, to: scalar })
export type Change = z.infer<typeof change>
export type Place = z.infer<typeof place>
const workOrderRef = z.object({ id: z.string(), number: z.string() })
const bundleRef = z.object({ id: z.string(), code: z.string() })
const operationRef = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() })
const counts = z.object({ good: z.number(), scrap: z.number(), rework: z.number() })
export type Counts = z.infer<typeof counts>

// ---- the tiles and the queue ---------------------------------------------------------------------------------------------

const countsSchema = z.object({ corrections: z.number(), disputes: z.number(), offStandard: z.number(), lineDays: z.number(), heldDays: z.number() })
export type LabourCounts = z.infer<typeof countsSchema>

const inboxItem = z.object({
  kind: z.enum(INBOX_KINDS),
  id: z.string(),
  version: z.number().nullable(),
  siteId: z.string(),
  line: place.nullable(),
  workDate: z.string().nullable(),
  workOrder: workOrderRef.nullable(),
  bundle: bundleRef.nullable(),
  operation: operationRef.nullable(),
  changes: z.array(change),
  code: z.string().nullable(),
  minutes: z.number().nullable(),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  unusual: z.array(z.string()),
  named: z.boolean(),
  raisedAt: z.string(),
  ageMinutes: z.number(),
})
export type InboxItem = z.infer<typeof inboxItem>

export interface Scope {
  readonly siteId: string | null
  readonly lineId: string | null
}

const where = (scope: Scope) => ({ siteId: scope.siteId ?? undefined, lineId: scope.lineId ?? undefined })

/** The tiles: what waits per kind; counts of records, never of people. */
export const labourCounts = (api: ApiClient, scope: Scope) => api.get('/production/labour/counts', { query: where(scope), schema: countsSchema })

/** ONE queue, oldest first: corrections, disputes, off-standard blocks, line days ready to close. */
export const labourInbox = (api: ApiClient, scope: Scope, kind: InboxKind | null, limit: number) =>
  api.get('/production/labour/inbox', { query: { ...where(scope), kind: kind ?? undefined, limit }, schema: z.object({ items: z.array(inboxItem), more: z.boolean() }) })

// ---- line days -----------------------------------------------------------------------------------------------------------

const blocker = z.object({ kind: z.enum(DAY_BLOCKERS), count: z.number() })
export type DayBlocker = z.infer<typeof blocker>

const daySchema = z.object({
  labourDayId: z.string().nullable(),
  version: z.number().nullable(),
  siteId: z.string(),
  line: place,
  workDate: z.string(),
  state: z.enum(LINE_DAY_STATES),
  offStandard: z.object({ coded: z.boolean(), left: z.number() }),
  anomalies: z.number(),
  blockers: z.array(blocker),
  records: z.number(),
  closedAt: z.string().nullable(),
  closedBy: someone.nullable(),
  reopenedAt: z.string().nullable(),
  reopenedBy: someone.nullable(),
  reopenReason: z.string().nullable(),
  note: z.string().nullable(),
})
export type LineDay = z.infer<typeof daySchema>

const dayRecord = daySchema.extend({
  history: z.array(z.object({ id: z.string(), change: z.enum(['CLOSED', 'REOPENED']), at: z.string(), by: someone.nullable(), reason: z.string().nullable() })),
  canClose: z.boolean(),
  canReopen: z.boolean(),
})
export type DayRecord = z.infer<typeof dayRecord>

export const labourDays = (api: ApiClient, scope: Scope, ask: { from: string | null; to: string | null; state: LineDayState | null }) =>
  api.get('/production/labour/days', { query: { ...where(scope), from: ask.from ?? undefined, to: ask.to ?? undefined, state: ask.state ?? undefined }, schema: z.object({ from: z.string(), to: z.string(), days: z.array(daySchema) }) })

const dayAnswer = z.object({ day: dayRecord })

export const labourDay = (api: ApiClient, lineId: string, workDate: string) => api.get(`/production/labour/days/${seg(lineId)}/${seg(workDate)}`, { schema: dayAnswer })

/** production.labour.close: refused in words while something holds it (409 `refusal/HELD`). */
export const closeDay = (api: ApiClient, lineId: string, workDate: string, body: { version?: number; note?: string }, key: string) =>
  api.post(`/production/labour/days/${seg(lineId)}/${seg(workDate)}/close`, { body, schema: dayAnswer, idempotencyKey: key })

/** production.labour.reopen: with the reason, kept on the record. */
export const reopenDay = (api: ApiClient, lineId: string, workDate: string, body: { version: number; reason: string }, key: string) =>
  api.post(`/production/labour/days/${seg(lineId)}/${seg(workDate)}/reopen`, { body, schema: dayAnswer, idempotencyKey: key })

// ---- the changes to labour records (MES-204) -------------------------------------------------------------------------------

const editRow = z.object({
  id: z.string(),
  kind: z.enum(EDIT_KINDS),
  at: z.string(),
  siteId: z.string(),
  line: place.nullable(),
  workDate: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  changes: z.array(change),
  by: someone.nullable(),
  reason: z.string().nullable(),
  disputeId: z.string().nullable(),
  named: z.boolean(),
})
export type LabourEdit = z.infer<typeof editRow>

export const labourEdits = (api: ApiClient, scope: Scope, ask: { from: string | null; to: string | null; kind: EditKind | null; limit: number }) =>
  api.get('/production/labour/edits', { query: { ...where(scope), from: ask.from ?? undefined, to: ask.to ?? undefined, kind: ask.kind ?? undefined, limit: ask.limit }, schema: z.object({ from: z.string(), to: z.string(), edits: z.array(editRow), more: z.boolean() }) })

// ---- one labour record (MES-201) ---------------------------------------------------------------------------------------------

const recordSchema = z.object({
  scanId: z.string(),
  state: z.enum(RECORD_STATES),
  siteId: z.string(),
  workDate: z.string(),
  at: z.string(),
  workOrder: workOrderRef,
  bundle: bundleRef,
  operation: operationRef.extend({ standardMinutes: z.string() }),
  line: place.nullable(),
  station: place.nullable(),
  reported: counts,
  counts,
  earnedMinutes: z.string(),
  steps: z.array(z.object({ scanId: z.string(), kind: z.enum(['CORRECTION', 'UNDO']), at: z.string(), counts, approvedBy: someone.nullable(), reason: z.string().nullable() })),
  worker: someone.nullable(),
  employeeId: z.string().nullable(),
  workerHidden: z.boolean(),
  enteredByLead: z.boolean(),
  disputes: z.array(z.object({ id: z.string(), status: z.string(), reason: z.enum(DISPUTE_REASONS).nullable(), raisedAt: z.string() })),
  correctionsWaiting: z.number(),
})
export type LabourRecord = z.infer<typeof recordSchema>

export const labourRecord = async (api: ApiClient, scanId: string) => (await api.get(`/production/labour/records/${seg(scanId)}`, { schema: z.object({ record: recordSchema }) })).record

// ---- a correction request (MES-096) --------------------------------------------------------------------------------------------

const correctionSchema = z.object({
  id: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REFUSED']),
  workOrderId: z.string(),
  bundleId: z.string(),
  scanId: z.string(),
  goodQuantity: z.number(),
  scrapQuantity: z.number(),
  reworkQuantity: z.number(),
  reason: z.string(),
  serverTime: z.string(),
  decisionNote: z.string().nullable(),
  bundleCode: z.string(),
  operation: operationRef,
  workOrder: z.object({ id: z.string(), number: z.string() }),
  recorded: z.object({ goodQuantity: z.number(), scrapQuantity: z.number(), reworkQuantity: z.number(), serverTime: z.string() }).nullable(),
  askedAt: place.nullable(),
})
export type CorrectionRequest = z.infer<typeof correctionSchema>

/** production.scan.correct: one request. The names its answer carries are not read: see this file's first comment. */
export const correctionRequest = async (api: ApiClient, id: string) => (await api.get(`/production/scans/corrections/${seg(id)}`, { schema: z.object({ request: correctionSchema }) })).request

/** "Approve adds a CORRECTION row; nothing is overwritten." */
export const approveCorrection = (api: ApiClient, id: string, key: string) => api.post(`/production/scans/corrections/${seg(id)}/approve`, { body: {}, schema: z.object({ request: z.object({ id: z.string() }) }), idempotencyKey: key })

export const refuseCorrection = (api: ApiClient, id: string, note: string, key: string) =>
  api.post(`/production/scans/corrections/${seg(id)}/refuse`, { body: { note }, schema: z.object({ request: z.object({ id: z.string() }) }), idempotencyKey: key })

const aroundRow = z.object({
  id: z.string(),
  kind: z.string(),
  operation: operationRef,
  goodQuantity: z.number(),
  scrapQuantity: z.number(),
  reworkQuantity: z.number(),
  serverTime: z.string(),
  station: place.nullable(),
  voidedById: z.string().nullable(),
})
export type AroundScan = z.infer<typeof aroundRow>

/** workorders.view: the bundle's scans, for context. No person: `worker` is not read (a list). */
export const scansAround = async (api: ApiClient, workOrderId: string, bundleId: string) =>
  (await api.get(`/production/scans/work-orders/${seg(workOrderId)}/scans`, { query: { bundleId }, schema: z.object({ scans: z.array(aroundRow) }) })).scans

// ---- a dispute (MES-206) -------------------------------------------------------------------------------------------------------

const disputeSchema = z.object({
  id: z.string(),
  version: z.number(),
  siteId: z.string(),
  line: place.nullable(),
  workDate: z.string(),
  recordType: z.enum(DISPUTE_RECORD_TYPES),
  recordId: z.string(),
  reason: z.enum(DISPUTE_REASONS).nullable(),
  words: z.string(),
  status: z.enum(['OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN']),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredBy: someone.nullable(),
  withdrawnAt: z.string().nullable(),
  raisedAt: z.string(),
  raisedOn: z.enum(['FLOOR', 'OFFICE']),
  worker: someone.nullable(),
  employeeId: z.string().nullable(),
  workerHidden: z.boolean(),
  record: z
    .object({
      label: z.string(),
      counts: counts.nullable(),
      code: z.string().nullable(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      minutes: z.number().nullable(),
      status: z.string().nullable(),
      version: z.number().nullable(),
    })
    .nullable(),
  edits: z.array(z.object({ id: z.string(), at: z.string(), by: someone.nullable(), reason: z.string(), changes: z.array(change) })),
  canAnswer: z.boolean(),
  own: z.boolean(),
})
export type Dispute = z.infer<typeof disputeSchema>

const disputeAnswer = z.object({ dispute: disputeSchema })

export const labourDispute = async (api: ApiClient, id: string) => (await api.get(`/production/labour/disputes/${seg(id)}`, { schema: disputeAnswer })).dispute

export interface AnswerBody {
  version: number
  outcome: DisputeOutcome
  answer: string
  correction?: { version: number; codeId?: string; startedAt?: string; endedAt?: string }
}

export const answerDispute = (api: ApiClient, id: string, body: AnswerBody, key: string) => api.post(`/production/labour/disputes/${seg(id)}/answer`, { body, schema: disputeAnswer, idempotencyKey: key })

// ---- off-standard blocks (MES-157) ---------------------------------------------------------------------------------------------

const codeWords = { labelIt: z.string(), labelEn: z.string(), labelI18n: z.record(z.string(), z.string()) }
const blockSchema = z.object({
  id: z.string(),
  version: z.number(),
  siteId: z.string(),
  line: place.nullable(),
  station: place.nullable(),
  code: z.object({ id: z.string(), code: z.string(), kind: z.string(), ...codeWords }),
  source: z.string(),
  status: z.string(),
  workDate: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  minutes: z.number(),
  named: z.boolean(),
  unusual: z.array(z.string()),
  worker: someone.nullable(),
  workerHidden: z.boolean(),
  note: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: someone.nullable(),
  approvedByHidden: z.boolean(),
  rejectedAt: z.string().nullable(),
  rejectedBy: someone.nullable(),
  rejectedByHidden: z.boolean(),
  rejectReason: z.string().nullable(),
  edits: z.array(z.object({ id: z.string(), at: z.string(), by: someone.nullable(), reason: z.string() })),
  canDecide: z.boolean(),
  own: z.boolean(),
})
export type BlockRecord = z.infer<typeof blockSchema>

const blockAnswer = z.object({ block: blockSchema })

export const offStandardBlock = async (api: ApiClient, id: string) => (await api.get(`/production/offstandard/blocks/${seg(id)}`, { schema: blockAnswer })).block
export const approveBlock = (api: ApiClient, id: string, version: number, key: string) => api.post(`/production/offstandard/blocks/${seg(id)}/approve`, { body: { version }, schema: blockAnswer, idempotencyKey: key })
export const rejectBlock = (api: ApiClient, id: string, version: number, reason: string, key: string) => api.post(`/production/offstandard/blocks/${seg(id)}/reject`, { body: { version, reason }, schema: blockAnswer, idempotencyKey: key })

const blockCounts = z.object({ pending: z.number(), normal: z.number(), unusual: z.number(), running: z.number() })
export type BlockCounts = z.infer<typeof blockCounts>

/** production.offstandard.view: how many wait, and how many of them may be approved together. */
export const offStandardCounts = (api: ApiClient, scope: Scope) => api.get('/production/offstandard/counts', { query: where(scope), schema: blockCounts })

/** The blocks "Approve N normal blocks" reaches when nothing is selected (at most `limit`, oldest first). */
export const normalBlocks = async (api: ApiClient, scope: Scope, limit: number) =>
  (await api.get('/production/offstandard/blocks', { query: { ...where(scope), normal: 'true', limit }, schema: z.object({ blocks: z.array(z.object({ id: z.string(), version: z.number() })) }) })).blocks

const bulkAnswer = z.object({ approved: z.array(z.string()), skipped: z.array(z.object({ id: z.string(), code: z.string(), unusual: z.array(z.string()) })) })
export type BulkAnswer = z.infer<typeof bulkAnswer>

/** The normal blocks at the versions read; the API leaves out the rest and says why (`skipped`). */
export const approveBlocks = (api: ApiClient, blocks: ReadonlyArray<{ id: string; version: number }>, key: string) =>
  api.post('/production/offstandard/blocks/approve', { body: { blocks }, schema: bulkAnswer, idempotencyKey: key })

const codeSchema = z.object({ id: z.string(), code: z.string(), kind: z.string(), active: z.boolean(), ...codeWords })
export type OffStandardCode = z.infer<typeof codeSchema>

/** The codes' words, and what a dispute's correction may pick (production.offstandard.view). */
export const offStandardCodes = async (api: ApiClient) => (await api.get('/production/offstandard/codes', { schema: z.object({ codes: z.array(codeSchema) }) })).codes

// ---- the daily sheet (MES-202) ---------------------------------------------------------------------------------------------------

const sheetSchema = z.object({
  person: z.object({ employeeId: z.string(), name: z.string() }),
  siteId: z.string(),
  workDate: z.string(),
  as: z.enum(FIGURE_ACCESS),
  sheet: z.object({
    pieces: counts,
    records: z.number(),
    productionMinutes: z.string(),
    offStandard: z.object({ minutes: z.number(), byCode: z.array(z.object({ codeId: z.string(), code: z.string(), kind: z.string(), minutes: z.number(), blocks: z.number() })) }),
    attendance: z.object({ status: z.string(), presentMinutes: z.number(), breakMinutes: z.number(), ordinaryMinutes: z.number(), overtimeMinutes: z.number(), absenceMinutes: z.number() }).nullable(),
    exceptions: z.array(z.object({ kind: z.enum(SHEET_EXCEPTIONS), count: z.number() })),
  }),
  records: z.array(z.object({ scanId: z.string(), at: z.string(), workOrder: workOrderRef, bundle: bundleRef, operation: operationRef, line: place.nullable(), state: z.enum(RECORD_STATES), counts, earnedMinutes: z.string() })),
  edits: z.array(z.object({ id: z.string(), at: z.string(), recordType: z.string(), changes: z.array(change), reason: z.string() })),
  attendanceShown: z.boolean(),
})
export type DailySheet = z.infer<typeof sheetSchema>

/** One person's day. The opening is the command: written down (who, whose, why), then answered. Nothing is kept here. */
export const openSheet = (api: ApiClient, body: { employeeId: string; workDate: string; reason?: OpenReason; note?: string }, key: string) =>
  api.post('/production/labour/sheets', { body, schema: sheetSchema, idempotencyKey: key })

const accessSchema = z.object({ allowed: z.boolean(), as: z.enum(FIGURE_ACCESS).nullable(), refusal: z.enum(FIGURE_REFUSALS).nullable(), needsReason: z.boolean() })
export type FigureAccess = z.infer<typeof accessSchema>

/** people.figures.view: may this person open that day, and must they say why? Asked before the sheet opens. */
export const figureAccess = (api: ApiClient, employeeId: string) => api.get(`/people/privacy/figures/${seg(employeeId)}/access`, { query: { purpose: 'PERFORMANCE' }, schema: accessSchema })

const personHit = z.object({ id: z.string(), displayName: z.string(), employeeCode: z.string().nullable() })
export type PersonHit = z.infer<typeof personHit>

/** people.view: the name search that opens ONE person's day (the same read as the People register's search). */
export const findPeople = async (api: ApiClient, siteId: string | null, q: string) =>
  (await api.get('/people/employees', { query: { siteId: siteId ?? undefined, q, limit: 20 }, schema: z.object({ employees: z.array(personHit) }) })).employees

export { OPEN_REASONS, type OpenReason }
