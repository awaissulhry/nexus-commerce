import { z } from 'zod'
import { ALLOCATION_LANE_KINDS } from '@nexus/factory-domain/planning/schedule/allocation'
import { SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Lines & subcontractors (SCR-126; the allocation API of B-W2a-34, apps/factory-api
 * modules/planning/schedule allocation.ts), with the answer's shape checked (zod; unknown fields are dropped). Lanes
 * are the site's lines and its workshops (subcontractors with a location at the site); a card is a work order's line
 * part (the garments no part names, on its line or "Not allocated") or one of its parts on another lane. No money, no
 * person: lines, workshops and work orders only.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const laneKind = z.enum(ALLOCATION_LANE_KINDS)
export type AllocationLaneKind = z.infer<typeof laneKind>
const laneRef = z.object({ kind: laneKind, id: z.string() })
export type AllocationLaneRef = z.infer<typeof laneRef>

const cardSchema = z.object({
  /** `<workOrderId>:LINE` (the line part, or not allocated) or `<workOrderId>:<slotId>` (a part). */
  id: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number(), dueDate: z.string().nullable(), style: named, garments: z.number(), holdReason: z.string().nullable() }),
  lane: laneRef.nullable(),
  pieces: z.number(),
  minutes: z.string(),
  slot: z.object({ id: z.string(), version: z.number() }).nullable(),
  schedule: z.object({ status: z.enum(SCHEDULE_STATUSES), latestSafeStart: z.string().nullable() }),
})
export type AllocationCard = z.infer<typeof cardSchema>

const laneSchema = z.object({
  kind: laneKind,
  id: z.string(),
  code: z.string(),
  name: z.string(),
  /** A line's load over the next four weeks; null for a workshop. */
  load: z.object({ availableMinutes: z.string(), bookedMinutes: z.string(), loadPct: z.string().nullable(), overMinutes: z.string() }).nullable(),
  piecesBooked: z.number(),
  location: z.object({ id: z.string(), code: z.string() }).nullable(),
  subcontractOrders: z.number().nullable(),
})
export type AllocationLane = z.infer<typeof laneSchema>

export const allocationSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  asOf: z.string(),
  today: z.string(),
  plan: z.object({ id: z.string().nullable(), version: z.number().nullable() }),
  mayChange: z.boolean(),
  lanes: z.array(laneSchema),
  cards: z.array(cardSchema),
})
export type Allocation = z.infer<typeof allocationSchema>

export function getAllocation(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Allocation> {
  return api.get('/planning/allocation', { query: { siteId }, schema: allocationSchema, signal })
}

export interface AllocateBody {
  /** The work order's version as read on the board. */
  version: number
  lineId: string | null
  parts: Array<{ lane: AllocationLaneRef; pieces: number }>
}

/** The work order's whole allocation (its line and its parts), with its version: one change. */
export function allocate(api: ApiClient, workOrderId: string, body: AllocateBody): Promise<{ workOrder: { id: string; version: number; lineId: string | null }; planVersion: number }> {
  return api.request('PUT', `/planning/allocation/work-orders/${encodeURIComponent(workOrderId)}`, {
    body,
    schema: z.object({ workOrder: z.object({ id: z.string(), version: z.number(), lineId: z.string().nullable() }), cards: z.array(cardSchema), planVersion: z.number(), replayed: z.boolean() }),
    idempotencyKey: newIdempotencyKey(),
  })
}
