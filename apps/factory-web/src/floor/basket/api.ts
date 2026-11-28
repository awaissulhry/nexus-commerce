import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { putToStore, sha256Hex } from '../../record-panels/store'
import { presignedSchema } from '../../record-panels/api'
import { onlineFirst, type KeepsActions } from '../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../tasks/shared/task-api'

/**
 * owb-fl5 (order workflow build, S5 floor; design plan § 4.1–4.6, § 5zf B, § 5zg C) — the basket on a phone: the web's own shapes
 * of the server's basket reads and the calls the home, the basket page and the dock make. Built against the contract sketch of
 * `build/briefs/_owb-fl-common.md` § 3 "fl1" (server A builds the real contract at the same time): every field the screens read is
 * here, the rest is dropped. Fields this web added to the sketch (named in build/notes/owb-fl5.md): `picture.expiresAt` (optional),
 * `quality.steps` (the tick and photo steps of the quality check), `POST /floor/session/department` `stationId` (the second tap when
 * a department has several stations), the report answer's `moved`.
 *
 * Floor face only: the customer's CODE, never its name, no price; a worker's name never comes here.
 */

// ---- the shapes ----------------------------------------------------------------------------------------------------------------

/** A department as the base draws it (`lib/department` DepartmentAnswer; `GET /production/departments`'s row). */
export const departmentLookSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable().optional(),
  tone: z.string(),
  icon: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable().optional(),
})
export type DepartmentLook = z.infer<typeof departmentLookSchema>

/** The basket's picture: its order's picture stamped for this site (the floor never reads another file). `expiresAt`: added here. */
export const basketPictureSchema = z.object({ fileId: z.string(), src: z.string(), expiresAt: z.string().nullable().optional() })
export type BasketPicture = z.infer<typeof basketPictureSchema>

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  picture: z.object({ kind: z.string().nullable().optional(), icon: z.string().nullable().optional(), colour: z.string().nullable().optional() }).nullable().optional(),
})

export const STEP_STATES = ['DONE', 'HERE', 'NEXT', 'TODO', 'SKIPPED'] as const
export type StepState = (typeof STEP_STATES)[number]

const stepSchema = z.object({
  operationId: z.string(),
  seq: z.number(),
  name: z.string(),
  department: departmentLookSchema.nullable(),
  state: z.enum(STEP_STATES),
  added: z.boolean(),
})
export type BasketStep = z.infer<typeof stepSchema>

export const WORK_STATES = ['WAITING', 'WORKING', 'PAUSED'] as const
export type WorkState = (typeof WORK_STATES)[number]

/** A help call on the basket (a problem or an ask), as the floor reads it. */
const callFlagSchema = z.object({ callId: z.string(), typeCode: z.string(), state: z.string(), minutes: z.number(), escalated: z.boolean(), spot: z.number().int().nullable().optional() })
export type CallFlag = z.infer<typeof callFlagSchema>

const qualityStepSchema = z.object({
  code: z.string(),
  words: z.string(),
  icon: z.string().nullable().optional(),
  required: z.boolean(),
  /** The step is proved by a photo (QC photo route), not by a tick. */
  photo: z.boolean(),
  done: z.boolean(),
})
export type QualityStep = z.infer<typeof qualityStepSchema>

const basketSchema = z.object({
  id: z.string(),
  code: z.string(),
  quantity: z.number().int(),
  smallParts: z.boolean(),
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  salesOrderId: z.string().nullable(),
  customerCode: z.string(),
  due: z.string().nullable(),
  words: z.object({ size: z.string().nullable(), colour: z.string().nullable(), label: z.string().nullable(), leather: z.string().nullable() }),
  team: teamSchema.nullable(),
  rush: z.boolean(),
})

/** `GET /production/baskets/:code` (floor: production.scan at the device's site). A refusal comes with no basket. */
export const basketReadSchema = z.object({
  scanned: z.boolean().optional().default(false),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable().optional().default(null),
  basket: basketSchema.nullable().optional().default(null),
  picture: basketPictureSchema.nullable().optional().default(null),
  route: z.object({ own: z.boolean(), steps: z.array(stepSchema) }).nullable().optional().default(null),
  place: z.object({ operationId: z.string().nullable(), how: z.enum(['SCANS', 'MOVE']), waitingFirst: z.boolean() }).nullable().optional().default(null),
  work: z.object({ state: z.enum(WORK_STATES), mine: z.boolean() }).nullable().optional().default(null),
  here: z.object({ departmentId: z.string().nullable(), sameDepartment: z.boolean(), onRoute: z.boolean(), takeHereOperationId: z.string().nullable() }).nullable().optional().default(null),
  hold: z.object({ kind: z.enum(['HOLD', 'QUALITY_HOLD', 'FIRST_PIECE']), words: z.string() }).nullable().optional().default(null),
  changedDesign: z.object({ words: z.string(), seen: z.boolean() }).nullable().optional().default(null),
  flags: z
    .object({
      first: z.boolean(),
      late: z.object({ days: z.number().int(), reason: z.string() }).nullable(),
      problem: callFlagSchema.nullable(),
      ask: callFlagSchema.nullable(),
      answer: z.object({ words: z.string(), at: z.string() }).nullable(),
    })
    .nullable()
    .optional()
    .default(null),
  restricted: z.enum(['RESTRICTED', 'OTHER_TEAM']).nullable().optional().default(null),
  quality: z
    .object({
      ticks: z.object({ required: z.number().int(), done: z.number().int() }),
      photos: z.object({ required: z.number().int(), done: z.number().int() }),
      steps: z.array(qualityStepSchema).optional().default([]),
    })
    .nullable()
    .optional()
    .default(null),
  next: z.object({ operationId: z.string().nullable(), department: departmentLookSchema.nullable() }).nullable().optional().default(null),
  notes: z.array(z.object({ at: z.string(), words: z.string(), fileIds: z.array(z.string()) })).optional().default([]),
  designPageHref: z.string().nullable().optional().default(null),
  can: z
    .object({ start: z.boolean(), done: z.boolean(), moveForward: z.boolean(), moveBack: z.boolean(), route: z.boolean(), give: z.boolean(), flag: z.boolean(), late: z.boolean() })
    .nullable()
    .optional()
    .default(null),
})
export type BasketRead = z.infer<typeof basketReadSchema>

export const FOR_YOU_KINDS = ['CHANGED_DESIGN', 'ANSWER', 'SOLVED', 'HANDOVER', 'PROBLEM', 'ASK'] as const
export type ForYouKind = (typeof FOR_YOU_KINDS)[number]

/** A line of "For you": a HANDOVER note names no basket. */
const forYouSchema = z.object({ kind: z.enum(FOR_YOU_KINDS), bundleId: z.string().nullable(), code: z.string().nullable(), words: z.string(), at: z.string() })
export type ForYouItem = z.infer<typeof forYouSchema>

/** A row flag: a yes/no, or the call / warning object the server may send in its place (present = yes). */
const rowFlag = z.preprocess((value) => value === true || (typeof value === 'object' && value !== null), z.boolean())

const rowSchema = z.object({
  bundleId: z.string(),
  code: z.string(),
  picture: basketPictureSchema.nullable(),
  customerCode: z.string(),
  step: z.object({ operationId: z.string().nullable(), department: departmentLookSchema.nullable() }),
  state: z.enum(WORK_STATES),
  flags: z.object({ first: rowFlag, late: rowFlag, problem: rowFlag }),
})
export type BasketRow = z.infer<typeof rowSchema>

/** `GET /production/baskets/home` (floor): the session's department, For you, the baskets here, the ones that come next. */
export const basketHomeSchema = z.object({
  department: departmentLookSchema.nullable(),
  forYou: z.array(forYouSchema),
  here: z.array(rowSchema),
  comingNext: z.array(rowSchema),
})
export type BasketHome = z.infer<typeof basketHomeSchema>

/** `POST /floor/session/department`: the department, the station taken (one active station of its kind), or the names to choose. */
export const departmentPickedSchema = z.object({
  department: departmentLookSchema,
  station: z.object({ id: z.string(), name: z.string() }).nullable(),
  choose: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type DepartmentPicked = z.infer<typeof departmentPickedSchema>

/** `POST /production/scans`'s answer as the dock reads it: `moved` = a second Done wrote a forward move (no scan, no pay). */
const reportAnswerSchema = z.object({ scan: z.object({ id: z.string(), serverTime: z.string() }).nullable().optional(), replayed: z.boolean().optional(), moved: z.boolean().optional() })
export type ReportAnswer = z.infer<typeof reportAnswerSchema>

/** `POST /production/baskets/move` (fl2): how many moved, how many stay and why. */
const moveAnswerSchema = z.object({ groupId: z.string(), moved: z.number().int(), stay: z.number().int(), stayWords: z.array(z.string()) })
export type MoveAnswer = z.infer<typeof moveAnswerSchema>

// ---- the calls -----------------------------------------------------------------------------------------------------------------

export const BASKET_HOME_PATH = '/production/baskets/home'

/** One basket by its scanned code (or its id). `scanned`: the code came from a scan (the server words "another department" so). */
export function fetchBasket(api: ApiClient, code: string, scanned: boolean): Promise<TaskOutcome<BasketRead>> {
  return floorRead(api, `/production/baskets/${seg(code)}`, { query: scanned ? { via: 'scan' } : {}, schema: basketReadSchema })
}

export function fetchBasketHome(api: ApiClient): Promise<TaskOutcome<BasketHome>> {
  return floorRead(api, BASKET_HOME_PATH, { schema: basketHomeSchema })
}

/** The phone's "where am I" (lead settle 2): the department, and with several stations the one chosen. Online only. */
export function pickDepartment(api: ApiClient, departmentId: string, stationId?: string): Promise<TaskOutcome<DepartmentPicked>> {
  return floorWrite(api, 'POST', '/floor/session/department', { body: { departmentId, ...(stationId ? { stationId } : {}) }, schema: departmentPickedSchema })
}

/**
 * Done (and Passed, Packed): today's REPORT of the whole basket as good at the step it is at — online first, kept on the phone under
 * the same id when the network fails (floor-sync `production.scan.report`, as the Operation screen sends it).
 */
export function reportDone(api: ApiClient, queue: KeepsActions, online: boolean, body: { readonly code: string; readonly workOrderOperationId: string; readonly good: number }) {
  return onlineFirst(queue, {
    online,
    kind: 'production.scan.report',
    payload: body,
    attempt: (clientScanId) => floorWrite(api, 'POST', '/production/scans', { body: { ...body, clientScanId }, schema: reportAnswerSchema, idempotencyKey: clientScanId }),
  })
}

/**
 * A move by hand (fl2's command): Take it here (TAKEN_HERE), Quality's "Not good: send back" (BACK, REDO), the Steps window (FORWARD;
 * BACK with its reason), Change all (one call per target step). Online in fl5/fl6: the offline kind `production.baskets.move` comes with
 * server A's fl2 (then this goes online first, kept on the phone).
 */
export function moveBaskets(api: ApiClient, body: { readonly bundleIds: readonly string[]; readonly toOperationId: string | null; readonly kind: 'FORWARD' | 'BACK' | 'TAKEN_HERE'; readonly reason?: 'REDO' | 'MISTAKE' | 'OTHER'; readonly note?: string; readonly clientEventId: string }): Promise<TaskOutcome<MoveAnswer>> {
  return floorWrite(api, 'POST', '/production/baskets/move', { body, schema: moveAnswerSchema, idempotencyKey: body.clientEventId })
}

const undoAnswerSchema = z.object({ undone: z.number().int(), stay: z.number().int() })
export type UndoAnswer = z.infer<typeof undoAnswerSchema>

/** Undo a move (one basket or many: its group). The own move while nobody moved it since; another person's: the team leader. */
export function undoMove(api: ApiClient, groupId: string, clientEventId: string): Promise<TaskOutcome<UndoAnswer>> {
  return floorWrite(api, 'POST', `/production/baskets/moves/${seg(groupId)}/undo`, { body: { clientEventId }, schema: undoAnswerSchema, idempotencyKey: clientEventId })
}

const routeAnswerSchema = z.object({ groupId: z.string(), changed: z.number().int(), stay: z.number().int(), warnings: z.array(z.string()).optional().default([]) })
export type RouteAnswer = z.infer<typeof routeAnswerSchema>

/** For whom a route change is: baskets (one, or the ones chosen), or all baskets of an order. */
export type RouteTarget = { readonly bundleIds: readonly string[] } | { readonly salesOrderId: string }

/** Change the route (the team leader; online only): skip, put back, add a step before the last, with one reason. */
export function changeRoute(api: ApiClient, target: RouteTarget, edits: readonly { readonly kind: 'SKIP' | 'PUT_BACK' | 'ADD'; readonly operationId?: string; readonly departmentId?: string }[], reason: 'NOT_NEEDED' | 'REDO' | 'CUSTOMER' | 'OTHER'): Promise<TaskOutcome<RouteAnswer>> {
  return floorWrite(api, 'POST', '/production/baskets/route', { body: { ...target, edits, reason }, schema: routeAnswerSchema })
}

/** Back to the normal route (one basket, the chosen ones, or the order). */
export function normalRoute(api: ApiClient, target: RouteTarget): Promise<TaskOutcome<{ readonly changed: number }>> {
  return floorWrite(api, 'POST', '/production/baskets/route/normal', { body: target, schema: z.object({ changed: z.number().int() }) })
}

/** One person of the team: `key` is the worker the give names; the name only where the site names workers (worker-gate). */
const teamPersonSchema = z.object({ key: z.string(), name: z.string().nullable(), holds: z.object({ bundleId: z.string(), code: z.string() }).nullable() })
export type TeamPerson = z.infer<typeof teamPersonSchema>

const teamOrderSchema = z.object({ salesOrderId: z.string().nullable(), customerCode: z.string(), picture: basketPictureSchema.nullable(), baskets: z.array(rowSchema) })
export type TeamOrder = z.infer<typeof teamOrderSchema>

/** `GET /production/baskets/team` (floor.lead; server B's fl4): the leader's home. Numbers of the TEAM, never of one person. */
export const basketTeamSchema = z.object({
  team: teamSchema.nullable(),
  numbers: z.object({ working: z.number().int(), waiting: z.number().int(), late: z.number().int(), problem: z.number().int() }),
  forYou: z.array(forYouSchema),
  orders: z.array(teamOrderSchema),
  people: z.array(teamPersonSchema),
  /** People of the team not on the floor today: a count (a list is counted). */
  missing: z.preprocess((value) => (Array.isArray(value) ? value.length : value), z.number().int()).optional().default(0),
  doneToday: z.number().int(),
  handover: z.object({ writtenAt: z.string().nullable().optional(), topics: z.array(z.string()).optional().default([]), text: z.string().nullable().optional() }).nullable().optional().default(null),
})
export type BasketTeam = z.infer<typeof basketTeamSchema>

export function fetchTeam(api: ApiClient): Promise<TaskOutcome<BasketTeam>> {
  return floorRead(api, '/production/baskets/team', { schema: basketTeamSchema })
}

const assignedSchema = z.object({ assignment: z.object({ id: z.string(), version: z.number().int(), workerId: z.string().nullable() }) })
export type Assigned = z.infer<typeof assignedSchema>

/** Give to… = today's `POST /production/dispatch/assignments`, naming the BASKET only (the server finds its step: fl4's seam). Online. */
export function giveBasket(api: ApiClient, workerId: string, bundleId: string): Promise<TaskOutcome<Assigned>> {
  return floorWrite(api, 'POST', '/production/dispatch/assignments', { body: { workerId, bundleIds: [bundleId] }, schema: assignedSchema })
}

/** Undo a give: today's reassign, back to the person who held it. */
export function giveBack(api: ApiClient, assignment: { readonly id: string; readonly version: number }, workerId: string): Promise<TaskOutcome<Assigned>> {
  return floorWrite(api, 'POST', `/production/dispatch/assignments/${seg(assignment.id)}/reassign`, { body: { version: assignment.version, workerId }, schema: assignedSchema })
}

/** Do this first (floor.lead; server B's fl3): on or off; it puts the basket on top of the workers' lists. Online in fl6. */
export function setFirst(api: ApiClient, bundleIds: readonly string[], on: boolean): Promise<TaskOutcome<unknown>> {
  const clientEventId = newIdempotencyKey()
  return floorWrite(api, 'POST', '/production/baskets/flags', { body: { bundleIds, kind: 'FIRST', on, clientEventId }, schema: z.unknown(), idempotencyKey: clientEventId })
}

export const LATE_DAYS = [1, 2, 3, 5] as const
export const LATE_REASONS = ['MATERIAL', 'MACHINE', 'PEOPLE', 'REDO'] as const
export type LateReason = (typeof LATE_REASONS)[number]

/** Will be late (floor.lead; server B's fl3): sales reads it before the date slips. Online in fl6. */
export function tellLate(api: ApiClient, bundleIds: readonly string[], days: (typeof LATE_DAYS)[number], reason: LateReason): Promise<TaskOutcome<unknown>> {
  const clientEventId = newIdempotencyKey()
  return floorWrite(api, 'POST', '/production/baskets/late', { body: { bundleIds, days, reason, clientEventId }, schema: z.unknown(), idempotencyKey: clientEventId })
}

/** A tick of the quality check: today's checklist tick, kept on the phone first (floor-sync `production.checklist.tick`). */
export function tickQuality(queue: KeepsActions, body: { readonly code: string; readonly workOrderOperationId: string; readonly stepCode: string }) {
  return queue.enqueue('production.checklist.tick', body)
}

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/**
 * A quality photo (`POST /production/baskets/:bundleId/checklist/:stepCode/photo`, then `…/:fileId/complete`): announced with its
 * size and SHA-256, the bytes PUT to the store, then completed — the server sets the step's `OperationChecklistResult.fileId`.
 * Online only (a photo never queues).
 */
export async function uploadQualityPhoto(api: ApiClient, bundleId: string, stepCode: string, photo: Blob): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const base = `/production/baskets/${seg(bundleId)}/checklist/${seg(stepCode)}/photo`
  const bytes = await photo.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const contentType = (photo.type || 'image/jpeg').split(';')[0]!.trim()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: `${stepCode}.jpg`, contentType, sizeBytes: bytes.byteLength, sha256 }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}
