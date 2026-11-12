import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { GOODS_RECEIPT_STATUSES } from '@nexus/factory-domain/inventory/receipts/rules'
import { DEMAND_KINDS, REPORT_HELD, REPORT_LIMITS, SERVE_HELD, SERVE_WHY } from '@nexus/factory-domain/inventory/reception-report/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * The reception report of a goods receipt (B-W2b-300; SCM-119; design warehouse.receipts pop:rc-reception): which work orders and
 * orders its goods serve, what to reserve for them now, reserved in one step, and the report sent to the buyer. Quantities are
 * decimal strings with four decimals in the material's base unit. No money, no customer's name.
 */

const decimal = z.string()
const params = input({ receiptId: id() })

const serve = output({
  /** `WORK_ORDER:<id>` or `ORDER_LINE:<id>`: what the reserve names. */
  key: z.string(),
  kind: z.enum(DEMAND_KINDS),
  why: z.enum(SERVE_WHY),
  workOrder: output({ id: id(), number: z.string(), status: z.string(), dueDate: businessDate().nullable() }).nullable(),
  orderLine: output({ id: id(), number: z.string(), seq: z.number().int(), status: z.string() }).nullable(),
  needDate: businessDate().nullable(),
  /** What the plan counted on from the receipt's order line for it (PEGGED). */
  pegged: decimal.nullable(),
  /** What it still needs of the material. */
  open: decimal,
  /** What of this receipt's goods is reserved for it already. */
  reservedHere: decimal,
  /** What to reserve now, and from which lots. */
  proposed: decimal,
  lots: z.array(output({ lotId: id().nullable(), quantity: decimal })),
  held: z.enum(SERVE_HELD).nullable(),
})

export const reportContract = defineContract({
  params,
  response: {
    200: output({
      receipt: output({ id: id(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES), companyId: id(), siteId: id(), purchaseOrder: output({ id: id(), number: z.string(), partyId: id() }).nullable() }),
      held: z.enum(REPORT_HELD).nullable(),
      /** The planning run the pegging came from (the site's latest finished one). */
      run: output({ id: id(), finishedAt: instant().nullable() }).nullable(),
      /** The purchase order's buyer (who made it), told by the note. */
      buyer: output({ id: id(), name: z.string() }).nullable(),
      lines: z.array(
        output({
          receiptLineId: id(),
          seq: z.number().int(),
          purchaseOrderLineId: id().nullable(),
          item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(['NONE', 'LOT', 'HIDE']) }),
          colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          received: decimal,
          lots: z.array(output({ id: id().nullable(), code: z.string().nullable(), qualityStatus: z.string().nullable(), free: decimal, held: z.boolean() })),
          serves: z.array(serve),
          /** Free after the proposals: to stock. */
          left: decimal,
        }),
      ),
      /** How many demands have something to reserve now ("Reserve for 3 work orders"). */
      proposals: z.number().int(),
      can: output({ reserve: z.boolean(), send: z.boolean() }),
    }),
  },
})

const sentView = output({ messageId: id(), buyerTold: z.boolean() })

export const reserveContract = defineContract({
  params,
  body: input({
    demands: z.array(input({ receiptLineId: id(), key: z.string().min(3).max(60) })).min(1).max(REPORT_LIMITS.demands),
    /** Send the report to the buyer in the same step (an internal note on the purchase order). */
    tellBuyer: z.boolean().optional(),
    note: z.string().trim().max(REPORT_LIMITS.note).nullish(),
  }),
  response: {
    200: output({
      reservationIds: z.array(id()),
      /** Chosen demands that had nothing to take now, with why. */
      skipped: z.array(output({ receiptLineId: id(), key: z.string(), held: z.string() })),
      sent: sentView.nullable(),
    }),
  },
})

export const sendContract = defineContract({
  params,
  body: input({ note: z.string().trim().max(REPORT_LIMITS.note).nullish() }),
  response: { 200: output({ sent: sentView }) },
})
