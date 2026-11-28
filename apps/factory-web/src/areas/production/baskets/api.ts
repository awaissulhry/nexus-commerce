import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * owb-fl9 — the office's Baskets board, its basket window and "From the floor" (contracts of common § 3 "fl4", "fl2", "fl1";
 * server B and server A build them beside this web). This web's own zod: only what the page draws is required, so a new field
 * never breaks the page.
 *
 *   board        GET /production/baskets/board?scope=floor&teamId&departmentId&salesOrderId (production.bundles.view): one column per
 *                department IN USE + Ready to ship; the card names the customer only for people allowed that customer
 *   basket       GET /production/baskets/:code (office: production.bundles.view): its route (for "Move it to"), its open problem
 *   move         POST /production/baskets/move (fl2): FORWARD (production.baskets.move) · BACK with a reason (production.baskets.route)
 *   solve        today's POST /production/calls/:callId/solve (production.calls.answer): "Problem solved"
 *   give         today's POST /production/dispatch/assignments, the bundle only (fl4's seam: the server finds its step)
 *   from floor   GET /production/baskets/from-the-floor?salesOrderId= (workorders.view) · POST /production/baskets/late/:id/answer
 *                (orders.manage) · Share with the customer = today's POST /files/:fileId/use-on (files.upload)
 */

const words = z.record(z.string(), z.string())

export const departmentSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable().optional(),
  nameI18n: words.nullable().optional(),
  tone: z.string(),
  icon: z.string(),
  status: z.enum(['ACTIVE', 'CLOSED']).nullable().optional(),
})
export type DepartmentRow = z.infer<typeof departmentSchema>

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  pictureKind: z.string().nullable().optional(),
  pictureIcon: z.string().nullable().optional(),
  pictureColour: z.string().nullable().optional(),
})

export const cardSchema = z.object({
  bundleId: z.string(),
  code: z.string(),
  picture: z.object({ src: z.string() }).nullable().optional(),
  customerCode: z.string().nullable().optional(),
  /** The office: the customer's name only for people allowed that customer; the floor: its code only. */
  customer: z.object({ code: z.string().nullable().optional(), name: z.string().nullable().optional() }).nullable().optional(),
  step: z.object({ operationId: z.string().nullable().optional(), department: departmentSchema.nullable().optional() }).nullable().optional(),
  state: z.string().nullable().optional(),
  flags: z
    .object({
      first: z.boolean().optional(),
      late: z.boolean().optional(),
      problem: z.object({ callId: z.string(), typeCode: z.string(), minutes: z.number().optional(), escalated: z.boolean().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  team: teamSchema.nullable().optional(),
  worker: z.object({ name: z.string().nullable() }).nullable().optional(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable().optional(),
  late: z.object({ days: z.number(), reason: z.string(), state: z.string() }).nullable().optional(),
  /** The order of the basket (asked of server B: "Open the order"). */
  salesOrderId: z.string().nullable().optional(),
})
export type BoardCard = z.infer<typeof cardSchema>

export const boardSchema = z.object({
  columns: z.array(z.object({ department: departmentSchema, baskets: z.array(cardSchema) })),
  readyToShip: z.array(cardSchema),
  /** Only where the site names workers (worker-gate): who a basket may be given to (asked of server B; absent: no "Give it to"). */
  people: z.array(z.object({ workerId: z.string(), name: z.string() })).nullable().optional(),
})
export type Board = z.infer<typeof boardSchema>

export interface BoardFilters {
  readonly teamId?: string | null
  readonly departmentId?: string | null
  readonly salesOrderId?: string | null
}

export const readBoard = (api: ApiClient, filters: BoardFilters, signal?: AbortSignal): Promise<Board> =>
  api.get('/production/baskets/board', { query: { scope: 'floor', teamId: filters.teamId ?? undefined, departmentId: filters.departmentId ?? undefined, salesOrderId: filters.salesOrderId ?? undefined }, schema: boardSchema, signal })

// ---- the basket (fl1's read, what the window draws) -------------------------------------------------------------------------------

export const ROUTE_STATES = ['DONE', 'HERE', 'NEXT', 'TODO', 'SKIPPED'] as const

const stepSchema = z.object({
  operationId: z.string(),
  seq: z.number(),
  name: z.string(),
  department: departmentSchema.nullable().optional(),
  state: z.string(),
  added: z.boolean().optional(),
})
export type RouteStep = z.infer<typeof stepSchema>

const callFlag = z.object({ callId: z.string(), typeCode: z.string(), state: z.string() }).passthrough()

export const basketSchema = z.object({
  basket: z.object({ id: z.string(), code: z.string(), workOrderId: z.string(), workOrderNumber: z.string().optional(), salesOrderId: z.string().nullable().optional(), customerCode: z.string().nullable().optional() }),
  picture: z.object({ src: z.string() }).nullable().optional(),
  route: z.object({ own: z.boolean().optional(), steps: z.array(stepSchema) }),
  place: z.object({ operationId: z.string().nullable() }).passthrough().nullable().optional(),
  flags: z.object({ problem: callFlag.nullable().optional() }).passthrough().nullable().optional(),
  can: z.object({ moveForward: z.boolean().optional(), moveBack: z.boolean().optional(), give: z.boolean().optional() }).passthrough().nullable().optional(),
})
export type BasketRead = z.infer<typeof basketSchema>

export const readBasket = (api: ApiClient, code: string, signal?: AbortSignal): Promise<BasketRead> => api.get(`/production/baskets/${encodeURIComponent(code)}`, { schema: basketSchema, signal })

// ---- move, solve, give ------------------------------------------------------------------------------------------------------

export const MOVE_REASONS = ['REDO', 'MISTAKE', 'OTHER'] as const
export type MoveReason = (typeof MOVE_REASONS)[number]

export interface MoveBody {
  readonly bundleIds: readonly string[]
  readonly toOperationId: string | null
  readonly kind: 'FORWARD' | 'BACK'
  readonly reason?: MoveReason
}

const moved = z.object({ groupId: z.string().nullable().optional(), moved: z.number(), stay: z.number().optional(), stayWords: z.array(z.string()).optional() })
export type Moved = z.infer<typeof moved>

export const moveBasket = (api: ApiClient, body: MoveBody): Promise<Moved> => {
  const clientEventId = newIdempotencyKey()
  return api.request('POST', '/production/baskets/move', { body: { ...body, clientEventId }, schema: moved, idempotencyKey: clientEventId })
}

export const solveCall = (api: ApiClient, callId: string): Promise<unknown> =>
  api.request('POST', `/production/calls/${encodeURIComponent(callId)}/solve`, { body: {}, schema: z.unknown(), idempotencyKey: newIdempotencyKey() })

export const giveBasket = (api: ApiClient, workerId: string, bundleId: string): Promise<unknown> =>
  api.request('POST', '/production/dispatch/assignments', { body: { workerId, bundleIds: [bundleId] }, schema: z.unknown(), idempotencyKey: newIdempotencyKey() })

// ---- From the floor (the order's Production tab) ------------------------------------------------------------------------------

export const LATE_STATES = ['OPEN', 'KEPT', 'CHANGED'] as const

export const fromTheFloorSchema = z.object({
  photos: z.array(z.object({ fileId: z.string(), src: z.string().nullable().optional(), at: z.string(), basketCode: z.string().nullable().optional(), shared: z.boolean() })),
  changes: z.array(z.object({ at: z.string(), kind: z.string(), basketCodes: z.array(z.string()), words: z.string(), reason: z.string().nullable().optional(), who: z.string().nullable().optional() })),
  late: z.array(z.object({ id: z.string(), days: z.number(), reason: z.string(), state: z.string(), at: z.string(), basketCodes: z.array(z.string()) })),
})
export type FromTheFloor = z.infer<typeof fromTheFloorSchema>
export type LateWarning = FromTheFloor['late'][number]
export type FloorPhoto = FromTheFloor['photos'][number]

export const readFromTheFloor = (api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<FromTheFloor> =>
  api.get('/production/baskets/from-the-floor', { query: { salesOrderId }, schema: fromTheFloorSchema, signal })

export const answerLate = (api: ApiClient, lateId: string, state: 'KEPT' | 'CHANGED'): Promise<unknown> =>
  api.request('POST', `/production/baskets/late/${encodeURIComponent(lateId)}/answer`, { body: { state }, schema: z.unknown(), idempotencyKey: newIdempotencyKey() })

/** Share with the customer: today's "use on" carries the photo to the order, seen by the office and the customer (sales / owner only). */
export const sharePhoto = (api: ApiClient, fileId: string, salesOrderId: string): Promise<unknown> =>
  api.request('POST', `/files/${encodeURIComponent(fileId)}/use-on`, { body: { recordType: 'SalesOrder', recordId: salesOrderId, visibility: ['OFFICE', 'PARTNER'] }, schema: z.unknown(), idempotencyKey: newIdempotencyKey() })
