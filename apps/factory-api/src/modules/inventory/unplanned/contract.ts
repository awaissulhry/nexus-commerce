import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { GOODS_RECEIPT_STATUSES, RECEIPT_LIMITS, RECEIPT_NOTE_CODES } from '@nexus/factory-domain/inventory/receipts/rules'
import { UNPLANNED_LIMITS, UNPLANNED_STATES } from '@nexus/factory-domain/inventory/unplanned/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122): the goods-in tablet takes them in to a holding place; the buyer names
 * the order (and they post) or sends them back. Nothing here is money. Quantities are decimal strings with four decimals,
 * `base…` in the material's base unit.
 */

const uom = z.enum(UOMS)
const decimal = z.string()
const tracking = z.enum(['NONE', 'LOT', 'HIDE'])
const place = output({ id: id(), code: z.string(), name: z.string() })
const colour = output({ code: z.string(), name: z.string() })
const params = input({ receiptId: id() })

// ---- the floor ----------------------------------------------------------------------------------------------------------------

export const startContract = defineContract({
  querystring: input({ q: z.string().trim().min(1).max(80).optional() }),
  response: {
    200: output({
      serverTime: instant(),
      /** Where the site's goods without a PO wait (where the last ones waited); null: scan the holding place's label. */
      holding: place.nullable(),
      suppliers: z.array(output({ id: id(), code: z.string(), name: z.string() })),
    }),
  },
})

export const itemsContract = defineContract({
  querystring: input({ q: z.string().trim().min(1).max(80) }),
  response: {
    200: output({
      items: z.array(output({ id: id(), code: z.string(), name: z.string(), tracking, baseUom: uom, purchaseUom: uom, colours: z.array(output({ id: id(), code: z.string(), name: z.string() })) })),
    }),
  },
})

export const floorUnplannedView = output({
  id: id(),
  number: z.string(),
  state: z.enum(UNPLANNED_STATES),
  supplier: output({ id: id(), name: z.string() }),
  holding: place.nullable(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: businessDate().nullable(),
  receivedAt: instant(),
  /** The buyer's task was made (the office sees who). */
  buyerAsked: z.boolean(),
  /** Photos of the supplier's DDT on the receipt. */
  ddtPhotos: z.number().int(),
  lines: z.array(output({ id: id(), seq: z.number().int(), label: z.string(), item: output({ id: id(), code: z.string(), name: z.string(), tracking }), colour: colour.nullable(), quantity: decimal, uom, hideCount: z.number().int().nullable() })),
})

export const receiveContract = defineContract({
  body: input({
    supplierId: id(),
    holdingLocationId: id().optional(),
    /** The holding place's label (or code) as scanned. */
    placeCode: z.string().trim().min(1).max(80).optional(),
    supplierDdtNumber: z.string().trim().min(1).max(RECEIPT_LIMITS.code).nullish(),
    supplierDdtDate: businessDate().nullish(),
    receivedAt: instant().optional(),
    note: z.string().trim().max(UNPLANNED_LIMITS.text).nullish(),
    lines: z
      .array(
        input({
          itemId: id(),
          itemColourId: id().nullish(),
          quantity: z.string().trim().min(1).max(20),
          /** Default the material's base unit. */
          uom: uom.optional(),
          hideCount: z.number().int().min(1).max(UNPLANNED_LIMITS.hides).nullish(),
          note: z.string().trim().max(UNPLANNED_LIMITS.text).nullish(),
        }),
      )
      .min(1)
      .max(UNPLANNED_LIMITS.lines),
  }),
  response: { 201: output({ receipt: floorUnplannedView }) },
})

export const floorGetContract = defineContract({ params, response: { 200: output({ receipt: floorUnplannedView }) } })

// ---- the office ---------------------------------------------------------------------------------------------------------------

const item = output({ id: id(), code: z.string(), name: z.string(), tracking, baseUom: uom })
const colourRef = output({ id: id(), code: z.string(), name: z.string() })

export const detailContract = defineContract({
  params,
  response: {
    200: output({
      receipt: output({
        id: id(),
        number: z.string(),
        status: z.enum(GOODS_RECEIPT_STATUSES),
        state: z.enum(UNPLANNED_STATES),
        version: z.number().int(),
        companyId: id(),
        site: place,
        supplier: output({ id: id(), code: z.string(), name: z.string() }),
        holding: place.nullable(),
        supplierDdtNumber: z.string().nullable(),
        supplierDdtDate: businessDate().nullable(),
        receivedAt: instant(),
        note: z.string().nullable(),
        purchaseOrder: output({ id: id(), number: z.string() }).nullable(),
        ddtPhotos: z.array(output({ id: id(), originalName: z.string() })),
      }),
      lines: z.array(output({ id: id(), seq: z.number().int(), item, colour: colourRef.nullable(), quantity: decimal, uom, baseQuantity: decimal, hideCount: z.number().int().nullable(), note: z.string().nullable() })),
      buyerTask: output({ id: id(), title: z.string(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']), dueDate: businessDate().nullable(), assignee: output({ id: id(), name: z.string() }).nullable() }).nullable(),
      /** The supplier's orders to this site that take goods now (while the goods wait). */
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          version: z.number().int(),
          requestedDate: businessDate().nullable(),
          lines: z.array(output({ id: id(), seq: z.number().int(), item, colour: colourRef.nullable(), quantity: decimal, uom, openBase: decimal, tolerancePct: z.string().nullable() })),
          fits: z.array(output({ receiptLineId: id(), purchaseOrderLineIds: z.array(id()) })),
        }),
      ),
      can: output({ decide: z.boolean(), askBuyer: z.boolean() }),
    }),
  },
})

export const nameOrderContract = defineContract({
  params,
  body: input({
    version: z.number().int().min(1),
    purchaseOrderId: id(),
    lines: z
      .array(
        input({
          receiptLineId: id(),
          purchaseOrderLineId: id(),
          supplierLotRef: z.string().trim().min(1).max(RECEIPT_LIMITS.code).nullish(),
          dyeBatch: z.string().trim().min(1).max(RECEIPT_LIMITS.code).nullish(),
          /** Leather: each hide's area, in the unit the floor counted the line in. */
          hideAreas: z.array(z.string().trim().min(1).max(20)).max(UNPLANNED_LIMITS.hides).optional(),
          differenceReason: z.string().trim().min(1).max(RECEIPT_LIMITS.text).optional(),
        }),
      )
      .min(1)
      .max(UNPLANNED_LIMITS.lines),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: {
    200: output({
      receiptId: id(),
      number: z.string(),
      purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }),
      notes: z.array(output({ code: z.enum(RECEIPT_NOTE_CODES), seq: z.number().int().nullable(), message: z.string() })),
      moves: z.number().int(),
    }),
  },
})

export const sendBackContract = defineContract({
  params,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(UNPLANNED_LIMITS.text) }),
  response: { 200: output({ receiptId: id(), number: z.string(), status: z.literal('CANCELLED') }) },
})

export const askBuyerContract = defineContract({
  params,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ buyerTaskId: id().nullable() }) },
})
