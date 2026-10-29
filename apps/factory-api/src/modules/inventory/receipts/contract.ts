import { z } from 'zod'
import { amountMinor, businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { DIFFERENCES, GOODS_RECEIPT_STATUSES, HOLD_REASONS, RECEIPT_LIMITS, RECEIPT_NOTE_CODES, REVERSAL_BLOCKERS } from '@nexus/factory-domain/inventory/receipts/rules'
import { money } from '@nexus/factory-domain/money/marked'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { moveView } from '../ledger/contract'

/**
 * Goods receipts against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-121, SCM-187, SCM-232, SCM-233,
 * SCM-247; A2 SCR-061, SCR-062, SCR-063). Quantities are decimal strings with four decimals; `baseQuantity` is in the
 * material's base unit. Values are the cost grain: marked money.cost, so a caller without it never receives them.
 */

const uom = z.enum(UOMS)
const decimal = z.string()
const text = (max: number = RECEIPT_LIMITS.text) => z.string().trim().max(max)
const code = () => z.string().trim().min(1).max(RECEIPT_LIMITS.code)
const version = z.number().int().min(1)

// ---- record ----------------------------------------------------------------------------------------------------------------

const hideInput = input({
  /** The tannery's own number on the hide. */
  supplierCode: code().nullish(),
  /** As measured at the dock, above 0. */
  area: quantity(),
  /** m², dm² or ft². Default the order line's area unit, else the material's base unit. */
  areaUom: uom.optional(),
  grade: text(40).nullish(),
  /** Default the lot's shade. */
  shade: text(60).nullish(),
  thicknessMm: z.string().trim().max(10).nullish(),
  defects: text(1000).nullish(),
})

const lotInput = input({
  /** The supplier's batch number. */
  supplierLotRef: code().nullish(),
  /** The tannery's dye batch (one shade). */
  dyeBatch: code().nullish(),
  shade: text(60).nullish(),
  /** A lot-tracked material: how much came in this lot, in the line's unit. */
  quantity: quantity().optional(),
  /** For a unit of the item's own size (ROLL …): what the lot measures in the base unit. */
  baseQuantity: quantity().optional(),
  /** Hold the lot in quarantine for a quality check, with the reason (the quality step releases it). */
  holdReason: text().optional(),
  /** Leather: the hides one by one. */
  hides: z.array(hideInput).max(RECEIPT_LIMITS.hidesPerLot).optional(),
})

const lineInput = input({
  purchaseOrderLineId: id(),
  /** An untracked material: how much came, in `uom`. */
  quantity: quantity().optional(),
  /** Default the order line's unit. Not for leather (its hides' unit). */
  uom: uom.optional(),
  baseQuantity: quantity().optional(),
  lots: z.array(lotInput).max(RECEIPT_LIMITS.lotsPerLine).optional(),
  /** More than the order line's tolerance allows came: why it is taken. */
  differenceReason: text().optional(),
  note: text().nullish(),
})

// ---- views -------------------------------------------------------------------------------------------------------------------

const value = money.cost(output({ currency: z.string(), valueAmount: money.cost(amountMinor()) }).nullable())

const hideView = output({
  id: id(),
  code: z.string(),
  supplierCode: z.string().nullable(),
  area: decimal,
  areaUom: uom,
  baseArea: decimal,
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  defects: z.string().nullable(),
  state: z.enum(HIDE_STATES),
})

const lotView = output({
  id: id(),
  code: z.string(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: instant().nullable(),
  qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']),
  qualityNote: z.string().nullable(),
  requiresCrViTest: z.boolean(),
  crViStatus: z.enum(CR_VI_STATUSES),
  crViLimitMgKg: z.string().nullable(),
  /** Why it starts (or stays) in quarantine. */
  holds: z.array(z.enum(HOLD_REASONS)),
  /** Its state in words ("In quarantine: waits for its chromium VI result …"). */
  words: z.string(),
  /** What its receipt moves brought, in the base unit. */
  baseQuantity: decimal,
  hideCount: z.number().int(),
})

const differenceView = output({
  kind: z.enum(DIFFERENCES),
  expected: decimal,
  receivedBefore: decimal,
  after: decimal,
  open: decimal,
  difference: decimal,
  tolerancePct: z.string(),
  upTo: decimal,
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  purchaseOrderLineId: id().nullable(),
  item: output({ id: id(), code: z.string(), name: z.string(), tracking: z.enum(ITEM_TRACKINGS), baseUom: uom }),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  quantity: decimal,
  uom,
  baseQuantity: decimal,
  hideCount: z.number().int().nullable(),
  note: z.string().nullable(),
  /** The order line: ordered, expected (confirmed), received by every posted receipt, still open. */
  orderLine: output({
    seq: z.number().int(),
    quantity: decimal,
    uom,
    baseQuantity: decimal,
    expected: decimal,
    received: decimal,
    open: decimal,
    tolerancePct: z.string().nullable(),
    estimatedHides: z.number().int().nullable(),
    oneDyeBatch: z.boolean(),
    requiresCrViTest: z.boolean(),
  }).nullable(),
  /** This receipt's line against the order line, as it was when the receipt was posted. */
  difference: differenceView.nullable(),
  lots: z.array(lotView),
  value,
})

const blockerView = output({
  code: z.enum(REVERSAL_BLOCKERS),
  path: z.string(),
  message: z.string(),
  /** The work order number, the location code or the move's reason. */
  where: z.string(),
  /** The lots and hides this use concerns. */
  items: z.array(output({ kind: z.enum(['LOT', 'HIDE']), code: z.string() })),
})

export const receiptView = output({
  id: id(),
  number: z.string(),
  status: z.enum(GOODS_RECEIPT_STATUSES),
  companyId: id(),
  siteId: id(),
  site: output({ code: z.string(), name: z.string() }),
  supplier: output({ id: id(), name: z.string() }),
  purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES), version: z.number().int() }).nullable(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: businessDate().nullable(),
  receivedAt: instant(),
  note: z.string().nullable(),
  /** Where its moves put the goods. */
  location: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  postedAt: instant().nullable(),
  postedById: id().nullable(),
  reversedAt: instant().nullable(),
  reversedById: id().nullable(),
  reversalReason: z.string().nullable(),
  cancelledAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  createdById: id().nullable(),
  /** Two numbers for leather: hides and area, per base unit. */
  summary: output({
    lines: z.number().int(),
    lots: z.number().int(),
    lotsInQuarantine: z.number().int(),
    lotsReleased: z.number().int(),
    hides: z.number().int(),
    quantities: z.array(output({ uom, baseQuantity: decimal })),
  }),
  lines: z.array(lineView),
  /** POSTED: may it be reversed now, and if not what used its stock (in words). */
  reversal: output({ possible: z.boolean(), /** The goods-in location the stock must lie at (its code). */ location: z.string().nullable(), blockers: z.array(blockerView) }).nullable(),
  value,
})

export const recordReceiptContract = defineContract({
  body: input({
    purchaseOrderId: id(),
    /** Where the goods go (a location of the order's site). Default the site's one goods-in dock. */
    locationId: id().optional(),
    supplierDdtNumber: code().nullish(),
    supplierDdtDate: businessDate().nullish(),
    /** When the goods arrived. Default now; never in the future. */
    receivedAt: instant().optional(),
    note: text(1000).nullish(),
    lines: z.array(lineInput).min(1).max(RECEIPT_LIMITS.lines),
  }),
  response: {
    201: output({
      receipt: receiptView,
      /** What differs from the order, in words (never blocking). */
      notes: z.array(output({ code: z.enum(RECEIPT_NOTE_CODES), seq: z.number().int().nullable(), message: z.string() })),
      moves: z.array(moveView),
    }),
  },
})

// ---- reads --------------------------------------------------------------------------------------------------------------------

export const listReceiptsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    purchaseOrderId: id().optional(),
    supplierId: id().optional(),
    status: z.enum(GOODS_RECEIPT_STATUSES).optional(),
    /** A receipt number or a supplier DDT number (contains, any case). */
    q: z.string().trim().min(1).max(60).optional(),
    /** Posted at or after this instant (the start of the site's day for "Posted today"). */
    postedFrom: instant().optional(),
    /** Only posted receipts with a lot still in quarantine. */
    waiting: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      receipts: z.array(
        output({
          id: id(),
          number: z.string(),
          status: z.enum(GOODS_RECEIPT_STATUSES),
          companyId: id(),
          siteId: id(),
          supplier: output({ id: id(), name: z.string() }),
          purchaseOrder: output({ id: id(), number: z.string() }).nullable(),
          supplierDdtNumber: z.string().nullable(),
          supplierDdtDate: businessDate().nullable(),
          receivedAt: instant(),
          lines: z.number().int(),
          lots: z.number().int(),
          lotsReleased: z.number().int(),
          hides: z.number().int(),
          quantities: z.array(output({ uom, baseQuantity: decimal })),
          postedAt: instant().nullable(),
          postedById: id().nullable(),
          value,
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const countReceiptsContract = defineContract({
  querystring: input({ siteId: id().optional(), postedFrom: instant().optional() }),
  response: {
    200: output({
      /** The Receipts tiles: posted, reversed, posted with a lot still in quarantine, and posted since `postedFrom` (null without it). */
      counts: output({ posted: z.number().int(), reversed: z.number().int(), waiting: z.number().int(), postedSince: z.number().int().nullable() }),
    }),
  },
})

export const receiptParams = input({ receiptId: id() })

export const getReceiptContract = defineContract({ params: receiptParams, response: { 200: output({ receipt: receiptView }) } })

export const receiptLotsContract = defineContract({
  params: receiptParams,
  response: {
    200: output({
      receiptId: id(),
      number: z.string(),
      lots: z.array(
        lotView.extend({
          lineSeq: z.number().int(),
          itemId: id(),
          itemColourId: id().nullable(),
          /** Every hide one by one, with what lies of it now and where. */
          hides: z.array(hideView.extend({ onHand: decimal, locationId: id().nullable() })),
          /** On hand of the lot now (base unit). */
          onHand: decimal,
        }),
      ),
    }),
  },
})

export const expectedContract = defineContract({
  querystring: input({ siteId: id().optional(), purchaseOrderId: id().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
  response: {
    200: output({
      lines: z.array(
        output({
          purchaseOrderId: id(),
          number: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          version: z.number().int(),
          siteId: id(),
          supplier: output({ id: id(), name: z.string() }),
          purchaseOrderLineId: id(),
          seq: z.number().int(),
          item: output({ id: id(), code: z.string(), name: z.string(), tracking: z.enum(ITEM_TRACKINGS), baseUom: uom }),
          colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          quantity: decimal,
          uom,
          baseQuantity: decimal,
          expected: decimal,
          received: decimal,
          open: decimal,
          tolerancePct: z.string().nullable(),
          estimatedHides: z.number().int().nullable(),
          oneDyeBatch: z.boolean(),
          requiresCrViTest: z.boolean(),
          needDate: businessDate(),
        }),
      ),
    }),
  },
})

// ---- reverse -------------------------------------------------------------------------------------------------------------------

export const reverseReceiptContract = defineContract({
  params: receiptParams,
  body: input({ version, reason: z.string().trim().min(3).max(500) }),
  response: { 201: output({ receipt: receiptView, moves: z.array(moveView) }) },
})
