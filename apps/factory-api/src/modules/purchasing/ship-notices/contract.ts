import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { NOTICE_STATES, REASON_CODES, SHIP_NOTICE_LIMITS, SHIP_NOTICE_STATUSES, VERDICTS } from '@nexus/factory-domain/purchasing/ship-notices/rules'

/**
 * Ship notices (B-W2b-182; SCM-106, SCM-107, SCM-110; design portal.supplier.asn and warehouse.receipts sec:rc-inbound).
 * NOTHING here is money (Owner answer C2). Words come in both languages where a state, verdict or reason shows; quantities
 * are decimal strings in the order line's unit, dates calendar days, times UTC instants.
 */

const version = z.number().int().min(1)
const words = output({ it: z.string(), en: z.string() })
const uom = z.enum(UOMS)
const verdict = z.enum(VERDICTS)
const state = z.enum(NOTICE_STATES)
const reason = output({ code: z.enum(REASON_CODES), verdict, params: z.record(z.string(), z.union([z.string(), z.number()])), words })
const live = output({ events: z.array(z.string()) })
const params = input({ shipNoticeId: id() })
const short = (max: number) => z.string().max(2 * max)
const nullableText = (max: number) => short(max).nullable().optional()
const day = businessDate().nullable().optional()

const terms = {
  /** Your own reference for the delivery. */
  supplierRef: nullableText(SHIP_NOTICE_LIMITS.code),
  /** Your transport document (DDT) and its date: the goods travel with it. */
  ddtNumber: nullableText(SHIP_NOTICE_LIMITS.code),
  ddtDate: day,
  shipDate: day,
  expectedDate: day,
  carrier: nullableText(SHIP_NOTICE_LIMITS.text),
  trackingNumber: nullableText(SHIP_NOTICE_LIMITS.text),
  parcels: z.number().int().min(1).max(SHIP_NOTICE_LIMITS.parcels).nullable().optional(),
  /** A note for our dock. */
  note: nullableText(SHIP_NOTICE_LIMITS.note),
}

const lineInput = input({
  purchaseOrderLineId: id(),
  quantity: z.string().max(40),
  supplierLot: nullableText(SHIP_NOTICE_LIMITS.code),
  dyeBatch: nullableText(SHIP_NOTICE_LIMITS.code),
  note: nullableText(SHIP_NOTICE_LIMITS.note),
})

const lineChoice = output({
  purchaseOrderLineId: id(),
  seq: z.number().int(),
  item: output({ code: z.string(), name: z.string(), leather: z.boolean() }),
  supplierArticleCode: z.string().nullable(),
  colour: z.string().nullable(),
  uom,
  expected: z.string(),
  received: z.string(),
  inTransit: z.string(),
  open: z.string(),
  needDate: businessDate(),
  confirmedDate: businessDate().nullable(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  tolerancePct: z.string().nullable(),
  estimatedHides: z.number().int().nullable(),
  requiresCrViTest: z.boolean(),
})

const hideView = output({
  id: z.string(),
  seq: z.number().int(),
  hideNumber: z.string(),
  area: z.string(),
  areaUom: uom,
  grade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  note: z.string().nullable(),
  verdict,
  reasons: z.array(reason),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  purchaseOrderLineId: id(),
  orderSeq: z.number().int().nullable(),
  item: output({ code: z.string(), name: z.string(), leather: z.boolean() }).nullable(),
  supplierArticleCode: z.string().nullable(),
  colour: z.string().nullable(),
  quantity: z.string(),
  uom,
  supplierLot: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  note: z.string().nullable(),
  /** What our receipt took of it (null until received). */
  receivedQuantity: z.string().nullable(),
  verdict,
  reasons: z.array(reason),
  figures: output({ hides: z.number().int(), area: z.string().nullable(), expected: z.string(), before: z.string(), upTo: z.string(), openAfter: z.string() }).nullable(),
  hides: z.array(hideView),
})

export const noticeShape = {
  id: id(),
  number: z.string().nullable(),
  status: z.enum(SHIP_NOTICE_STATUSES),
  state,
  words,
  purchaseOrder: output({ id: id(), number: z.string() }),
  siteId: id(),
  supplierRef: z.string().nullable(),
  ddtNumber: z.string().nullable(),
  ddtDate: businessDate().nullable(),
  shipDate: businessDate().nullable(),
  expectedDate: businessDate().nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  parcels: z.number().int().nullable(),
  note: z.string().nullable(),
  sentAt: instant().nullable(),
  receivedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  verdict,
  verdictWords: words,
  counts: output({ ok: z.number().int(), check: z.number().int(), notAsOrdered: z.number().int() }),
  /** The lines whose received quantity differs from what was announced. */
  differing: z.array(id()),
  lines: z.array(lineView),
}
export const noticeView = output(noticeShape)

const page = {
  notice: noticeView,
  site: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  mayWrite: z.boolean(),
  canEdit: z.boolean(),
  canSend: z.boolean(),
  canCancel: z.boolean(),
  sendHeld: z.array(z.string()),
  warnings: z.array(z.string()),
  addable: z.array(lineChoice),
  live,
}
const pageOut = output(page)

// ---- the portal --------------------------------------------------------------------------------------------------------------

export const listNoticesContract = defineContract({
  querystring: input({
    state: z.enum(NOTICE_STATES).optional(),
    purchaseOrderId: id().optional(),
    /** The notice number, your reference or DDT, the tracking number or our PO number. */
    q: z.string().trim().max(100).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      mayWrite: z.boolean(),
      counts: z.record(z.string(), z.number().int()),
      items: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          status: z.enum(SHIP_NOTICE_STATUSES),
          state,
          words,
          purchaseOrder: output({ id: id(), number: z.string() }),
          shipDate: businessDate().nullable(),
          expectedDate: businessDate().nullable(),
          carrier: z.string().nullable(),
          trackingNumber: z.string().nullable(),
          ddtNumber: z.string().nullable(),
          supplierRef: z.string().nullable(),
          parcels: z.number().int().nullable(),
          sentAt: instant().nullable(),
          lines: z.number().int(),
          hides: z.number().int(),
          differing: z.number().int(),
          version: z.number().int(),
        }),
      ),
      more: z.boolean(),
      live,
    }),
  },
})

export const shippableContract = defineContract({
  querystring: input({ purchaseOrderId: id().optional() }),
  response: { 200: output({ mayWrite: z.boolean(), orders: z.array(output({ id: id(), number: z.string(), documentNumber: z.string(), status: z.string(), lines: z.array(lineChoice) })) }) },
})

export const noticeTemplateContract = defineContract({
  querystring: input({ format: z.enum(['csv', 'xlsx']).optional(), numberFormat: z.enum(NUMBER_FORMATS).optional() }),
  response: {},
})

export const portalNoticeContract = defineContract({ params, response: { 200: pageOut } })

export const createNoticeContract = defineContract({
  body: input({ purchaseOrderId: id(), lines: z.array(lineInput).max(SHIP_NOTICE_LIMITS.lines), ...terms }),
  response: { 201: pageOut },
})

export const updateNoticeContract = defineContract({
  params,
  body: input({ version, lines: z.array(lineInput).max(SHIP_NOTICE_LIMITS.lines).optional(), ...terms }),
  response: { 200: pageOut },
})

const hideInput = input({
  line: z.number().int().min(1).max(9999).nullable().optional(),
  hideNumber: z.string().max(2 * SHIP_NOTICE_LIMITS.code),
  area: z.string().max(40),
  unit: z.enum(['M2', 'DM2', 'FT2']).nullable().optional(),
  grade: nullableText(SHIP_NOTICE_LIMITS.code),
  thicknessMm: z.string().max(20).nullable().optional(),
  dyeBatch: nullableText(SHIP_NOTICE_LIMITS.code),
  note: nullableText(SHIP_NOTICE_LIMITS.reason),
})

export const packingListContract = defineContract({
  params,
  body: input({ version, rows: z.array(hideInput).max(SHIP_NOTICE_LIMITS.hides) }),
  response: { 200: pageOut },
})

const lineVerdict = output({ lineId: id(), seq: z.number().int(), verdict, reasons: z.array(reason), hides: z.number().int(), area: z.string().nullable(), expected: z.string(), before: z.string(), upTo: z.string(), openAfter: z.string() })

export const packingSheetContract = defineContract({
  params,
  body: input({
    version,
    fileName: z.string().min(1).max(200),
    /** The CSV or Excel file, base64 (never stored). */
    content: z.string().min(1).max(1_000_000),
    numberFormat: z.enum(NUMBER_FORMATS).optional(),
    sheetName: z.string().max(100).nullable().optional(),
    apply: z.boolean(),
  }),
  response: {
    200: output({
      fileName: z.string(),
      format: z.enum(['csv', 'xlsx']),
      sheet: z.string().nullable(),
      numberFormat: z.enum(NUMBER_FORMATS),
      columns: z.array(z.string()),
      ignored: z.array(z.string()),
      rows: z.array(
        output({
          rowNumber: z.number().int(),
          hideNumber: z.string().nullable(),
          line: z.number().int().nullable(),
          area: z.string().nullable(),
          unit: uom.nullable(),
          grade: z.string().nullable(),
          thicknessMm: z.string().nullable(),
          dyeBatch: z.string().nullable(),
          errors: z.array(output({ column: z.string().nullable(), message: z.string() })),
          verdict: verdict.nullable(),
          reasons: z.array(reason),
        }),
      ),
      unreadable: z.number().int(),
      verdict: verdict.nullable(),
      lines: z.array(lineVerdict),
      applied: z.boolean(),
      page: pageOut.nullable(),
    }),
  },
})

export const sendNoticeContract = defineContract({
  params,
  body: input({ version, note: nullableText(SHIP_NOTICE_LIMITS.note) }),
  response: { 200: output({ ...page, done: words }) },
})

export const cancelNoticeContract = defineContract({
  params,
  body: input({ version, reason: nullableText(SHIP_NOTICE_LIMITS.note) }),
  response: { 200: output({ removed: z.boolean(), page: pageOut.nullable() }) },
})

// ---- the office: the inbound board and the dock ------------------------------------------------------------------------------

const card = output({
  id: z.string(),
  kind: z.enum(['SHIP_NOTICE', 'ORDER']),
  day: businessDate(),
  /** Expected before the board's first day and not received yet. */
  late: z.boolean(),
  siteId: id(),
  supplier: output({ id: id(), name: z.string() }),
  purchaseOrder: output({ id: id(), number: z.string() }),
  shipNotice: output({
    id: id(),
    number: z.string(),
    state,
    words,
    shipDate: businessDate().nullable(),
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    parcels: z.number().int().nullable(),
    supplierRef: z.string().nullable(),
    ddtNumber: z.string().nullable(),
    hides: z.number().int(),
    verdict,
    supplierNote: z.string().nullable(),
    version: z.number().int(),
  }).nullable(),
  lines: z.number().int(),
  items: z.array(output({ code: z.string(), name: z.string(), quantity: z.string(), uom })),
  /** Our dock note (the office's own; a ship notice's). */
  dockNote: z.string().nullable(),
})

export const inboundContract = defineContract({
  querystring: input({
    /** The first day (default today). */
    from: businessDate().optional(),
    days: z.coerce.number().int().min(1).max(14).optional(),
    siteId: id().optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      from: businessDate(),
      days: z.array(businessDate()),
      sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      cards: z.array(card),
      complete: z.boolean(),
    }),
  },
})

const prefillHide = output({ supplierCode: z.string(), area: z.string(), areaUom: uom, grade: z.string().nullable(), thicknessMm: z.string().nullable() })
const prefillLot = output({ supplierLotRef: z.string().nullable(), dyeBatch: z.string().nullable(), quantity: z.string().nullable(), hides: z.array(prefillHide) })

export const officeNoticeContract = defineContract({
  params,
  response: {
    200: output({
      notice: output({ ...noticeShape, dockNote: z.string().nullable(), supplier: output({ id: id(), name: z.string() }) }),
      /** The goods receipt prefilled from the notice (POST /inventory/receipts with `shipNoticeId`): each hide with its declared area. */
      prefill: output({
        purchaseOrderId: id(),
        shipNoticeId: id(),
        supplierDdtNumber: z.string().nullable(),
        supplierDdtDate: businessDate().nullable(),
        lines: z.array(output({ purchaseOrderLineId: id(), quantity: z.string().nullable(), lots: z.array(prefillLot) })),
      }).nullable(),
      canReceive: z.boolean(),
      receiveHeld: z.string().nullable(),
    }),
  },
})

export const dockNoteContract = defineContract({
  params,
  body: input({ version, dockNote: nullableText(SHIP_NOTICE_LIMITS.note) }),
  response: { 200: output({ id: id(), dockNote: z.string().nullable(), version: z.number().int() }) },
})
