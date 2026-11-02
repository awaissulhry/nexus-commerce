import { z } from 'zod'
import { FLOOR_TONES } from '@nexus/factory-domain/auth/floor/literacy'
import { CONFLICT_DECISIONS } from '@nexus/factory-domain/floor-sync/conflicts/rules'
import { CALL_KINDS, CALL_STATUSES } from '@nexus/factory-domain/production/calls/rules'
import { HANDOVER_TOPICS } from '@nexus/factory-domain/production/dispatch/handover'
import type { ApiClient } from '../../../lib/api/client'
import { boardSchema, type LineBoard } from '../../../lib/line-board/schema'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * The Line view's calls (B-W2b-70 on the API of B-W2b-35, -49, -50, -52, -53, -29, -47; design floor.supervisor SCR-168):
 * the line's numbers and stations (`GET /production/boards/tv`), its open calls (`GET /production/calls/board`), the
 * stations' Reassign and "nobody signed in" (`GET /production/dispatch/floor/line`), what waits for the team leader
 * (scrap over the limit, off-standard blocks, sync conflicts), the handover notes and scan on behalf. Line totals only: no
 * output per station, no figure per person, no money (Owner answer F2). Each answer is checked against the fields the
 * screen reads. Answering a call, a handover note and an entry on behalf may queue (the container's `queue.enqueue`); a
 * decision signed with the PIN and a reassign need the network.
 */

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const look = z.object({ icon: z.string(), tone: z.enum(FLOOR_TONES) })

// ---- the line's open calls --------------------------------------------------------------------------------------------

const lineCall = z.object({
  id: z.string(),
  version: z.number(),
  status: z.enum(CALL_STATUSES),
  type: z.object({ id: z.string(), code: z.string(), kind: z.enum(CALL_KINDS), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() }),
  station: place,
  sentAt: z.string(),
})
export type LineCall = z.infer<typeof lineCall>

const callsBoard = z.object({ line: place, calls: z.array(lineCall), canAnswer: z.boolean() })
export type CallsBoard = z.infer<typeof callsBoard>

// ---- the stations' Reassign and who is signed in --------------------------------------------------------------------------

const reassignRow = z.object({ assignmentId: z.string(), version: z.number(), workOrder: z.object({ number: z.string() }).nullable(), operation: z.object({ seq: z.number(), name: z.string() }).nullable() })
export type ReassignRow = z.infer<typeof reassignRow>

const floorLine = z.object({
  line: place,
  day: z.string(),
  asOf: z.string(),
  shift: z.string(),
  stations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), signedIn: z.boolean(), reassign: z.array(reassignRow) })),
  mayManage: z.boolean(),
  mayWriteHandover: z.boolean(),
})
export type FloorLine = z.infer<typeof floorLine>

// ---- waiting for you ----------------------------------------------------------------------------------------------------

const scrapReason = z.object({ code: z.string(), quantity: z.number(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() })
const scrapRow = z.object({
  scanId: z.string(),
  at: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  bundle: z.object({ id: z.string(), code: z.string() }),
  operation: z.object({ seq: z.number(), name: z.string() }),
  station: z.object({ id: z.string(), code: z.string() }).nullable(),
  line: z.object({ id: z.string(), code: z.string() }).nullable(),
  goodQuantity: z.number(),
  scrapQuantity: z.number(),
  reworkQuantity: z.number(),
  reasons: z.array(scrapReason),
  approval: z.object({ limit: z.number().nullable() }),
  own: z.boolean(),
})
export type ScrapRow = z.infer<typeof scrapRow>
const refusalTile = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type RefusalTile = z.infer<typeof refusalTile>
const scrapWaiting = z.object({ rows: z.array(scrapRow), refusalTiles: z.array(refusalTile) })
export type ScrapWaiting = z.infer<typeof scrapWaiting>

const blockRow = z.object({
  id: z.string(),
  version: z.number(),
  line: place.nullable(),
  station: place.nullable(),
  code: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() }).passthrough(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  minutes: z.number(),
  own: z.boolean(),
})
export type BlockRow = z.infer<typeof blockRow>
const blocksAnswer = z.object({ blocks: z.array(blockRow) })

const counts = { good: z.number(), scrap: z.number(), rework: z.number() }
const side = z.object({ deviceName: z.string().nullable(), station: place.nullable(), serverTime: z.string(), ...counts })
const conflict = z.object({
  id: z.string(),
  state: z.enum(['OPEN', 'WITH_OFFICE']),
  workOrder: z.object({ number: z.string() }),
  bundle: z.object({ code: z.string() }),
  operation: z.object({ seq: z.number(), name: z.string() }),
  refused: side,
  recorded: side.extend({ corrected: z.boolean() }),
  version: z.number(),
})
export type Conflict = z.infer<typeof conflict>
const decisions = z.array(z.object({ decision: z.enum(CONFLICT_DECISIONS), look, signs: z.boolean(), reasons: z.array(z.object({ code: z.string(), look })) }))
export type ConflictDecisions = z.infer<typeof decisions>
const conflicts = z.object({ conflicts: z.array(conflict), decisions })
export type Conflicts = z.infer<typeof conflicts>

// ---- reads --------------------------------------------------------------------------------------------------------------

export const readBoard = (api: ApiClient): Promise<TaskOutcome<LineBoard>> => floorRead(api, '/production/boards/tv', { schema: boardSchema })
export const readCalls = (api: ApiClient): Promise<TaskOutcome<CallsBoard>> => floorRead(api, '/production/calls/board', { schema: callsBoard })
export const readFloorLine = (api: ApiClient): Promise<TaskOutcome<FloorLine>> => floorRead(api, '/production/dispatch/floor/line', { schema: floorLine })
export const readScrap = (api: ApiClient): Promise<TaskOutcome<ScrapWaiting>> => floorRead(api, '/production/scrap/floor/waiting', { schema: scrapWaiting })
export const readBlocks = (api: ApiClient): Promise<TaskOutcome<z.infer<typeof blocksAnswer>>> => floorRead(api, '/production/offstandard/floor/lead', { schema: blocksAnswer })
export const readConflicts = (api: ApiClient): Promise<TaskOutcome<Conflicts>> => floorRead(api, '/floor/sync/conflicts', { schema: conflicts })

// ---- decisions (the PIN: 403 `stepUp` until it is proved, then the same act with the same key) ---------------------------

const anything = z.unknown()

export const approveScrap = (api: ApiClient, row: Pick<ScrapRow, 'scanId'>, key: string) => floorWrite(api, 'POST', `/production/scrap/floor/waiting/${seg(row.scanId)}/approve`, { body: {}, schema: anything, idempotencyKey: key })
export const refuseScrap = (api: ApiClient, row: Pick<ScrapRow, 'scanId'>, reason: string, note: string | null, key: string) =>
  floorWrite(api, 'POST', `/production/scrap/floor/waiting/${seg(row.scanId)}/refuse`, { body: { reason, ...(note ? { note } : {}) }, schema: anything, idempotencyKey: key })
export const approveBlock = (api: ApiClient, row: Pick<BlockRow, 'id' | 'version'>, key: string) => floorWrite(api, 'POST', `/production/offstandard/floor/lead/${seg(row.id)}/approve`, { body: { version: row.version }, schema: anything, idempotencyKey: key })
export const rejectBlock = (api: ApiClient, row: Pick<BlockRow, 'id' | 'version'>, reason: string, key: string) =>
  floorWrite(api, 'POST', `/production/offstandard/floor/lead/${seg(row.id)}/reject`, { body: { version: row.version, reason }, schema: anything, idempotencyKey: key })
export const decideConflict = (api: ApiClient, row: Pick<Conflict, 'id' | 'version'>, decision: ConflictDecisions[number]['decision'], reason: string, key: string) =>
  floorWrite(api, 'POST', `/floor/sync/conflicts/${seg(row.id)}/decide`, { body: { decision, reason, version: row.version }, schema: anything, idempotencyKey: key })

// ---- reassign: the picker names people only here, with no figure --------------------------------------------------------------

const operators = z.object({
  clockedOnly: z.boolean(),
  operators: z.array(z.object({ workerId: z.string(), name: z.string(), levelLabel: z.string().nullable(), decision: z.enum(['ALLOW', 'WARN', 'HOLD']), overridable: z.boolean(), words: z.string().nullable() })),
})
export type Operators = z.infer<typeof operators>
export type Operator = Operators['operators'][number]

export const readOperators = (api: ApiClient, assignmentId: string): Promise<TaskOutcome<Operators>> => floorRead(api, '/production/dispatch/operators', { query: { assignmentId }, schema: operators })
export const reassign = (api: ApiClient, row: Pick<ReassignRow, 'assignmentId' | 'version'>, workerId: string, overrideReason: string | null, key: string) =>
  floorWrite(api, 'POST', `/production/dispatch/assignments/${seg(row.assignmentId)}/reassign`, { body: { version: row.version, workerId, ...(overrideReason ? { overrideReason } : {}) }, schema: anything, idempotencyKey: key })

// ---- the handover note ----------------------------------------------------------------------------------------------------

const note = z.object({
  id: z.string(),
  shiftDate: z.string(),
  shiftLabel: z.string(),
  topics: z.array(z.object({ topic: z.enum(HANDOVER_TOPICS), labelIt: z.string(), labelEn: z.string() })),
  text: z.string().nullable(),
  writtenAt: z.string(),
  version: z.number(),
})
export type HandoverNote = z.infer<typeof note>
const handover = z.object({ day: z.string(), shift: z.string(), current: note.nullable(), notes: z.array(note), mayWrite: z.boolean() })
export type Handover = z.infer<typeof handover>

export const readHandover = (api: ApiClient, lineId: string): Promise<TaskOutcome<Handover>> => floorRead(api, '/production/dispatch/handover', { query: { lineId }, schema: handover })

// ---- scan on behalf ---------------------------------------------------------------------------------------------------------

const behalfOptions = z.object({
  subject: z.enum(['WORKER', 'STATION']),
  stations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), lineId: z.string().nullable() })),
  people: z.array(z.object({ id: z.string(), name: z.string() })),
  reasons: z.array(z.object({ code: z.string(), label: z.object({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
})
export type BehalfOptions = z.infer<typeof behalfOptions>

const scanAnswer = z.object({ scan: z.object({ id: z.string() }), replayed: z.boolean() })
export type EnteredScan = z.infer<typeof scanAnswer>

export const readBehalfOptions = (api: ApiClient): Promise<TaskOutcome<BehalfOptions>> => floorRead(api, '/production/on-behalf/options', { schema: behalfOptions })
export const reportOnBehalf = (api: ApiClient, body: Readonly<Record<string, unknown>>, key: string): Promise<TaskOutcome<EnteredScan>> => floorWrite(api, 'POST', '/production/on-behalf/report', { body, schema: scanAnswer, idempotencyKey: key })
export const overrideOnBehalf = (api: ApiClient, body: Readonly<Record<string, unknown>>, key: string): Promise<TaskOutcome<EnteredScan>> => floorWrite(api, 'POST', '/production/on-behalf/override', { body, schema: scanAnswer, idempotencyKey: key })
export const undoEntry = (api: ApiClient, scanId: string, clientScanId: string, key: string) => floorWrite(api, 'POST', `/production/scans/${seg(scanId)}/undo`, { body: { clientScanId }, schema: anything, idempotencyKey: key })
