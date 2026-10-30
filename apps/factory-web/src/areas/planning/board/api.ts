import { z } from 'zod'
import { SCHEDULE_REASONS, SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import { SCHEDULE_LANE_KINDS } from '@nexus/factory-domain/planning/schedule/slots'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of the planning board (SCR-122; the schedule API of B-W2a-34, apps/factory-api modules/planning/schedule),
 * with the answer's shape checked (zod; unknown fields are dropped, so a new API field never breaks the page). The
 * shapes mirror the API's contract.ts; the enum lists are factory-domain's own. The API's English (`words`, a 409's
 * message) is never drawn: the screen says its own words from the numbers and codes. No money anywhere; per line, work
 * centre, workshop and work order, never a person (a planner's name only on the slot they moved last and on a version).
 */

export const BOARD_BUCKETS = ['DAY', 'WEEK', 'MONTH'] as const
export type BoardBucket = (typeof BOARD_BUCKETS)[number]
export const TRAY_CHIPS = ['PAST_LATEST_SAFE_START', 'START_SOON', 'MATERIAL_NOT_READY', 'ON_HOLD', 'DRAFT', 'NO_DUE_DATE'] as const
export type TrayChip = (typeof TRAY_CHIPS)[number]
export const PROBLEM_KINDS = ['OVERBOOKED', 'FINISHES_LATE'] as const
export const CHECK_CODES = ['OVERBOOKED', 'IN_THE_PAST', 'MATERIAL_NOT_READY'] as const
export type CheckCode = (typeof CHECK_CODES)[number]

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const laneKind = z.enum(SCHEDULE_LANE_KINDS)
export type LaneKind = z.infer<typeof laneKind>
const laneRef = z.object({ kind: laneKind, id: z.string() })
export type LaneRef = z.infer<typeof laneRef>
const person = z.object({ id: z.string(), name: z.string() }).nullable()

const scheduleView = z.object({
  status: z.enum(SCHEDULE_STATUSES),
  latestSafeStart: z.string().nullable(),
  latestFinish: z.string().nullable(),
  earliestFinish: z.string().nullable(),
  plannedStart: z.string().nullable(),
  plannedFinish: z.string().nullable(),
  placed: z.enum(['ALL', 'PART', 'NONE']),
  reasons: z.array(z.object({ code: z.enum(SCHEDULE_REASONS) })),
})
export type ScheduleView = z.infer<typeof scheduleView>

const storedSlot = z.object({
  id: z.string(),
  version: z.number(),
  lane: laneRef,
  workOrderId: z.string(),
  operationId: z.string().nullable(),
  startAt: z.string(),
  endAt: z.string(),
  pieces: z.number().nullable(),
  minutes: z.string(),
  overloadReason: z.string().nullable(),
  note: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: person,
})

const slotView = storedSlot.extend({
  booksCapacity: z.boolean(),
  latestStart: z.string().nullable(),
  latestFinish: z.string().nullable(),
  startsLate: z.boolean(),
})
export type BoardSlot = z.infer<typeof slotView>

const operationView = z.object({
  id: z.string(),
  seq: z.number(),
  code: z.string(),
  name: z.string(),
  workCentre: named,
  standardMinutes: z.string(),
  remainingPieces: z.number(),
  minutes: z.string(),
  workingMinutes: z.number(),
  lane: laneRef,
  outside: z.object({ partyId: z.string(), transitDays: z.number().nullable() }).nullable(),
  latestStart: z.string().nullable(),
  latestFinish: z.string().nullable(),
  plannedStart: z.string().nullable(),
  plannedFinish: z.string().nullable(),
  startsLate: z.boolean(),
  slotIds: z.array(z.string()),
})
export type BoardOperation = z.infer<typeof operationView>

const readinessView = z.object({ word: z.enum(READINESS_WORDS), date: z.string().nullable() }).nullable()
export type Readiness = z.infer<typeof readinessView>

const workOrderView = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  kind: z.string(),
  priority: z.number(),
  rush: z.boolean(),
  version: z.number(),
  dueDate: z.string().nullable(),
  style: named,
  garments: z.number(),
  line: named.nullable(),
  holdReason: z.string().nullable(),
  booksCapacity: z.boolean(),
  minutes: z.string(),
  schedule: scheduleView,
  readiness: readinessView,
  operations: z.array(operationView),
})
export type BoardWorkOrder = z.infer<typeof workOrderView>

const cellView = z.object({
  key: z.string(),
  from: z.string(),
  to: z.string(),
  availableMinutes: z.string(),
  bookedMinutes: z.string(),
  scheduledMinutes: z.string(),
  loadPct: z.string().nullable(),
  overMinutes: z.string(),
  closedDays: z.array(z.object({ date: z.string(), reason: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string() })),
})
export type BoardCell = z.infer<typeof cellView>

const laneView = z.object({
  kind: laneKind,
  id: z.string(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string().nullable(),
  people: z.number().nullable(),
  efficiencyPct: z.string().nullable(),
  does: z.array(z.string()).nullable(),
  cells: z.array(cellView).nullable(),
})
export type BoardLane = z.infer<typeof laneView>

const versionHeader = z.object({
  id: z.string(),
  number: z.number(),
  coversFrom: z.string(),
  coversTo: z.string(),
  effectiveFrom: z.string(),
  publishedAt: z.string(),
  publishedBy: person,
})
export type VersionHeader = z.infer<typeof versionHeader>

const diffView = z.object({ moved: z.number(), added: z.number(), removed: z.number() })
export type DiffView = z.infer<typeof diffView>

const problemView = z.object({
  kind: z.enum(PROBLEM_KINDS),
  lane: laneRef.nullable(),
  date: z.string().nullable(),
  bucketKey: z.string().nullable(),
  overMinutes: z.string().nullable(),
  loadPct: z.string().nullable(),
  workOrderId: z.string().nullable(),
  daysLate: z.number().nullable(),
})
export type BoardProblem = z.infer<typeof problemView>

const siteView = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
export type BoardSite = z.infer<typeof siteView>

export const boardSchema = z.object({
  site: siteView,
  from: z.string(),
  to: z.string(),
  bucket: z.enum(BOARD_BUCKETS),
  today: z.string(),
  asOf: z.string(),
  plan: z.object({
    id: z.string().nullable(),
    version: z.number().nullable(),
    updatedAt: z.string().nullable(),
    published: versionHeader.nullable(),
    changesSincePublished: diffView.nullable(),
    mayChange: z.boolean(),
    mayPublish: z.boolean(),
    /** Held in the API's English: only whether it is held (and which of its two sentences) is read. */
    publishHeld: z.string().nullable(),
  }),
  buckets: z.array(z.object({ key: z.string(), kind: z.enum(BOARD_BUCKETS), from: z.string(), to: z.string() })),
  lanes: z.array(laneView),
  slots: z.array(slotView),
  workOrders: z.array(workOrderView),
  tray: z.array(z.object({ workOrderId: z.string(), unplacedOperations: z.number(), minutes: z.string(), latestSafeStart: z.string().nullable(), chips: z.array(z.enum(TRAY_CHIPS)) })),
  problems: z.array(problemView),
})
export type Board = z.infer<typeof boardSchema>

export interface BoardQuery {
  siteId: string
  from?: string
  to?: string
  bucket?: BoardBucket
}

export function getBoard(api: ApiClient, query: BoardQuery, signal?: AbortSignal): Promise<Board> {
  return api.get('/planning/schedule', { query: { siteId: query.siteId, from: query.from, to: query.to, bucket: query.bucket }, schema: boardSchema, signal })
}

const barSchema = z.object({
  site: siteView,
  asOf: z.string(),
  workOrder: workOrderView,
  sizes: z.array(z.object({ colourway: z.string(), size: z.string(), quantity: z.number() })),
  slots: z.array(slotView),
  lanes: z.array(laneView.omit({ cells: true })),
})
export type BarDetail = z.infer<typeof barSchema>

/** The bar popover: the work order's sizes, operations, slots, material and risk. */
export function getBarDetail(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<BarDetail> {
  return api.get(`/planning/schedule/work-orders/${encodeURIComponent(workOrderId)}`, { schema: barSchema, signal })
}

const overView = z.object({ lane: laneRef, date: z.string(), availableMinutes: z.string(), bookedMinutes: z.string(), overMinutes: z.string(), loadPct: z.string().nullable() })
const slotAnswer = z.object({ slot: storedSlot, planVersion: z.number(), over: z.array(overView), replayed: z.boolean() })
export type SlotAnswer = z.infer<typeof slotAnswer>

export interface PlaceSlot {
  workOrderId: string
  operationId: string | null
  lane: LaneRef
  startAt: string
  overloadReason?: string | null
}

/** A drop from the tray: the operation's bar on a lane from a start (the API gives the end from the lane's working time). */
export function placeSlot(api: ApiClient, body: PlaceSlot): Promise<SlotAnswer> {
  return api.post('/planning/schedule/slots', { body, schema: slotAnswer, idempotencyKey: newIdempotencyKey() })
}

export interface MoveSlot {
  version: number
  lane?: LaneRef
  startAt?: string
  overloadReason?: string | null
}

/** A move in time or to another lane, with the slot's version as read ("Moved by … at …" on 409). */
export function moveSlot(api: ApiClient, slotId: string, body: MoveSlot): Promise<SlotAnswer> {
  return api.request('PATCH', `/planning/schedule/slots/${encodeURIComponent(slotId)}`, { body, schema: slotAnswer, idempotencyKey: newIdempotencyKey() })
}

/** Send back to the tray. */
export function removeSlot(api: ApiClient, slotId: string, version: number): Promise<{ removed: string; planVersion: number }> {
  return api.post(`/planning/schedule/slots/${encodeURIComponent(slotId)}/remove`, {
    body: { version },
    schema: z.object({ removed: z.string(), workOrderId: z.string(), planVersion: z.number(), replayed: z.boolean() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const proposalSchema = z.object({
  workOrderId: z.string(),
  operationId: z.string(),
  lane: laneRef,
  startAt: z.string(),
  endAt: z.string(),
  minutes: z.string(),
  placedBy: z.enum(['BACKWARD', 'FORWARD']),
  over: z.array(overView),
})
export type Proposal = z.infer<typeof proposalSchema>

const placeByDueDateSchema = z.object({
  planVersion: z.number().nullable(),
  applied: z.boolean(),
  slots: z.array(proposalSchema),
  skipped: z.array(z.object({ workOrderId: z.string(), operationId: z.string().nullable() })),
  overbooked: z.number(),
  replayed: z.boolean(),
})
export type PlaceByDueDate = z.infer<typeof placeByDueDateSchema>

/** "Place all by due date" (backward scheduling): the preview (apply false), then the same with the plan's version. */
export function placeByDueDate(api: ApiClient, body: { siteId: string; apply: boolean; version?: number; overloadReason?: string | null }): Promise<PlaceByDueDate> {
  return api.post('/planning/schedule/place-by-due-date', { body, schema: placeByDueDateSchema, idempotencyKey: body.apply ? newIdempotencyKey() : undefined })
}

const checkSchema = z.object({
  code: z.enum(CHECK_CODES),
  state: z.enum(['PASS', 'WARNING']),
  count: z.number(),
  items: z.array(z.object({ workOrderId: z.string().nullable(), slotId: z.string().nullable(), lane: laneRef.nullable(), date: z.string().nullable() })),
})
export type PublishCheck = z.infer<typeof checkSchema>

const publishPreviewSchema = z.object({
  site: siteView,
  asOf: z.string(),
  plan: z.object({ id: z.string().nullable(), version: z.number().nullable() }),
  next: z.number(),
  previous: versionHeader.nullable(),
  range: z.object({ coversFrom: z.string(), coversTo: z.string(), effectiveFrom: z.string(), workingDays: z.number(), isDefault: z.boolean() }),
  slots: z.number(),
  diff: diffView.extend({ byLane: z.array(z.object({ lane: laneRef, code: z.string(), name: z.string(), moved: z.number(), added: z.number(), removed: z.number() })) }),
  checks: z.array(checkSchema),
  mayPublish: z.boolean(),
  heldReason: z.string().nullable(),
})
export type PublishPreview = z.infer<typeof publishPreviewSchema>

export interface PublishRange {
  coversFrom?: string
  coversTo?: string
}

export function getPublishPreview(api: ApiClient, siteId: string, range: PublishRange, signal?: AbortSignal): Promise<PublishPreview> {
  return api.get('/planning/schedule/publish', { query: { siteId, coversFrom: range.coversFrom, coversTo: range.coversTo }, schema: publishPreviewSchema, signal })
}

/** Publish the working plan's version the dialog reviewed (409 when it changed since). */
export function publishPlan(api: ApiClient, body: { siteId: string; version: number; coversFrom: string; coversTo: string }): Promise<{ version: VersionHeader; slots: number }> {
  return api.post('/planning/schedule/publish', {
    body,
    schema: z.object({ version: versionHeader, slots: z.number(), diff: diffView, replayed: z.boolean() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const versionsSchema = z.object({ versions: z.array(versionHeader.extend({ slots: z.number() })) })
export type PublishedVersion = z.infer<typeof versionsSchema>['versions'][number]

export async function listVersions(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<PublishedVersion[]> {
  return (await api.get('/planning/schedule/versions', { query: { siteId }, schema: versionsSchema, signal })).versions
}

const planningSiteSchema = z.object({ site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }) })
export interface PlanningSite {
  id: string
  companyId: string
  code: string
  name: string
  timeZone: string
}

/** The company's sites this person plans (planning.view: Planning settings' list). */
export async function listPlanningSites(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PlanningSite[]> {
  const answer = await api.get('/planning/settings', { query: { companyId: companyId ?? undefined }, schema: z.object({ sites: z.array(planningSiteSchema) }), signal })
  return answer.sites.map((entry) => entry.site).sort((a, b) => a.code.localeCompare(b.code))
}
