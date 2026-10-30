import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { DIFFERENCES, HOLD_REASONS, RECEIPT_LIMITS, RECEIPT_NOTE_CODES } from '@nexus/factory-domain/inventory/receipts/rules'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { PRINT_JOB_STATUSES } from '../../../platform/print/rules'
import { lineInput } from '../receipts/contract'

/**
 * Receiving goods on the floor (B-W1-33; SCM-113, SCM-116, SCM-117, SCM-233, SCM-247, SCM-259, SCM-267, SCM-268, QHS-030;
 * A2 SCR-092 "Receive goods"): a goods-in tablet finds the purchase order (scanned from the PO or the supplier's delivery
 * note, or picked from what is expected at its site), sees what is still to come, receives the hides one by one and the
 * other materials by quantity into lots (held for quality where they must be), and prints each hide's tag on its station's
 * label printer. Nothing here is money: a floor session holds no price, cost or margin grain, and the order's lines are
 * read without their price. Quantities are decimal strings with four decimals; `base…` values are in the material's base
 * unit.
 */

const uom = z.enum(UOMS)
const decimal = z.string()
const party = output({ id: id(), name: z.string() })
const place = output({ id: id(), code: z.string(), name: z.string() })

/** An order the site expects goods against (SENT, CONFIRMED, PARTLY_RECEIVED). */
export const expectedOrderView = output({
  id: id(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  supplier: party,
  /** The earliest date a line still open is needed (or confirmed) for. */
  due: businessDate().nullable(),
  /** Lines with something still to come. */
  openLines: z.number().int(),
  lines: z.number().int(),
  /** Goods were received against it before (a posted receipt). */
  receivedBefore: z.boolean(),
})

export const listExpectedContract = defineContract({
  querystring: input({
    /** A scanned or typed code: the order's number (from the PO or the supplier's delivery note). */
    code: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  response: {
    200: output({
      serverTime: instant(),
      /** What the site expects, earliest due first; with `code`, the order of that number when it takes goods now. */
      orders: z.array(expectedOrderView),
      /** With `code`: the order of that number at this site in any state (null: no order has that number here). */
      found: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
    }),
  },
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    tracking: z.enum(ITEM_TRACKINGS),
    baseUom: uom,
    isPpeComponent: z.boolean(),
  }),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  /** As ordered, in the order line's unit. */
  quantity: decimal,
  uom,
  /** What is expected (the confirmed quantity, else the ordered one), what posted receipts brought, what is still open. */
  expected: decimal,
  received: decimal,
  open: decimal,
  /** The order line's area tolerance (%), null: none. */
  tolerancePct: z.string().nullable(),
  /** The most that is taken without a reason (expected × (1 + tolerance)), less what came before. */
  upTo: decimal,
  needDate: businessDate(),
  confirmedDate: businessDate().nullable(),
  /** Leather: the hides the buyer expects in all, and those received before. */
  estimatedHides: z.number().int().nullable(),
  hidesReceived: z.number().int(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  /** Why a lot of this line starts in quarantine whatever the receiver says (a chromium VI test, a PPE component). */
  holds: z.array(z.enum(HOLD_REASONS)),
  /** The units a hide of this line is measured in (the line's own first). Empty when the line is not leather. */
  areaUnits: z.array(uom),
})

const orderHead = output({
  id: id(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  version: z.number().int(),
  supplier: party,
  requestedDate: businessDate().nullable(),
})

export const orderParams = input({ orderId: id() })

export const getExpectedOrderContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      serverTime: instant(),
      order: orderHead,
      /** Null: goods may be received now; else why not (its status says which: the screen words it). */
      refusal: output({ code: z.enum(['NOT_RECEIVING']), message: z.string() }).nullable(),
      lines: z.array(lineView),
      /** The goods-in dock the goods go to (null: none, or several: the office names one). */
      dock: place.nullable(),
      /** The quality-hold place held lots go to (null: none; they stay at the dock). */
      hold: place.nullable(),
      /** The label printer the hide tags print on: the station's, else the site's only one (null: none). */
      printer: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
    }),
  },
})

const tagView = output({
  hideId: id(),
  code: z.string(),
  /** The print job (null: not queued, `problem` says why). */
  jobId: id().nullable(),
  status: z.enum(PRINT_JOB_STATUSES).nullable(),
  version: z.number().int().nullable(),
  problem: z.string().nullable(),
})

/** The floor's receipt: what was received, in lots and hides, and where each went. No money. */
export const floorReceiptView = output({
  id: id(),
  number: z.string(),
  status: z.enum(['OPEN', 'POSTED', 'REVERSED', 'CANCELLED']),
  receivedAt: instant(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: businessDate().nullable(),
  order: orderHead,
  lines: z.array(
    output({
      seq: z.number().int(),
      purchaseOrderLineId: id().nullable(),
      item: output({ code: z.string(), name: z.string(), tracking: z.enum(ITEM_TRACKINGS) }),
      colour: output({ code: z.string(), name: z.string() }).nullable(),
      quantity: decimal,
      uom,
      baseQuantity: decimal,
      hideCount: z.number().int().nullable(),
      difference: output({ kind: z.enum(DIFFERENCES), expected: decimal, after: decimal, open: decimal, difference: decimal, upTo: decimal }).nullable(),
    }),
  ),
  lots: z.array(
    output({
      id: id(),
      code: z.string(),
      lineSeq: z.number().int(),
      supplierLotRef: z.string().nullable(),
      dyeBatch: z.string().nullable(),
      qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']),
      holds: z.array(z.enum(HOLD_REASONS)),
      requiresCrViTest: z.boolean(),
      crViStatus: z.enum(CR_VI_STATUSES),
      baseQuantity: decimal,
      hideCount: z.number().int(),
      /** Where its stock lies (the hold place for a lot in quarantine when the site has one, else the dock). */
      location: place.nullable(),
    }),
  ),
  hides: z.array(
    output({
      id: id(),
      code: z.string(),
      lotId: id(),
      lotCode: z.string(),
      supplierCode: z.string().nullable(),
      area: decimal,
      areaUom: uom,
      grade: z.string().nullable(),
      shade: z.string().nullable(),
      thicknessMm: z.string().nullable(),
    }),
  ),
  /** The tags of its hides on the label printer, one job each. */
  tags: output({ printer: output({ id: id(), code: z.string(), name: z.string() }).nullable(), jobs: z.array(tagView) }),
})

export const receiveOnFloorContract = defineContract({
  params: orderParams,
  body: input({
    /** The order's version as the screen read it: a newer one (the buyer changed it) is a 409, read it again. */
    version: z.number().int().min(1),
    supplierDdtNumber: z.string().trim().min(1).max(RECEIPT_LIMITS.code).nullish(),
    supplierDdtDate: businessDate().nullish(),
    /** When the goods arrived. Default now; at most 5 minutes ahead of the server. */
    receivedAt: instant().optional(),
    note: z.string().trim().max(1000).nullish(),
    lines: z.array(lineInput).min(1).max(RECEIPT_LIMITS.lines),
    /** Print the hide tags at once: on this label printer (default the station's, else the site's only one); null: not now. */
    printerId: id().nullish(),
    /** The tags' language. Default it. */
    language: z.enum(['it', 'en']).optional(),
  }),
  response: {
    201: output({
      receipt: floorReceiptView,
      /** What differs from the order, as codes with the API's words (the screen words them itself). */
      notes: z.array(output({ code: z.enum(RECEIPT_NOTE_CODES), seq: z.number().int().nullable(), message: z.string() })),
    }),
  },
})

export const receiptParams = input({ receiptId: id() })

export const getFloorReceiptContract = defineContract({ params: receiptParams, response: { 200: output({ receipt: floorReceiptView }) } })

export const printTagsContract = defineContract({
  params: receiptParams,
  body: input({
    /** The hides whose tags print (default every hide of the receipt). */
    hideIds: z.array(id()).min(1).max(RECEIPT_LIMITS.moves).optional(),
    printerId: id().nullish(),
    language: z.enum(['it', 'en']).optional(),
    /** A reprint says why (logged with the job, SCM-268). */
    reason: z.enum(['DAMAGED', 'LOST', 'NOT_PRINTED', 'OTHER']).optional(),
  }),
  response: { 200: output({ receipt: floorReceiptView }) },
})
