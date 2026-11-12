import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXPEDITE_REASONS, MAX_CHASE_MESSAGE } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { orderView } from '../contract'

/**
 * The contracts of the expediting worklist, the demand of each line and the chase (B-W2b-305; SCM-068, SCM-064). Days,
 * quantities in the material's base unit, order numbers and states: no money, no customer name.
 */

const version = z.number().int().min(1)
const orderParams = input({ purchaseOrderId: id() })
const day = z.string()
const reason = z.enum(EXPEDITE_REASONS)

const blockedView = output({
  kind: z.string(),
  workOrder: output({ id: id(), number: z.string(), status: z.string(), dueDate: day.nullable() }).nullable(),
  salesOrder: output({ id: id(), number: z.string(), promiseDate: day.nullable() }).nullable(),
  size: z.string().nullable(),
  demandDate: day,
  quantity: z.string(),
  /** Days the line puts this demand late (0: in time). */
  lateBy: z.number().int(),
})

const planView = output({ runId: id().nullable(), finishedAt: instant().nullable() })

export const worklistContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    partyId: id().optional(),
    reason: reason.optional(),
    atRisk: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: z.string().max(20).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      today: day,
      complete: z.boolean(),
      tiles: output({ late: z.number().int(), notConfirmed: z.number().int(), confirmedLate: z.number().int(), atRisk: z.number().int(), salesOrdersAtRisk: z.number().int() }),
      plans: z.array(output({ siteId: id(), runId: id().nullable(), finishedAt: instant().nullable() })),
      rows: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          purchaseOrderId: id(),
          number: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          revision: z.number().int(),
          version: z.number().int(),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          supplierName: z.string(),
          item: output({ code: z.string(), name: z.string() }),
          colour: output({ code: z.string(), name: z.string() }).nullable(),
          baseUom: z.string().nullable(),
          outstandingBase: z.string(),
          needDate: day,
          confirmedDate: day.nullable(),
          expectedDate: day,
          nextDelivery: output({ seq: z.number().int(), needDate: day, confirmedDate: day.nullable() }).nullable(),
          daysLate: z.number().int(),
          confirmedLaterBy: z.number().int(),
          confirmBy: instant().nullable(),
          reasons: z.array(reason),
          blocks: output({ entries: z.array(blockedView), salesOrdersAtRisk: z.number().int(), workOrdersAtRisk: z.number().int(), earliestPromise: day.nullable() }),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
  },
})

export const demandContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      demand: output({
        orderId: id(),
        plan: planView,
        lines: z.array(
          output({
            lineId: id(),
            seq: z.number().int(),
            item: output({ code: z.string(), name: z.string() }),
            ended: z.enum(['CANCELLED', 'CLOSED_SHORT']).nullable(),
            expectedDate: day,
            outstandingBase: z.string(),
            demands: z.array(blockedView),
            salesOrdersAtRisk: z.number().int(),
            workOrdersAtRisk: z.number().int(),
          }),
        ),
        workOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), dueDate: day.nullable() })),
        salesOrders: z.array(output({ id: id(), number: z.string(), promiseDate: day.nullable() })),
      }),
    }),
  },
})

export const chasePreviewContract = defineContract({
  params: orderParams,
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {
    200: output({
      chase: output({
        orderId: id(),
        version: z.number().int(),
        allowed: z.boolean(),
        why: z.string().nullable(),
        lines: z.array(output({ lineId: id(), seq: z.number().int(), label: z.string(), needDate: day, confirmedDate: day.nullable(), expectedDate: day, daysLate: z.number().int(), confirmedLaterBy: z.number().int(), reasons: z.array(reason) })),
        recipient: output({ contactId: id(), name: z.string(), email: z.string().nullable() }).nullable(),
        language: z.enum(['it', 'en']),
        subject: z.string(),
        body: z.string(),
      }),
    }),
  },
})

export const chaseContract = defineContract({
  params: orderParams,
  body: input({ version, lineIds: z.array(id()).min(1).max(200).optional(), message: z.string().trim().max(MAX_CHASE_MESSAGE).nullish() }),
  response: { 200: output({ order: orderView, chase: output({ lineIds: z.array(id()), to: z.string(), emailId: id(), sentAt: instant(), language: z.enum(['it', 'en']) }) }) },
})
