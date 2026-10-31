import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { DIFFERENCES, GOODS_RECEIPT_STATUSES, HOLD_REASONS, RECEIPT_LIMITS, RECEIPT_NOTE_CODES, REVERSAL_BLOCKERS } from '@nexus/factory-domain/inventory/receipts/rules'
import { money } from '@nexus/factory-domain/money/marked'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { DISCREPANCY_KINDS, DISCREPANCY_LIMITS, DISCREPANCY_STATUSES, SETTLE_STATUSES } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { IMPORT_STATUSES } from '@nexus/factory-domain/imports/job'
import { DOCUMENT_ASKS, DOCUMENT_REQUEST_LIMITS } from '@nexus/factory-domain/inventory/receipts/document-request'
import { DDT_CORRECTION_LIMITS } from '@nexus/factory-domain/inventory/receipts/ddt-correction'
import { fileView, presignedView } from '../../../platform/files/contract'
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

export const hideInput = input({
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

export const lotInput = input({
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

export const lineInput = input({
  purchaseOrderLineId: id(),
  /** An untracked material: how much came, in `uom`. */
  quantity: quantity().optional(),
  /** Default the order line's unit. Not for leather (its hides' unit). */
  uom: uom.optional(),
  baseQuantity: quantity().optional(),
  /**
   * B-W2a-31 (SCM-123): received in the supplier's unit. An untracked line: how many came in `receivedUom` (instead of
   * quantity); a lot-tracked line: its lots' quantities are in `receivedUom`. Not for leather. The base quantity is
   * round(quantity × factor, 4).
   */
  receivedQuantity: quantity().optional(),
  /** The supplier's unit. The office may leave it out: the approved source's purchase unit. */
  receivedUom: uom.optional(),
  /** Base units in one received unit (a roll that measures 48.5 m); default the material's own factor for that unit. */
  receivedFactor: z.string().trim().min(1).max(24).optional(),
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
  /** B-W2a-31: what came in the supplier's unit and its factor (base units per unit), or null. */
  received: output({ quantity: decimal, uom, factor: z.string() }).nullable(),
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
  /** B-W2b-14: the latest correction of the supplier DDT number or date on the posted receipt (when, who, why). */
  supplierDdtCorrection: output({ at: instant(), byId: id().nullable(), reason: z.string() }).nullable(),
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
  /** B-W2a-31 (SCM-115): the photos of the supplier's delivery note. */
  ddtPhotos: z.array(output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), createdAt: instant() })),
  /** B-W2a-31 (SCM-118): its discrepancies — every one, not closed yet, not reported yet. */
  discrepancies: output({ count: z.number().int(), open: z.number().int(), unsent: z.number().int() }),
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
    periodLockOverride: periodLockOverride.optional(),
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
    /** B-W2a-31: `open` — only receipts with a discrepancy not closed yet. */
    discrepancies: z.enum(['open']).optional(),
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
          /** B-W2a-31: its discrepancies — every one, not closed yet, not reported yet. */
          discrepancies: output({ count: z.number().int(), open: z.number().int(), unsent: z.number().int() }),
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
      counts: output({
        posted: z.number().int(),
        reversed: z.number().int(),
        waiting: z.number().int(),
        postedSince: z.number().int().nullable(),
        /** B-W2a-31: discrepancies not closed yet on these receipts (the "Discrepancies open" tile). */
        discrepanciesOpen: z.number().int(),
      }),
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
  body: input({
    version,
    reason: z.string().trim().min(3).max(500),
    /** B-W2b-22: why the mirror moves go into a soft-locked month (they are dated now). */
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: output({ receipt: receiptView, moves: z.array(moveView) }) },
})

// ---- B-W2a-31: receiving every day -----------------------------------------------------------------------------------------------

const photoBody = input({
  originalName: z.string().min(1).max(500),
  /** A picture: the PHOTO kind's types (JPEG, PNG, WebP, HEIC). */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})
const uploadAnswer = { 201: output({ file: fileView, upload: presignedView }) }

/** The supplier's delivery note photo (SCM-115): office and floor. */
export const announceDdtPhotoContract = defineContract({ params: receiptParams, body: photoBody, response: uploadAnswer })
export const completeDdtPhotoContract = defineContract({ params: input({ receiptId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

const discrepancyView = output({
  id: id(),
  receiptId: id(),
  seq: z.number().int(),
  status: z.enum(DISCREPANCY_STATUSES),
  kind: z.enum(DISCREPANCY_KINDS),
  /** A code of the DISCREPANCY reason list, with its words. */
  reasonCode: z.string().nullable(),
  reason: output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }).nullable(),
  /** The receipt line it is about (null: the delivery as a whole). */
  receiptLine: output({
    id: id(),
    seq: z.number().int(),
    purchaseOrderLineId: id().nullable(),
    item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom }),
    colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  }).nullable(),
  quantity: decimal.nullable(),
  uom: uom.nullable(),
  note: z.string().nullable(),
  sentAt: instant().nullable(),
  sentById: id().nullable(),
  closedAt: instant().nullable(),
  resolutionNote: z.string().nullable(),
  photos: z.array(output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), createdAt: instant() })),
  /** The supplier claims (B-W2a-44) that pursue it. */
  claims: z.array(output({ id: id(), number: z.string(), status: z.string() })),
  version: z.number().int(),
  createdAt: instant(),
  createdById: id().nullable(),
})

const discrepancyParams = input({ receiptId: id(), discrepancyId: id() })
const discrepancyFields = {
  /** What was wrong. May be left out when the reason code is itself a kind (SHORT, OVER, WRONG_ITEM, DAMAGED). */
  kind: z.enum(DISCREPANCY_KINDS).optional(),
  /** A code of the DISCREPANCY reason list (GET /reasons?list=DISCREPANCY); default the kind's own code. */
  reasonCode: z.string().trim().max(40).nullish(),
  /** The receipt line it is about; null: the delivery as a whole. */
  receiptLineId: id().nullish(),
  /** How much, above 0, with its unit (both or neither). */
  quantity: z.string().trim().max(24).nullish(),
  uom: uom.nullish(),
  note: z.string().trim().max(DISCREPANCY_LIMITS.note).nullish(),
}

export const listDiscrepanciesContract = defineContract({
  params: receiptParams,
  response: { 200: output({ receiptId: id(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES), open: z.boolean(), discrepancies: z.array(discrepancyView) }) },
})
export const recordDiscrepancyContract = defineContract({ params: receiptParams, body: input(discrepancyFields), response: { 201: output({ discrepancy: discrepancyView }) } })
export const changeDiscrepancyContract = defineContract({ params: discrepancyParams, body: input({ version, ...discrepancyFields }), response: { 200: output({ discrepancy: discrepancyView }) } })
export const removeDiscrepancyContract = defineContract({
  params: discrepancyParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ removed: output({ id: id(), seq: z.number().int() }) }) },
})
export const settleDiscrepancyContract = defineContract({
  params: discrepancyParams,
  body: input({ version, to: z.enum(SETTLE_STATUSES), note: z.string().trim().max(DISCREPANCY_LIMITS.resolution).nullish() }),
  response: { 200: output({ discrepancy: discrepancyView }) },
})
export const announceDiscrepancyPhotoContract = defineContract({ params: discrepancyParams, body: photoBody, response: uploadAnswer })
export const completeDiscrepancyPhotoContract = defineContract({ params: input({ receiptId: id(), discrepancyId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

const reportIds = z
  .string()
  .trim()
  .max(4000)
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
  .pipe(z.array(id()).max(DISCREPANCY_LIMITS.perReceipt))

/** The PDF (application/pdf, inline): the response is not a JSON body. */
export const previewReportContract = defineContract({
  params: receiptParams,
  querystring: input({ ids: reportIds.optional(), language: z.enum(['it', 'en']).optional() }),
  response: {},
})
export const reportCheckContract = defineContract({
  params: receiptParams,
  querystring: input({ ids: reportIds.optional() }),
  response: {
    200: output({
      ready: z.boolean(),
      problems: z.array(output({ path: z.string(), message: z.string() })),
      discrepancyIds: z.array(id()),
      sendsIds: z.array(id()),
      recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string(), roles: z.array(z.string()), language: z.string().nullable(), suggested: z.boolean() })),
      language: z.enum(['it', 'en']),
      subject: z.string(),
      message: z.string(),
    }),
  },
})
export const sendReportContract = defineContract({
  params: receiptParams,
  body: input({
    /** The discrepancies to report (OPEN ones become SENT; SENT ones go again as a reminder); default every OPEN one. */
    discrepancyIds: z.array(id()).min(1).max(DISCREPANCY_LIMITS.perReceipt).optional(),
    /** The supplier's contacts that get it (active, with an e-mail). */
    contactIds: z.array(id()).min(1).max(DISCREPANCY_LIMITS.reportRecipients),
    cc: z.array(z.string().trim().email().max(254)).max(DISCREPANCY_LIMITS.reportRecipients).optional(),
    subject: z.string().trim().max(200).nullish(),
    /** Your own words in place of the standard text. */
    message: z.string().trim().max(DISCREPANCY_LIMITS.message).nullish(),
    language: z.enum(['it', 'en']).optional(),
  }),
  response: {
    201: output({
      report: output({
        documentFileId: id(),
        fileName: z.string(),
        emailId: id(),
        threadId: id(),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        language: z.enum(['it', 'en']),
        sentAt: instant(),
        discrepancyIds: z.array(id()),
        sentIds: z.array(id()),
      }),
      discrepancies: z.array(discrepancyView),
    }),
  },
})

/** A tannery hide list's totals against its order (SCM-248). */
export const hideListSummaryContract = defineContract({
  params: input({ importId: id() }),
  response: {
    200: output({
      importId: id(),
      status: z.enum(IMPORT_STATUSES),
      counts: output({ rows: z.number().int(), toReceive: z.number().int(), receivedBefore: z.number().int(), errors: z.number().int() }),
      order: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES), siteId: id() }).nullable(),
      lines: z.array(
        output({
          purchaseOrderLineId: id(),
          seq: z.number().int(),
          itemCode: z.string(),
          baseUom: uom,
          hides: z.number().int(),
          lots: z.number().int(),
          /** What the list brings, in the base unit. */
          baseArea: decimal,
          expected: decimal,
          receivedBefore: decimal,
          after: decimal,
          difference: decimal,
          tolerancePct: z.string(),
          upTo: decimal,
          kind: z.enum(DIFFERENCES),
          /** Beyond the tolerance over: the rows must give the reason. */
          needsReason: z.boolean(),
        }),
      ),
      /** The receipt the apply made. */
      receipt: output({ id: id(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES) }).nullable(),
    }),
  },
})

// ---- B-W2a-F4: "Request from supplier", the receipt's missing documents ------------------------------------------------------

const wantedDocumentView = output({
  /** `<lotId>:<ask>` or `receipt:DELIVERY_NOTE`: what the request's `documents` name. */
  key: z.string(),
  ask: z.enum(DOCUMENT_ASKS),
  lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable(), dyeBatch: z.string().nullable() }).nullable(),
})

export const documentRequestCheckContract = defineContract({
  params: receiptParams,
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {
    200: output({
      ready: z.boolean(),
      problems: z.array(output({ path: z.string(), message: z.string() })),
      receipt: output({ id: id(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES), supplierDdtNumber: z.string().nullable(), supplierDdtDate: businessDate().nullable() }),
      /** What the delivery still waits for (the Documents check's list). */
      wanted: z.array(wantedDocumentView),
      /** The supplier's active contacts with an e-mail: the only recipients the request takes. */
      recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string(), roles: z.array(z.string()), language: z.string().nullable(), suggested: z.boolean() })),
      language: z.enum(['it', 'en']),
      /** The standard subject and text for every wanted document, in `language` (no note). */
      subject: z.string(),
      body: z.string(),
    }),
  },
})

export const requestDocumentsContract = defineContract({
  params: receiptParams,
  body: input({
    contactIds: z.array(id()).min(1).max(DOCUMENT_REQUEST_LIMITS.recipients),
    /** Keys of `wanted` (default every one). */
    documents: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
    language: z.enum(['it', 'en']).optional(),
    note: z.string().trim().max(DOCUMENT_REQUEST_LIMITS.note).nullish(),
  }),
  response: {
    201: output({
      request: output({
        emailId: id(),
        threadId: id(),
        messageId: id(),
        to: z.array(z.string()),
        language: z.enum(['it', 'en']),
        subject: z.string(),
        documents: z.array(z.string()),
        status: z.string(),
        sentAt: instant(),
      }),
    }),
  },
})

// ---- B-W2b-14: the supplier's DDT number and date corrected on a posted receipt ------------------------------------------------

export const correctSupplierDdtContract = defineContract({
  params: receiptParams,
  body: input({
    version,
    /** The DDT's number as the supplier printed it; null: the delivery came without one. */
    supplierDdtNumber: code().nullable(),
    supplierDdtDate: businessDate().nullable(),
    /** Why it is corrected (kept on the receipt and in its audit row). */
    reason: z.string().trim().min(3).max(DDT_CORRECTION_LIMITS.reason),
  }),
  response: { 200: output({ receipt: receiptView }) },
})
