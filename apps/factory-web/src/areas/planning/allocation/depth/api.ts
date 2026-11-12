import { z } from 'zod'
import { CAPACITY_UNITS, HOLD_CODES, WARNING_CODES } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * The W2b calls of Lines & subcontractors (SCR-126; B-W2b-338 on the API of B-W2b-321, apps/factory-api
 * modules/planning/subcontract-capacity contract.ts), the answers' shapes checked with zod (unknown fields dropped):
 * which workshops are offered for each open work order and why not, one work order's workshops per operation, the kit
 * timing of a drop on a workshop, one operation outside or back in-house, and "Create subcontract orders (n)". Amounts
 * are decimal strings (minutes or garments, as `unit` says). The API's English (`words`, `problems`) is never drawn: the
 * screen says it from the codes and the facts (depth/model.ts). No money, no person.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const unit = z.enum(CAPACITY_UNITS)
const holdReason = z.object({ code: z.enum(HOLD_CODES), words: z.string() })
const warningReason = z.object({ code: z.enum(WARNING_CODES), words: z.string() })
export type HoldReason = z.infer<typeof holdReason>
export type WarningReason = z.infer<typeof warningReason>

const durcSchema = z.object({ checked: z.boolean(), state: z.enum(['MET', 'EXPIRING', 'EXPIRED', 'MISSING']), expiresOn: z.string().nullable() })
export type Durc = z.infer<typeof durcSchema>
const capacityLine = z.object({ workCentreKind: z.string().nullable(), unit: unit.nullable(), available: z.string().nullable(), booked: z.string(), proposed: z.string(), loadPct: z.string().nullable(), over: z.boolean() })
export type WorkshopCapacityLine = z.infer<typeof capacityLine>
const workshopFields = {
  id: z.string(),
  code: z.string(),
  name: z.string(),
  location: z.object({ id: z.string(), code: z.string() }).nullable(),
  active: z.boolean(),
  supplierProblem: z.string().nullable(),
  durc: durcSchema,
  capacity: z.array(capacityLine),
}
const operationSchema = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), workCentreKind: z.string(), outsourced: z.boolean(), subcontractOrderId: z.string().nullable(), outsideStep: z.boolean(), version: z.number() })
export type DepthOperation = z.infer<typeof operationSchema>
const verdictFields = { offered: z.boolean(), held: z.array(holdReason), warnings: z.array(warningReason) }

const allocationWorkshopsSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  today: z.string(),
  asOf: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  workshops: z.array(z.object({ ...workshopFields, qualifications: z.array(z.object({ workCentreKind: z.string(), qualified: z.boolean(), standing: z.string(), words: z.string() })) })),
  workOrders: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }),
      operations: z.array(operationSchema),
      workshops: z.array(z.object({ partyId: z.string(), ...verdictFields })),
    }),
  ),
})
export type AllocationWorkshops = z.infer<typeof allocationWorkshopsSchema>
export type AllocationWorkshop = AllocationWorkshops['workshops'][number]
export type WorkOrderVerdicts = AllocationWorkshops['workOrders'][number]
export type Verdict = WorkOrderVerdicts['workshops'][number]

/** Per open work order of the site, whether each workshop takes its outside work, with the holds and the warnings. */
export function getAllocationWorkshops(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<AllocationWorkshops> {
  return api.get('/planning/allocation/workshops', { query: { siteId }, schema: allocationWorkshopsSchema, signal })
}

const workOrderWorkshopsSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number(), garments: z.number(), style: z.string() }),
  asOf: z.string(),
  operations: z.array(operationSchema),
  mayOutsource: z.boolean(),
  workshops: z.array(
    z.object({
      ...workshopFields,
      routing: z.boolean(),
      ...verdictFields,
      operations: z.array(z.object({ operationId: z.string(), qualified: z.boolean(), standing: z.string(), words: z.string() })),
    }),
  ),
})
export type WorkOrderWorkshops = z.infer<typeof workOrderWorkshopsSchema>
export type WorkOrderWorkshop = WorkOrderWorkshops['workshops'][number]

/** One work order's workshops for the operations named (default: its outside work), with the capacity once it is added. */
export function getWorkOrderWorkshops(api: ApiClient, workOrderId: string, operationIds?: readonly string[], signal?: AbortSignal): Promise<WorkOrderWorkshops> {
  return api.get(`/planning/work-orders/${encodeURIComponent(workOrderId)}/workshops`, { query: { operationIds: operationIds && operationIds.length > 0 ? operationIds.join(',') : undefined }, schema: workOrderWorkshopsSchema, signal })
}

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
export type KitTiming = z.infer<typeof kitTimingSchema>

/** When the kit must leave for a workshop, what is in it, when the garments are back and what that does to later work. */
export function getKitTiming(api: ApiClient, workOrderId: string, query: { partyId: string; pieces?: number; operationIds?: readonly string[] }, signal?: AbortSignal): Promise<KitTiming> {
  return api.get(`/planning/work-orders/${encodeURIComponent(workOrderId)}/kit-timing`, {
    query: { partyId: query.partyId, pieces: query.pieces === undefined ? undefined : String(query.pieces), operationIds: query.operationIds && query.operationIds.length > 0 ? query.operationIds.join(',') : undefined },
    schema: kitTimingSchema,
    signal,
  })
}

const switchedOperation = z.object({ id: z.string(), seq: z.number(), name: z.string(), version: z.number(), outsourced: z.boolean(), subcontractOrderId: z.string().nullable() })

const outsideAnswer = z.object({
  operation: switchedOperation,
  workshop: named,
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), kitDueAt: z.string() }).nullable(),
  orderWords: z.string().nullable(),
  timing: z.object({ start: z.string(), kitShipOn: z.string(), kitDueAt: z.string(), late: z.boolean(), backOn: z.string() }),
  warnings: z.array(warningReason),
})
export type OutsideAnswer = z.infer<typeof outsideAnswer>

/** One operation to an offered workshop (with its draft subcontract order when the caller may make it): one change. */
export function sendOutside(api: ApiClient, workOrderId: string, operationId: string, body: { version: number; partyId: string; pieces?: number }): Promise<OutsideAnswer> {
  return api.request('POST', `/planning/work-orders/${encodeURIComponent(workOrderId)}/operations/${encodeURIComponent(operationId)}/outside`, { body, schema: outsideAnswer, idempotencyKey: newIdempotencyKey() })
}

const inHouseAnswer = z.object({ operation: switchedOperation, order: z.object({ id: z.string(), number: z.string(), change: z.enum(['CANCELLED', 'OPERATION_REMOVED']).nullable() }).nullable() })
export type InHouseAnswer = z.infer<typeof inHouseAnswer>

/** One outside operation back in-house, with the reason (its draft order cancelled or trimmed): one change. */
export function bringInHouse(api: ApiClient, workOrderId: string, operationId: string, body: { version: number; reason: string }): Promise<InHouseAnswer> {
  return api.request('POST', `/planning/work-orders/${encodeURIComponent(workOrderId)}/operations/${encodeURIComponent(operationId)}/in-house`, { body, schema: inHouseAnswer, idempotencyKey: newIdempotencyKey() })
}

const fromAllocationSchema = z.object({
  preview: z.boolean(),
  made: z.number(),
  held: z.number(),
  asOf: z.string(),
  results: z.array(
    z.object({
      slotId: z.string(),
      ok: z.boolean(),
      workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
      workshop: named.nullable(),
      operations: z.array(z.object({ id: z.string(), seq: z.number(), name: z.string() })),
      pieces: z.number(),
      order: z.object({ id: z.string(), number: z.string(), status: z.string(), kitDueAt: z.string() }).nullable(),
      kitShipOn: z.string().nullable(),
      backOn: z.string().nullable(),
      problems: z.array(z.string()),
      warnings: z.array(warningReason),
    }),
  ),
})
export type FromAllocation = z.infer<typeof fromAllocationSchema>
export type FromAllocationResult = FromAllocation['results'][number]

/** The most parts one "Create subcontract orders" takes (B-W2b-321's MAX_PARTS). */
export const MAX_PARTS = 50

/** "Create subcontract orders (n)": the board's workshop parts, previewed first (`preview: true` writes nothing). */
export function createSubcontractOrders(api: ApiClient, body: { siteId: string; slotIds: readonly string[]; preview: boolean }): Promise<FromAllocation> {
  return api.request('POST', '/planning/allocation/subcontract-orders', {
    body: { siteId: body.siteId, parts: body.slotIds.slice(0, MAX_PARTS).map((slotId) => ({ slotId })), preview: body.preview },
    schema: fromAllocationSchema,
    ...(body.preview ? {} : { idempotencyKey: newIdempotencyKey() }),
  })
}
