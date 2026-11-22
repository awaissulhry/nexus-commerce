import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import type { SplitReason } from '../split/api'

/**
 * F-OS-203 (order SHIPMENTS tab; 13-backend B-OS-011 … B-OS-013, 18-lead-settles L6) — garments between DRAFTs of the same customer,
 * each ONE command on both shipments' versions (apps/factory-api modules/shipping/consolidate):
 *
 *   GET  …/:id/move-targets                       the other DRAFTs of the same customer, company and site, each with its orders and,
 *                                                 for every order of this one, whether its garments may join it and why not
 *   POST …/:id/move                               garments onto one of them (both locked, the source shrinks first)
 *   POST …/:id/merge                              every garment onto it; this one CANCELLED "Merged into {number}" (never deleted)
 *   POST …/:id/orders/:salesOrderId/take-off      every line of one order off a shared DRAFT, all or nothing (not its first order)
 *
 * Another customer's shipment is answered as an unknown one. The answers' full shipments are read only for their number (the page
 * reads itself again). No money.
 */

const enc = encodeURIComponent
const base = (shipmentId: string) => `/shipping/shipments/${enc(shipmentId)}`
const ref = z.object({ id: z.string(), number: z.string() })

export const moveTargetsSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  version: z.number(),
  targets: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      orders: z.array(ref),
      garments: z.number(),
      // A join code as a plain string: a code the server adds later never breaks the read.
      verdicts: z.array(z.object({ orderId: z.string(), allowed: z.boolean(), code: z.string().nullable(), why: z.string().nullable() })),
    }),
  ),
})
export type MoveTargets = z.infer<typeof moveTargetsSchema>
export type MoveTarget = MoveTargets['targets'][number]

export const readMoveTargets = (api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<MoveTargets> => api.get(`${base(shipmentId)}/move-targets`, { schema: moveTargetsSchema, ...(signal ? { signal } : {}) })

const movedSchema = z.object({ shipment: ref, moved: z.object({ lines: z.number(), garments: z.number(), merged: z.boolean() }) })
export type Moved = z.infer<typeof movedSchema>

export interface MoveBody {
  readonly version: number
  readonly toShipmentId: string
  readonly toVersion: number | undefined
  readonly lines: readonly { readonly lineId: string; readonly quantity: number }[]
  readonly reason: SplitReason
  readonly words: string | null
}

export const moveGarments = (api: ApiClient, shipmentId: string, body: MoveBody, idempotencyKey: string): Promise<Moved> => api.post(`${base(shipmentId)}/move`, { body, schema: movedSchema, idempotencyKey })

export interface MergeBody {
  readonly version: number
  readonly intoShipmentId: string
  readonly intoVersion: number | undefined
  readonly words: string | null
}

export const mergeShipment = (api: ApiClient, shipmentId: string, body: MergeBody, idempotencyKey: string): Promise<Moved> => api.post(`${base(shipmentId)}/merge`, { body, schema: movedSchema, idempotencyKey })

const takenOffSchema = z.object({ takenOff: z.object({ salesOrderId: z.string(), lines: z.number(), garments: z.number() }) })
export type TakenOff = z.infer<typeof takenOffSchema>['takenOff']

/** B-OS-013: one order's garments off a shared DRAFT in ONE command (the reason is the office's: 3 to 500 characters). */
export const takeOffOrder = (api: ApiClient, shipmentId: string, salesOrderId: string, version: number, reason: string, idempotencyKey: string): Promise<TakenOff> =>
  api.post(`${base(shipmentId)}/orders/${enc(salesOrderId)}/take-off`, { body: { version, reason }, schema: takenOffSchema, idempotencyKey }).then((answer) => answer.takenOff)
