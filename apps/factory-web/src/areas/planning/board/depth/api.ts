import { z } from 'zod'
import { SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import { SKIP_CODES } from '@nexus/factory-domain/planning/schedule/refusals'
import { SCHEDULE_LANE_KINDS } from '@nexus/factory-domain/planning/schedule/slots'
import { KEPT_CODES, MOVE_WHYS } from '@nexus/factory-domain/planning/schedule-depth/forward'
import { MATERIAL_START_STATES } from '@nexus/factory-domain/planning/schedule-depth/material'
import { WHAT_IF_CONFLICTS, WHAT_IF_MOVE_KINDS } from '@nexus/factory-domain/planning/schedule-depth/whatif'
import { CHANGE_KINDS, UNDO_HOLDS } from '@nexus/factory-domain/planning/schedule-log/changes'
import { WARNING_CODES } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { VERSION_COMPARE_STATES } from '@nexus/factory-domain/planning/schedule-log/compare'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { floorView, materialStartView } from '../api'

/**
 * The W2b calls of the planning board (SCR-122; B-W2b-337 on the API of B-W2b-312 scheduling in depth, B-W2b-329 the board's
 * record and B-W2b-321 work to subcontractors; apps/factory-api modules/planning/schedule-depth, schedule-log and
 * subcontract-capacity contract.ts), the answers' shapes checked with zod (unknown fields dropped, so a new API field never
 * breaks the page): pins, the material check of a drop, the backlog reschedule, the private what-if, the change log and its
 * undo, the day sheets, a published version read-only and the workshop's kit timing at a day. The API's English (`words`, a
 * 409's message) is never drawn: the screen says its own words from codes and facts (depth/model.ts). No money anywhere;
 * per line, work centre, workshop and work order; a planner's name only inside one change of the log.
 */

const laneRef = z.object({ kind: z.enum(SCHEDULE_LANE_KINDS), id: z.string() })
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const site = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const seg = encodeURIComponent

// ---- pins (PLN-139) ------------------------------------------------------------------------------------------------------

const pinnedSlot = z.object({ id: z.string(), version: z.number(), pinned: z.boolean().optional() })

/** P on a bar: pin it where it is, or unpin it (the slot's version as read: 409 "moved by … at …"). */
export function pinSlot(api: ApiClient, slotId: string, body: { version: number; pinned: boolean }): Promise<{ slot: { id: string; version: number }; planVersion: number }> {
  return api.post(`/planning/schedule/slots/${seg(slotId)}/pin`, { body, schema: z.object({ slot: pinnedSlot, planVersion: z.number(), replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}

/** Every bar of a work order pinned (or unpinned) at once. */
export function pinWorkOrder(api: ApiClient, workOrderId: string, body: { pinned: boolean; planVersion?: number }): Promise<{ changed: number; planVersion: number }> {
  return api.post(`/planning/schedule/work-orders/${seg(workOrderId)}/pin`, {
    body,
    schema: z.object({ workOrderId: z.string(), pinned: z.boolean(), changed: z.number(), slots: z.array(pinnedSlot), planVersion: z.number(), replayed: z.boolean() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

// ---- the material check of a drop (PLN-134) -------------------------------------------------------------------------------

const materialCheck = z.object({ state: z.enum(MATERIAL_START_STATES), startAt: z.string(), inTime: z.boolean(), earliestStart: z.string().nullable(), snapTo: z.string().nullable() })
export type MaterialCheck = z.infer<typeof materialCheck>
const materialSchema = z.object({ workOrder: z.object({ id: z.string(), number: z.string() }), materialStart: materialStartView, check: materialCheck.nullable() })
export type MaterialAnswer = z.infer<typeof materialSchema>

/** A drop being tried against the work order's material: in time, or where to snap it ("Snap to 15 Nov"). Never refused. */
export function getMaterial(api: ApiClient, workOrderId: string, query: { startAt: string; laneKind: string; laneId: string }, signal?: AbortSignal): Promise<MaterialAnswer> {
  return api.get(`/planning/schedule/work-orders/${seg(workOrderId)}/material`, { query, schema: materialSchema, signal })
}

// ---- the backlog reschedule (PLN-141) ------------------------------------------------------------------------------------

const span = z.object({ startAt: z.string(), endAt: z.string() })
const runSchema = z.object({
  planVersion: z.number().nullable(),
  applied: z.boolean(),
  moves: z.array(
    z.object({
      workOrderId: z.string(),
      number: z.string(),
      operationId: z.string(),
      operation: z.object({ seq: z.number(), code: z.string(), name: z.string() }),
      slotId: z.string().nullable(),
      lane: laneRef,
      from: span.nullable(),
      to: span,
      minutes: z.string(),
      why: z.enum(MOVE_WHYS),
      over: z.array(z.object({ lane: laneRef, date: z.string() })),
    }),
  ),
  orders: z.array(z.object({ workOrderId: z.string(), number: z.string(), dueDate: z.string().nullable(), finish: z.string().nullable(), daysLate: z.number().nullable(), moves: z.number() })),
  kept: z.array(z.object({ workOrderId: z.string(), operationId: z.string(), slotId: z.string().nullable(), code: z.enum(KEPT_CODES) })),
  skipped: z.array(z.object({ workOrderId: z.string(), operationId: z.string().nullable(), code: z.enum(SKIP_CODES) })),
  overbooked: z.number(),
})
export type BacklogRun = z.infer<typeof runSchema>

/** "Reschedule backlog": every unpinned bar left in the past to the first free time from now; the preview (apply false) first. */
export function rescheduleBacklog(api: ApiClient, body: { siteId: string; apply: boolean; version?: number; overloadReason?: string | null }): Promise<BacklogRun> {
  return api.post('/planning/schedule/reschedule-backlog', { body, schema: runSchema, ...(body.apply ? { idempotencyKey: newIdempotencyKey() } : {}) })
}

// ---- what-if (design sec:whatif) ---------------------------------------------------------------------------------------------

const placeView = z.object({ lane: laneRef, startAt: z.string(), endAt: z.string() })
const whatIfMove = z.object({
  kind: z.enum(WHAT_IF_MOVE_KINDS),
  slotId: z.string().nullable(),
  slotVersion: z.number().nullable(),
  workOrderId: z.string(),
  number: z.string(),
  operationId: z.string().nullable(),
  operation: z.object({ seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  from: placeView.nullable(),
  to: placeView.nullable(),
  conflict: z.object({ code: z.enum(WHAT_IF_CONFLICTS) }).nullable(),
  material: materialCheck.nullable(),
})
export type WhatIfMove = z.infer<typeof whatIfMove>
const orderTimes = z.object({ status: z.enum(SCHEDULE_STATUSES), plannedStart: z.string().nullable(), plannedFinish: z.string().nullable() })
const scenarioSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string().nullable(),
  status: z.enum(['DRAFT', 'APPLIED', 'DISCARDED']),
  version: z.number(),
  basedAt: z.string(),
  planChanged: z.boolean(),
  planVersion: z.number().nullable(),
  moves: z.array(whatIfMove),
  conflicts: z.number(),
  effect: z.object({
    lateOrders: z.object({ before: z.number(), after: z.number() }),
    overMinutes: z.object({ before: z.string(), after: z.string() }),
    window: z.object({ from: z.string(), to: z.string() }),
    lanes: z.array(z.object({ lane: laneRef, code: z.string(), name: z.string(), from: z.string(), to: z.string(), beforePct: z.string().nullable(), afterPct: z.string().nullable() })),
    orders: z.array(z.object({ workOrderId: z.string(), number: z.string(), before: orderTimes, after: orderTimes })),
  }),
})
export type WhatIf = z.infer<typeof scenarioSchema>
const scenarioAnswer = z.object({ site, asOf: z.string(), scenario: scenarioSchema, replayed: z.boolean() })

/** The planner's own drafts at the site (never another planner's: they are private). */
export async function listWhatIfs(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Array<{ id: string; status: string; updatedAt: string }>> {
  const answer = await api.get('/planning/schedule/what-ifs', { query: { siteId }, schema: z.object({ scenarios: z.array(z.object({ id: z.string(), status: z.string(), updatedAt: z.string() })) }), signal })
  return answer.scenarios
}

export async function createWhatIf(api: ApiClient, siteId: string): Promise<WhatIf> {
  return (await api.post('/planning/schedule/what-ifs', { body: { siteId }, schema: scenarioAnswer, idempotencyKey: newIdempotencyKey() })).scenario
}

export async function getWhatIf(api: ApiClient, scenarioId: string, signal?: AbortSignal): Promise<WhatIf> {
  return (await api.get(`/planning/schedule/what-ifs/${seg(scenarioId)}`, { schema: scenarioAnswer, signal })).scenario
}

/** A move tried in what-if as the API takes it (MOVE and REMOVE name the bar; PLACE the work order and operation). */
export interface WhatIfMoveInput {
  kind: 'MOVE' | 'PLACE' | 'REMOVE'
  slotId?: string
  workOrderId?: string
  operationId?: string
  lane?: { kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP'; id: string }
  startAt?: string
  /** Sent again unchanged (the end the API gave it), so the entry keeps the bar's version from its first try. */
  endAt?: string
}

/** Every move of the scenario, the WHOLE list each time (a bar tried again replaces its entry), with the scenario's version. */
export async function setWhatIfMoves(api: ApiClient, scenarioId: string, body: { version: number; moves: readonly WhatIfMoveInput[] }): Promise<WhatIf> {
  return (await api.request('PUT', `/planning/schedule/what-ifs/${seg(scenarioId)}/moves`, { body, schema: scenarioAnswer, idempotencyKey: newIdempotencyKey() })).scenario
}

const applySchema = z.object({ scenario: z.object({ id: z.string(), status: z.string(), version: z.number() }), applied: z.number(), skipped: z.array(z.object({ index: z.number(), code: z.enum(WHAT_IF_CONFLICTS) })), planVersion: z.number() })
export type WhatIfApplied = z.infer<typeof applySchema>

/** Apply to plan: ONE command (409 WHAT_IF_CONFLICTS lists `moves/<i>/<CODE>`; `skipConflicts` applies the rest). */
export function applyWhatIf(api: ApiClient, scenarioId: string, body: { version: number; overloadReason?: string | null; skipConflicts?: boolean }): Promise<WhatIfApplied> {
  return api.post(`/planning/schedule/what-ifs/${seg(scenarioId)}/apply`, { body, schema: applySchema, idempotencyKey: newIdempotencyKey() })
}

export function discardWhatIf(api: ApiClient, scenarioId: string, version: number): Promise<unknown> {
  return api.post(`/planning/schedule/what-ifs/${seg(scenarioId)}/discard`, { body: { version }, schema: z.object({ scenario: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: newIdempotencyKey() })
}

// ---- the change log and its undo (PLN-149, design sec:log) --------------------------------------------------------------------

const laneNamed = z.object({ kind: z.enum(SCHEDULE_LANE_KINDS), id: z.string(), code: z.string(), name: z.string() })
const changePlace = z.object({ lane: laneNamed, startAt: z.string(), endAt: z.string() })
export const changeEntry = z.object({
  id: z.string(),
  kind: z.enum(CHANGE_KINDS),
  changedAt: z.string(),
  changedBy: person,
  slotId: z.string().nullable(),
  onBoard: z.boolean(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  from: changePlace.nullable(),
  to: changePlace.nullable(),
  reason: z.string().nullable(),
  whatIfScenarioId: z.string().nullable(),
  publishedVersion: z.object({ id: z.string(), number: z.number() }).nullable(),
  undoes: z.object({ id: z.string(), kind: z.enum(CHANGE_KINDS) }).nullable(),
  undoneBy: z.object({ id: z.string(), changedAt: z.string(), changedBy: person }).nullable(),
  undo: z.object({ may: z.boolean(), code: z.enum(UNDO_HOLDS).nullable() }),
})
export type ChangeEntry = z.infer<typeof changeEntry>
const changesSchema = z.object({
  plan: z.object({ id: z.string().nullable(), version: z.number().nullable() }),
  since: z.object({ id: z.string(), number: z.number(), publishedAt: z.string() }).nullable(),
  entries: z.array(changeEntry),
  next: z.string().nullable(),
})
export type ChangesPage = z.infer<typeof changesSchema>

export interface ChangesQuery {
  siteId: string
  since?: 'PUBLISHED' | 'ALL'
  kinds?: readonly string[]
  changedById?: string | null
  slotId?: string
  cursor?: string | null
  limit?: number
}

/** The log newest first: by default the changes since the last published version ("No moves since v12"). */
export function getChanges(api: ApiClient, query: ChangesQuery, signal?: AbortSignal): Promise<ChangesPage> {
  return api.get('/planning/schedule/changes', {
    query: {
      siteId: query.siteId,
      since: query.since,
      kinds: query.kinds && query.kinds.length > 0 ? query.kinds.join(',') : undefined,
      changedById: query.changedById ?? undefined,
      slotId: query.slotId,
      cursor: query.cursor ?? undefined,
      limit: query.limit === undefined ? undefined : String(query.limit),
    },
    schema: changesSchema,
    signal,
  })
}

const undoSchema = z.object({ undo: changeEntry, undone: changeEntry, planVersion: z.number() })

/** Undo one change (it obeys the move's rules: a 409 OVERLOAD is kept with a reason, sent again). */
export function undoChange(api: ApiClient, changeId: string, overloadReason?: string | null): Promise<z.infer<typeof undoSchema>> {
  return api.post(`/planning/schedule/changes/${seg(changeId)}/undo`, { body: overloadReason ? { overloadReason } : {}, schema: undoSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- day sheets (PLN-154, design pop:print and tab:day-sheets) ------------------------------------------------------------------

export interface SheetQuery {
  siteId: string
  date: string
  lineIds: readonly string[]
  workCentreIds: readonly string[]
  plan: 'PUBLISHED' | 'WORKING'
  language: 'it' | 'en'
}

const paperSchema = z.object({
  language: z.enum(['it', 'en']),
  title: z.string(),
  columns: z.array(z.string()),
  sheets: z.array(z.object({ heading: z.string(), facts: z.array(z.object({ label: z.string(), value: z.string() })), banner: z.string().nullable(), rows: z.array(z.object({ rush: z.boolean(), pinned: z.boolean(), cells: z.array(z.string()) })), empty: z.string().nullable(), footer: z.string() })),
  foot: z.string(),
  pageLabel: z.string(),
  fileName: z.string(),
})
/** What the sheets say, in the language asked (the paper itself: printed for a line leader, so it carries the sheet's own words). */
export type DaySheetPaper = z.infer<typeof paperSchema>

const sheetQueryOf = (query: SheetQuery) => ({
  siteId: query.siteId,
  date: query.date,
  lineIds: query.lineIds.length > 0 ? query.lineIds.join(',') : undefined,
  workCentreIds: query.workCentreIds.length > 0 ? query.workCentreIds.join(',') : undefined,
  plan: query.plan,
  language: query.language,
})

export function getDaySheetPaper(api: ApiClient, query: SheetQuery, signal?: AbortSignal): Promise<DaySheetPaper> {
  return api.get('/planning/schedule/day-sheets/paper', { query: sheetQueryOf(query), schema: paperSchema, signal })
}

/** The day sheets as a PDF (A4 landscape, a page per lane), opened in a new tab by the page. */
export function getDaySheetPdf(api: ApiClient, query: SheetQuery): Promise<Uint8Array> {
  return api.bytes('/planning/schedule/day-sheets', { query: sheetQueryOf(query) })
}

// ---- a published version read-only (design tab:version) ------------------------------------------------------------------------

const versionSlot = z.object({
  id: z.string(),
  lane: laneRef,
  workOrderId: z.string(),
  operationId: z.string().nullable(),
  startAt: z.string(),
  endAt: z.string(),
  pieces: z.number().nullable(),
  minutes: z.string(),
  pinned: z.boolean().optional(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), rush: z.boolean(), dueDate: z.string().nullable(), style: z.object({ id: z.string(), code: z.string(), name: z.string() }) }),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  laneCode: z.string(),
  laneName: z.string(),
  floor: floorView.nullable(),
  working: z.object({ state: z.enum(VERSION_COMPARE_STATES), slot: z.object({ id: z.string(), lane: laneRef, startAt: z.string(), endAt: z.string() }).nullable() }),
})
export type VersionSlot = z.infer<typeof versionSlot>
const versionBoardSchema = z.object({
  site,
  asOf: z.string(),
  version: z.object({ id: z.string(), number: z.number(), coversFrom: z.string(), coversTo: z.string(), effectiveFrom: z.string(), publishedAt: z.string(), publishedBy: person, note: z.string().nullable() }),
  readOnly: z.literal(true),
  floor: z.enum(['CURRENT', 'UPCOMING', 'REPLACED']),
  lanes: z.array(laneNamed),
  slots: z.array(versionSlot),
  compare: z.object({ moved: z.number(), added: z.number(), removed: z.number(), addedSlots: z.array(z.object({ id: z.string(), workOrderId: z.string(), operationId: z.string().nullable(), lane: laneRef, startAt: z.string(), endAt: z.string() })) }),
})
export type VersionBoard = z.infer<typeof versionBoardSchema>

export function getVersionBoard(api: ApiClient, versionId: string, signal?: AbortSignal): Promise<VersionBoard> {
  return api.get(`/planning/schedule/versions/${seg(versionId)}/board`, { schema: versionBoardSchema, signal })
}

// ---- the kit timing at a day (B-W2b-321; design pop:subcontract-move "Kit ship-out date = start − transport days") ---------------

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const kitTimingSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), garments: z.number() }),
  workshop: named,
  operations: z.array(z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), workCentreKind: z.string() })),
  pieces: z.number(),
  start: z.string(),
  startSource: z.enum(['GIVEN', 'SCHEDULE', 'TODAY']),
  transportDays: z.number(),
  transportSource: z.enum(['WORKSHOP', 'DEFAULT']),
  kitShipOn: z.string(),
  kitDueAt: z.string(),
  late: z.boolean(),
  workDays: z.number(),
  workDaysSource: z.enum(['CAPACITY', 'ROUTING', 'DEFAULT']),
  backOn: z.string(),
  closedDaysSkipped: z.number(),
  kit: z.object({ note: z.string().nullable(), lines: z.array(z.object({ item: named, colour: z.object({ id: z.string(), code: z.string() }).nullable(), quantity: z.string(), uom: z.string() })) }),
  laterOperations: z.array(z.object({ id: z.string(), seq: z.number(), name: z.string(), earliestStart: z.string(), latestStart: z.string().nullable(), finishesLate: z.boolean() })),
  finishesLate: z.boolean(),
})

/** When the kit leaves for a workshop for ONE operation from a start day (the drop's day, else the schedule's). */
export function getKitTimingAt(api: ApiClient, workOrderId: string, query: { partyId: string; operationId: string; pieces?: number; start?: string | null }, signal?: AbortSignal) {
  return api.get(`/planning/work-orders/${seg(workOrderId)}/kit-timing`, {
    query: { partyId: query.partyId, operationIds: query.operationId, pieces: query.pieces === undefined ? undefined : String(query.pieces), start: query.start ?? undefined },
    schema: kitTimingSchema,
    signal,
  })
}

/** "Move to a subcontractor": the operation outside at the workshop (its DRAFT subcontract order with the kit planned), from a day. */
export type SendOutsideBody = { version: number; partyId: string; pieces?: number; start?: string }
export function sendOutsideAt(api: ApiClient, workOrderId: string, operationId: string, body: SendOutsideBody) {
  return api.request('POST', `/planning/work-orders/${seg(workOrderId)}/operations/${seg(operationId)}/outside`, {
    body,
    schema: z.object({
      operation: z.object({ id: z.string(), seq: z.number(), name: z.string(), version: z.number(), outsourced: z.boolean(), subcontractOrderId: z.string().nullable() }),
      workshop: named,
      order: z.object({ id: z.string(), number: z.string(), status: z.string(), kitDueAt: z.string() }).nullable(),
      orderWords: z.string().nullable(),
      timing: z.object({ start: z.string(), kitShipOn: z.string(), kitDueAt: z.string(), late: z.boolean(), backOn: z.string() }),
      warnings: z.array(z.object({ code: z.enum(WARNING_CODES), words: z.string() })),
    }),
    idempotencyKey: newIdempotencyKey(),
  })
}
