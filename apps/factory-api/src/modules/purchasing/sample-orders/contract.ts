import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { MAX_TEXT, PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { MAX_SAMPLE_LINES, SAMPLE_LINE_KINDS } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'

/**
 * The contracts of sample and development orders (B-W2b-347; SCM-043; design purchasing.sourcing, SCR-222). A sample order is a
 * purchase order (kind SAMPLE): its value is a cost (money.cost: dropped for a caller without the cost grain, the column then
 * not drawn); every other write of it is W1's on the order record (lines, header, send, cancel).
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })

/** The sample round an order buys for. */
export const roundRef = output({ id: id(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number().int(), stage: z.enum(SAMPLE_STAGES) })

/** The PO record's "of type Sample" (GET /purchasing/orders/:id `sample`; null for a production order). */
export const sampleOfOrderView = output({ style: ref.nullable(), round: roundRef.nullable() })

export const sampleRowView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  siteId: id(),
  partyId: id(),
  supplierName: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  revision: z.number().int(),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  /** The development project: the style, and the sample round when it buys for one. */
  style: ref.nullable(),
  round: roundRef.nullable(),
  /** What it buys: the first lines' materials (not cancelled), and how many lines in all. */
  items: z.array(output({ code: z.string(), name: z.string(), kind: z.string(), description: z.string().nullable() })),
  lineCount: z.number().int(),
  netAmount: money.cost(z.number().int()),
  sentAt: instant().nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})

export const LIST_ROWS = ['OPEN', 'ALL'] as const

export const listSampleOrdersContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    /** OPEN (default): not cancelled, closed or received in full; ALL: every one. */
    rows: z.enum(LIST_ROWS).default('OPEN'),
    status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
    styleId: id().optional(),
    /** The number, the supplier's name, the style's code or name, case-insensitive. */
    q: z.string().trim().min(1).max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      orders: z.array(sampleRowView),
      nextCursor: id().nullable(),
      /** When this answer was read (the band's AsOf). */
      readAt: instant(),
    }),
  },
})

export const sampleChoicesContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      /** The only site the caller may order for, else null (the dialog asks). */
      defaultSiteId: id().nullable(),
      suppliers: z.array(output({ id: id(), code: z.string(), name: z.string(), currency: z.string(), language: z.string() })),
      styles: z.array(output({ id: id(), code: z.string(), name: z.string(), lifecycle: z.string(), rounds: z.array(roundRef) })),
      materials: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          kind: z.string(),
          baseUom: z.enum(UOMS),
          purchaseUom: z.enum(UOMS),
          /** Every unit the material converts (the line's unit is one of them). */
          units: z.array(z.enum(UOMS)),
          colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
        }),
      ),
      /** False when a list was cut at its limit (the dialog says so). */
      complete: z.boolean(),
    }),
  },
})

const text = (max: number) => z.string().trim().max(max)

export const createSampleOrderContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id(),
    partyId: id(),
    developmentStyleId: id(),
    sampleRoundId: id().nullish(),
    requestedDate: businessDate().nullish(),
    /** Words for the supplier, printed on the PDF. */
    note: text(MAX_TEXT.note).nullish(),
    lines: z
      .array(
        input({
          what: z.enum(SAMPLE_LINE_KINDS),
          itemId: id(),
          itemColourId: id().nullish(),
          quantity: quantity(),
          /** Default the material's purchase unit; any unit it converts. */
          uom: z.enum(UOMS).optional(),
          needDate: businessDate(),
          /** The buyer's own words after the sample words ("20 × 20 cm"). */
          description: text(200).nullish(),
        }),
      )
      .min(1)
      .max(MAX_SAMPLE_LINES),
  }),
  response: { 201: output({ order: sampleRowView }) },
})

export const sampleOrderPdfContract = defineContract({
  params: input({ purchaseOrderId: id() }),
  /** The language of a draft's preview (default the supplier's); a sent order is the PDF as it was sent. */
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {},
})
