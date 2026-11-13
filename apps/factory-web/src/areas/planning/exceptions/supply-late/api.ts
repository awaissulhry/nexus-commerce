import { z } from 'zod'
import { RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The supply-too-late calls of Planning › Exceptions (SCR-125; design planning.exceptions › tiles "Supplier dates later than
 * needed (W2b)", the detail's fixes "chase PO-0091 · move WO-0221 on the board · buy elsewhere · re-promise (W2b)"). The shapes
 * mirror apps/factory-api modules/planning/exceptions/supply-late.ts (B-W2b-317); unknown fields dropped. The API's English
 * (`sentence`, every `words`) is never drawn: the screen says each fix from its facts. No money; no person.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const day = z.string()

const fixesSchema = z.object({
  chase: z
    .object({
      purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
      supplier: named.nullable(),
      line: z.object({ id: z.string(), seq: z.number(), item: z.string() }),
      supplyDate: day.nullable(),
      needDate: day.nullable(),
      daysLate: z.number().nullable(),
    })
    .nullable(),
  move: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: day.nullable() }),
      plannedStart: z.string().nullable(),
      plannedFinish: z.string().nullable(),
      materialState: z.string().nullable(),
      earliestStart: day.nullable(),
      inTime: z.boolean().nullable(),
    }),
  ),
  buyElsewhere: z.array(z.object({ supplier: named, sourceId: z.string(), leadTimeDays: z.number().nullable(), arrives: day.nullable(), inTime: z.boolean().nullable(), requirementId: z.string().nullable() })),
  repromise: z.array(
    z.object({
      orderLine: z.object({ id: z.string(), seq: z.number() }),
      order: z.object({ id: z.string(), number: z.string(), status: z.string() }),
      customer: named,
      current: day.nullable(),
      finish: day.nullable(),
      risk: z.enum(RISK_STATES).nullable(),
      waiting: z.object({ proposalId: z.string() }).nullable(),
      may: z.boolean(),
    }),
  ),
})
export type SupplyLateFixes = z.infer<typeof fixesSchema>

export const supplyLateSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  status: z.string(),
  version: z.number(),
  purchaseOrderLineId: z.string().nullable(),
  record: z.object({ type: z.string(), id: z.string() }).nullable(),
  foundBy: z.enum(['RUN', 'SUPPLIER_DATE']),
  supplyDate: day.nullable(),
  needDate: day.nullable(),
  overdue: z.boolean(),
  daysLate: z.number().nullable(),
  ordersAffected: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  fixes: fixesSchema.nullable(),
})
export type SupplyLate = z.infer<typeof supplyLateSchema>

const listSchema = z.object({ site: named, asOf: z.string(), tile: z.number(), exceptions: z.array(supplyLateSchema) })
export type SupplyLateList = z.infer<typeof listSchema>

const enc = encodeURIComponent

/** GET /planning/exceptions/supply-late: the tile "Supplier dates later than needed" and each open exception with its fixes. */
export const supplyLateList = (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<SupplyLateList> => api.get('/planning/exceptions/supply-late', { query: { siteId }, schema: listSchema, signal })

/** GET /planning/exceptions/:id/fixes: one supply-too-late exception's fixes, read now. */
export const supplyLateFixes = (api: ApiClient, exceptionId: string, signal?: AbortSignal): Promise<SupplyLate> => api.get(`/planning/exceptions/${enc(exceptionId)}/fixes`, { schema: supplyLateSchema, signal })

const checkSchema = z.object({ checked: z.boolean(), raised: z.number(), stillOpen: z.number(), cleared: z.number(), replayed: z.boolean(), view: listSchema })
export type SupplyLateCheck = z.infer<typeof checkSchema>

/** POST /planning/exceptions/supply-late/check: "Check now" — the purchase order's dates against what its lines feed. */
export const checkSupplyLate = (api: ApiClient, purchaseOrderId: string, idempotencyKey: string): Promise<SupplyLateCheck> =>
  api.post('/planning/exceptions/supply-late/check', { body: { purchaseOrderId }, schema: checkSchema, idempotencyKey })
