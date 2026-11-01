import { z } from 'zod'
import { CALL_KINDS, CALL_STATUSES, CALL_TILES, CALL_VIEWS, OUTCOME_TYPES, type CallKind, type CallTile, type CallView } from '@nexus/factory-domain/production/calls/rules'
import { JOB_TYPES, PRIORITIES, MACHINE_STATUSES } from '@nexus/factory-domain/plant/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Production › Floor control › Help calls (B-W2b-58; SCR-142): every call of the page, each answer checked by its schema
 * (zod drops what the page does not read). The shapes mirror apps/factory-api modules/production/calls/contract.ts
 * (B-W2b-35): the inbox (`GET /production/calls`), the tiles (`…/counts`), the day by the hour (`…/by-hour`), one call
 * (`…/:id`), the responder's steps (`…/seen | on-the-way | solve | cancel`), what a call led to (`…/outcome`), the types
 * with who answers them (`…/types`). For "Open a maintenance job": the machines at the call's station (`GET
 * /plant/machines?stationId=`, plant.view) and a new job (`POST /plant/jobs`, plant.jobs.manage). No money, and nothing
 * by person: response times are a call's, a type's and a line's (Statuto dei Lavoratori art. 4; Owner answers W1, F2).
 */

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const person = z.object({ kind: z.enum(['USER', 'WORKER']), name: z.string().nullable() })
const typeWords = { labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() }

export const callSchema = z.object({
  id: z.string(),
  version: z.number(),
  siteId: z.string(),
  status: z.enum(CALL_STATUSES),
  open: z.boolean(),
  type: z.object({ id: z.string(), code: z.string(), kind: z.enum(CALL_KINDS), ...typeWords }),
  station: place,
  line: place.nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  bundle: z.object({ id: z.string(), code: z.string() }).nullable(),
  responderTeam: place.nullable(),
  note: z.string().nullable(),
  sentAt: z.string(),
  seenAt: z.string().nullable(),
  onTheWayAt: z.string().nullable(),
  solvedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  openSeconds: z.number().nullable(),
  times: z.object({ responseSeconds: z.number().nullable(), onTheWaySeconds: z.number().nullable(), resolveSeconds: z.number().nullable() }),
  seenBy: person.nullable(),
  resolutionCode: z.string().nullable(),
  outcome: z.object({ recordType: z.string(), recordId: z.string() }).nullable(),
  waitingBooked: z.boolean(),
})
export type Call = z.infer<typeof callSchema>
export type Person = z.infer<typeof person>

const step = z.enum(['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED'])
export const callRecordSchema = callSchema.extend({
  caller: person.nullable(),
  timeline: z.array(z.object({ step, at: z.string(), by: person.nullable() })),
  coming: z.object({ step: z.enum(['SEEN', 'ON_THE_WAY']), by: person.nullable(), team: place.nullable() }).nullable(),
  resolutionNote: z.string().nullable(),
  waiting: z.object({ blockId: z.string(), code: z.string(), status: z.string(), startedAt: z.string(), endedAt: z.string().nullable() }).nullable(),
  bookWaiting: z.boolean(),
})
export type CallRecord = z.infer<typeof callRecordSchema>

const recordAnswer = z.object({ call: callRecordSchema, canAnswer: z.boolean(), canNameOutcome: z.boolean() })
export type CallRecordAnswer = z.infer<typeof recordAnswer>

export const countsSchema = z.object({
  tiles: z.object({ OPEN: z.number(), WAITING: z.number(), ANSWERED_TODAY: z.number() }),
  medianResponseSeconds: z.number().nullable(),
  waitingMinutes: z.number(),
})
export type CallCounts = z.infer<typeof countsSchema>

export const byHourSchema = z.object({
  date: z.string(),
  timeZone: z.string(),
  hours: z.array(z.object({ hour: z.number(), calls: z.number(), byKind: z.record(z.string(), z.number()), byLine: z.array(z.object({ lineId: z.string().nullable(), count: z.number() })) })),
  byKind: z.array(z.object({ kind: z.enum(CALL_KINDS), calls: z.number(), answered: z.number(), medianResponseSeconds: z.number().nullable() })),
  lines: z.array(place),
})
export type CallsByHour = z.infer<typeof byHourSchema>

export const typeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  code: z.string(),
  kind: z.enum(CALL_KINDS),
  ...typeWords,
  codeListed: z.boolean(),
  responder: z.object({
    kind: z.enum(['TEAM', 'TEAM_LEADERS']),
    team: z.object({ id: z.string(), code: z.string(), name: z.string(), active: z.boolean() }).nullable(),
    members: z.number(),
  }),
  escalateAfterMinutes: z.number().nullable(),
  waitingCode: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }).nullable(),
  sortOrder: z.number(),
  active: z.boolean(),
  version: z.number(),
  usedCount: z.number(),
  openCount: z.number(),
})
export type CallType = z.infer<typeof typeSchema>

const typesSchema = z.object({ site: place, types: z.array(typeSchema), canManage: z.boolean() })
export type CallTypes = z.infer<typeof typesSchema>

const seg = (value: string) => encodeURIComponent(value)

export interface ListAsk {
  readonly siteId: string | null
  readonly view: CallView
  readonly tile: CallTile | null
  readonly kind: CallKind | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** The inbox: the open calls oldest first (`view=open`), or the closed / every call newest first; 50 a page. */
export const listCalls = (api: ApiClient, ask: ListAsk, signal?: AbortSignal) =>
  api.get('/production/calls', {
    query: { siteId: ask.siteId ?? undefined, view: ask.view, tile: ask.tile ?? undefined, kind: ask.kind ?? undefined, cursor: ask.cursor ?? undefined, limit: ask.limit ?? 50 },
    schema: z.object({ calls: z.array(callSchema), nextCursor: z.string().nullable() }),
    signal,
  })

/** The tiles: open, waiting over 5 minutes, answered today, and today's median response time (per site; never per person). */
export const callCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/production/calls/counts', { query: { siteId: siteId ?? undefined }, schema: countsSchema, signal })

/** One site's day: calls per hour by kind and line, each kind's median response time. */
export const callsByHour = (api: ApiClient, siteId: string, date?: string, signal?: AbortSignal) => api.get('/production/calls/by-hour', { query: { siteId, date: date ?? undefined }, schema: byHourSchema, signal })

/** One call: its timeline, who took each step (the caller only where the site names workers), what it led to. */
export const getCall = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/production/calls/${seg(id)}`, { schema: recordAnswer, signal })

const answer = z.object({ call: callRecordSchema, replayed: z.boolean() })

/** production.calls.answer: "I have seen it" (Acknowledge). */
export const seeCall = (api: ApiClient, call: Pick<Call, 'id' | 'version'>, key = newIdempotencyKey()) =>
  api.post(`/production/calls/${seg(call.id)}/seen`, { body: { version: call.version }, schema: answer, idempotencyKey: key })

/** production.calls.answer: "On my way" (marks an unseen call seen at the same moment). */
export const comeToCall = (api: ApiClient, call: Pick<Call, 'id' | 'version'>, key = newIdempotencyKey()) =>
  api.post(`/production/calls/${seg(call.id)}/on-the-way`, { body: { version: call.version }, schema: answer, idempotencyKey: key })

/** production.calls.answer: solved, with how (a code) and words. */
export const solveCall = (api: ApiClient, call: Pick<Call, 'id' | 'version'>, body: { resolutionCode?: string; resolutionNote?: string }, key = newIdempotencyKey()) =>
  api.post(`/production/calls/${seg(call.id)}/solve`, { body: { version: call.version, ...body }, schema: answer, idempotencyKey: key })

/** production.calls.answer: cancelled, with the reason (kept on the audit row). */
export const cancelCall = (api: ApiClient, call: Pick<Call, 'id' | 'version'>, reason: string, key = newIdempotencyKey()) =>
  api.post(`/production/calls/${seg(call.id)}/cancel`, { body: { version: call.version, reason }, schema: answer, idempotencyKey: key })

export type OutcomeType = (typeof OUTCOME_TYPES)[number]

/** production.calls.answer: what the call led to (named once). */
export const nameOutcome = (api: ApiClient, call: Pick<Call, 'id' | 'version'>, outcome: { recordType: OutcomeType; recordId: string }, key = newIdempotencyKey()) =>
  api.post(`/production/calls/${seg(call.id)}/outcome`, { body: { version: call.version, ...outcome }, schema: answer, idempotencyKey: key })

/** "Who is called": the site's types with their responder group and its members count (production.calls.view). */
export const listTypes = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/production/calls/types', { query: { siteId }, schema: typesSchema, signal })

// ---- Open a maintenance job (plant.jobs) ---------------------------------------------------------------------------------------

export const machineSchema = z.object({
  id: z.string(),
  assetNumber: z.string(),
  status: z.enum(MACHINE_STATUSES),
  class: z.object({ labelIt: z.string(), labelEn: z.string() }),
  make: z.string().nullable(),
  modelName: z.string().nullable(),
  openJobs: z.number(),
})
export type StationMachine = z.infer<typeof machineSchema>

/** The machines placed at the call's station (plant.view). */
export const machinesAt = async (api: ApiClient, siteId: string, stationId: string, signal?: AbortSignal) =>
  (await api.get('/plant/machines', { query: { siteId, stationId, limit: 20 }, schema: z.object({ machines: z.array(machineSchema) }), signal })).machines

export type JobType = (typeof JOB_TYPES)[number]
export type JobPriority = (typeof PRIORITIES)[number]

const jobSchema = z.object({ id: z.string(), number: z.string() })
export type MadeJob = z.infer<typeof jobSchema>

/** plant.jobs.manage: a maintenance job for the machine, with the problem in words. */
export const makeJob = async (api: ApiClient, body: { machineId: string; type: JobType; problem: string; priority: JobPriority }, key: string) =>
  (await api.post('/plant/jobs', { body, schema: z.object({ job: jobSchema }), idempotencyKey: key })).job

export { CALL_KINDS, CALL_TILES, CALL_VIEWS }
