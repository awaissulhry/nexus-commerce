import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_CONVERT, PLANNED_ORDER_KINDS, PLANNED_ORDER_STATUSES, PROTECTABLE_FIELDS } from '@nexus/factory-domain/planning/planned-orders/rules'
import { MAX_NOTE } from '@nexus/factory-domain/planning/decisions'

/**
 * Planned work orders and planned subcontract orders (B-W2b-293; PLN-067, PLN-068, PLN-069, PLN-089; design planning.mrp
 * "To make" with "Create 4 work orders" / "Create 2 subcontract orders" in a ReviewChangesModal). Days are calendar days at
 * the site; quantities are whole garments. No money.
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const revision = output({ id: id(), revision: z.number().int(), status: z.string() })
const step = output({ seq: z.number().int(), code: z.string(), name: z.string() })
const record = output({ id: id(), number: z.string(), status: z.string() })

export const plannedOrderView = output({
  id: id(),
  kind: z.enum(PLANNED_ORDER_KINDS),
  status: z.enum(PLANNED_ORDER_STATUSES),
  siteId: id(),
  /** The latest run that proposed it or moved it on. */
  runId: id(),
  style: named,
  colourway: output({ id: id(), code: z.string() }),
  /** PLN-089: the revision the order lines name; null: the style's RELEASED one when it is made real. */
  revision: revision.nullable(),
  /** The revision it plans now (the one named, else the released one): its routing gives the steps. */
  plannedRevision: revision.nullable(),
  /** The size run (PLN-068: one grid, or the sizes of one group). */
  sizes: z.array(output({ size: z.string(), quantity: z.number().int() })),
  quantity: z.number().int(),
  /** The size group it was split by ("44-50"); null: one grid. */
  sizeGroup: z.string().nullable(),
  startDate: businessDate(),
  dueDate: businessDate(),
  /** The order lines it makes, per size. */
  demand: z.array(output({ orderId: id(), orderNumber: z.string(), orderLineId: id(), lineSeq: z.number().int(), size: z.string(), pieces: z.number().int() })),
  /** MAKE: the line it is planned on; null: not allocated. */
  line: named.nullable(),
  /** SUBCONTRACT: the workshop, the routing steps it does, when the kit leaves. */
  workshop: named.nullable(),
  operations: z.array(step),
  /** MAKE: routing steps that name a workshop which may not get work now (it is made in-house, said). */
  outsideStepsInHouse: z.array(step),
  kitDueAt: instant().nullable(),
  firm: z.boolean(),
  firmedAt: instant().nullable(),
  /** The fields a planner protected from the next run (B-W2b-306). */
  protectedFields: z.array(z.enum(PROTECTABLE_FIELDS)),
  /** What it became once made real. */
  workOrder: record.nullable(),
  subcontractOrder: record.nullable(),
  convertedAt: instant().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  /** Why it cannot be made real now, in words; null: it can. */
  held: z.string().nullable(),
  may: output({ convert: z.boolean(), firm: z.boolean() }),
})
export type PlannedOrderView = z.infer<typeof plannedOrderView>

export const listPlannedOrdersContract = defineContract({
  querystring: input({ siteId: id(), status: z.enum(PLANNED_ORDER_STATUSES).optional(), kind: z.enum(PLANNED_ORDER_KINDS).optional() }),
  response: {
    200: output({
      siteId: id(),
      /** The site's latest DONE run (the plan the rows come from). */
      run: output({ id: id(), startedAt: instant(), finishedAt: instant().nullable() }).nullable(),
      /** Still PLANNED at the site: to make in-house, at a workshop, and of them firm. */
      counts: output({ make: z.number().int(), subcontract: z.number().int(), firm: z.number().int() }),
      plannedOrders: z.array(plannedOrderView),
    }),
  },
})

export const getPlannedOrderContract = defineContract({
  params: input({ plannedOrderId: id() }),
  response: { 200: output({ plannedOrder: plannedOrderView }) },
})

export const firmPlannedOrderContract = defineContract({
  params: input({ plannedOrderId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ plannedOrder: plannedOrderView, replayed: z.boolean() }) },
})

const convertResult = output({
  id: id(),
  /** null: the row was not found (or is not the caller's). */
  kind: z.enum(PLANNED_ORDER_KINDS).nullable(),
  /** Preview: it can be made real now; after: it was. */
  ok: z.boolean(),
  /** What it becomes (preview) or became. */
  workOrder: output({ id: id().nullable(), number: z.string().nullable(), status: z.string().nullable(), revision: z.number().int().nullable(), dueDate: businessDate(), cells: z.number().int(), pieces: z.number().int() }).nullable(),
  subcontractOrder: output({ id: id().nullable(), number: z.string().nullable(), workshop: named.nullable(), operations: z.array(step), kitDueAt: instant().nullable() }).nullable(),
  /** Why it cannot be made real (preview), or what stopped it (each in words). */
  problems: z.array(z.string()),
  /** After a refusal: the error's code (a 409's `conflict`, `invalid_state`, a 400's `validation_failed`, `forbidden`). */
  error: z.string().nullable(),
})

export const convertPlannedOrdersContract = defineContract({
  body: input({
    rows: z
      .array(
        input({
          id: id(),
          version: z.number().int().min(1),
          /** SUBCONTRACT: the work order already made from it (a release that was held the first time). */
          workOrderId: id().optional(),
        }),
      )
      .min(1)
      .max(MAX_CONVERT),
    /** true: say what each would become and what holds it; nothing is written. */
    preview: z.boolean().optional(),
    /** SUBCONTRACT: the planner's override of a material shortage at the work order's release, with its reason. */
    materialOverride: input({ reason: z.string().trim().min(1).max(MAX_NOTE) }).optional(),
  }),
  response: { 200: output({ preview: z.boolean(), made: z.number().int(), held: z.number().int(), results: z.array(convertResult) }) },
})
export type ConvertResult = z.infer<typeof convertResult>
