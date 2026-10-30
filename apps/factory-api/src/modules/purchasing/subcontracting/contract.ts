import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { KIT_LINE_STATUSES, KIT_STATES, MAX_KIT_LINES, MAX_LINES_PER_ACT, MAX_OPERATIONS, SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { fileView } from '../../../platform/files/contract'
import { sourceRequest } from '../../shipping/ddt/contract'

/**
 * The subcontract orders' contracts (B-W2a-25; SCM-138, SCM-140, SCM-141, SCM-142; design purchasing.subcontracting
 * SCR-128, SCR-129). Fees and amounts are costs: marked money.cost, so the API drops them for a caller without the cost
 * grain (a planner or the warehouse reads the order without its fees) and refuses a body that sends one. Pieces are
 * whole garments; quantities of material are decimal strings in their unit (four places).
 */

const version = () => z.number().int().min(1)
const status = z.enum(SUBCONTRACT_ORDER_STATUSES)
const pieces = () => z.number().int().min(0).max(1_000_000)
const note = () => z.string().trim().max(1000).nullish()
const orderParams = input({ subcontractOrderId: id() })
const operationParams = input({ subcontractOrderId: id(), operationId: id() })
const kitParams = input({ subcontractOrderId: id(), lineId: id() })
const versionQuery = input({ version: z.coerce.number().int().min(1) })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true').optional()

const ref = output({ id: id(), code: z.string(), name: z.string() })
const workOrderRef = output({ id: id(), number: z.string(), status: z.string(), style: ref })

const counts = output({
  ordered: z.number().int(),
  sent: z.number().int(),
  backGood: z.number().int(),
  backDefective: z.number().int(),
  scrapped: z.number().int(),
  /** Sent less back: at the workshop now. */
  atWorkshop: z.number().int(),
})

const sizeView = output({ workOrderSizeId: id(), colourway: z.string(), size: z.string(), pieces: z.number().int() })

const orderSummary = {
  id: id(),
  number: z.string(),
  status,
  companyId: id(),
  site: output({ id: id(), code: z.string() }),
  workshop: ref,
  location: ref,
  workOrder: workOrderRef,
  orderDate: businessDate(),
  expectedBackDate: businessDate().nullable(),
  /** It waits for goods and its return date is before today (Europe/Rome). */
  late: z.boolean(),
  /** What the workshop does: its operations in order. */
  services: z.array(output({ seq: z.number().int(), code: z.string(), name: z.string() })),
  pieces: counts,
  kit: output({ state: z.enum(KIT_STATES), planned: z.number().int(), sent: z.number().int(), cancelled: z.number().int() }),
  currency: z.string(),
  netAmount: money.cost(z.number().int()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
}
export const orderRow = output(orderSummary)

const operationView = output({
  id: id(),
  seq: z.number().int(),
  workOrderOperation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
  pieces: z.number().int(),
  /** Per cell of the work order; empty: not split by size. */
  sizes: z.array(sizeView),
  pricePerPiece: money.cost(z.string()),
  netAmount: money.cost(z.number().int()),
  expectedBackDate: businessDate().nullable(),
  piecesSent: z.number().int(),
  piecesBackGood: z.number().int(),
  piecesBackDefective: z.number().int(),
  piecesScrapped: z.number().int(),
  atWorkshop: z.number().int(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const kitLineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) }),
  colour: ref.nullable(),
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  baseQuantity: z.string(),
  status: z.enum(KIT_LINE_STATUSES),
  sentAt: instant().nullable(),
  moveId: id().nullable(),
  /** The DDT it travelled with (purpose: work on our behalf, conto lavorazione). */
  ddt: output({ id: id(), number: z.string(), cancelled: z.boolean() }).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

export const receiptView = output({
  id: id(),
  receivedAt: instant(),
  recordedAt: instant(),
  byId: id().nullable(),
  /** Per operation, and per bundle when the bundle was named: back good, defective, scrapped at the workshop. */
  lines: z.array(
    output({
      operationId: id(),
      seq: z.number().int(),
      code: z.string(),
      bundle: output({ id: id(), code: z.string(), workOrderSizeId: id(), colourway: z.string(), size: z.string() }).nullable(),
      good: z.number().int(),
      defective: z.number().int(),
      scrapped: z.number().int(),
      reason: z.string().nullable(),
    }),
  ),
  /** Unused material and offcuts the workshop returned: moved out of its location into ours. */
  returns: z.array(output({ moveId: id(), item: ref, colour: ref.nullable(), lot: ref.nullable(), hide: ref.nullable(), quantity: z.string(), uom: z.enum(UOMS), toLocation: ref })),
  /** The workshop's own DDT for the goods back, as typed. */
  supplierDdt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
  note: z.string().nullable(),
})

/** Why an act is held now, in words; null: it may be done (the caller's permission aside). */
const held = () => z.string().nullable()

export const orderDetail = output({
  ...orderSummary,
  note: z.string().nullable(),
  internalNote: z.string().nullable(),
  issuedAt: instant().nullable(),
  issuedById: id().nullable(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  operations: z.array(operationView),
  kitLines: z.array(kitLineView),
  receipts: z.array(receiptView),
  /** Its kit DDTs (live and cancelled), newest first: the record's "Kit DDT (PDF)". */
  ddts: z.array(output({ id: id(), number: z.string(), documentDate: businessDate(), cancelled: z.boolean(), kitLineIds: z.array(id()) })),
  actions: output({ issue: held(), reopen: held(), cancel: held(), close: held(), send: held(), receive: held() }),
})
const one = output({ order: orderDetail })

// ---- reads ------------------------------------------------------------------------------------------------------------

export const listOrdersContract = defineContract({
  querystring: input({
    /** One status; `open` = every status but CLOSED and CANCELLED (the default when neither is given). */
    status: status.optional(),
    open: flag(),
    partyId: id().optional(),
    workOrderId: id().optional(),
    siteId: id().optional(),
    /** Only the late ones. */
    late: flag(),
    /** The tiles as filters (B-W2a-56; the same rules as `/counts`): issued with kit lines still to send. */
    kitToSend: flag(),
    /** Something of it is at the workshop (AT_WORKSHOP, PARTLY_RECEIVED). */
    atWorkshop: flag(),
    /** Waiting for goods, due back from today to the end of the week (Sunday, Europe/Rome). */
    dueThisWeek: flag(),
    /** Number, workshop code or name, work order number. */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ items: z.array(orderRow), nextCursor: id().nullable() }) },
})

export const orderCountsContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional() }),
  response: {
    200: output({
      /** Issued, with kit lines still to send. */
      kitToSend: z.number().int(),
      /** Something of it is at the workshop. */
      atWorkshops: z.number().int(),
      /** Waiting for goods, due back from today to the end of the week (Sunday, Europe/Rome). */
      dueBackThisWeek: z.number().int(),
      late: z.number().int(),
    }),
  },
})

export const getOrderContract = defineContract({ params: orderParams, response: { 200: one } })

export const outsideOperationsContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      workOrder: workOrderRef.extend({ companyId: id(), siteId: id() }),
      cells: z.array(output({ workOrderSizeId: id(), colourway: z.string(), size: z.string(), quantity: z.number().int() })),
      operations: z.array(
        output({
          id: id(),
          seq: z.number().int(),
          code: z.string(),
          name: z.string(),
          /** The routing step's outside work (its default workshop, fee per piece and transit days); null: done in house. */
          outside: output({ workshop: ref.nullable(), pricePerPiece: money.cost(z.string().nullable()), transitDays: z.number().int().nullable() }).nullable(),
          /** Pieces already on live subcontract orders for it. */
          ordered: z.number().int(),
        }),
      ),
      /** The workshops these steps name, with their stock locations on the work order's site (none yet: create one). */
      workshops: z.array(ref.extend({ locations: z.array(ref) })),
      /** Live subcontract orders of the work order. */
      orders: z.array(output({ id: id(), number: z.string(), status })),
    }),
  },
})

/**
 * B-W2a-56, the "New subcontract order" dialog's work order picker: the released or running work orders the caller
 * reaches with purchasing.view (a buyer holds no workorders.view), by number or style, with how many of their operations
 * the routing sends out and how many live subcontract orders they have.
 */
export const workOrderChoicesContract = defineContract({
  querystring: input({ q: z.string().trim().min(1).max(80).optional(), siteId: id().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  response: {
    200: output({
      items: z.array(
        workOrderRef.extend({
          companyId: id(),
          site: output({ id: id(), code: z.string() }),
          garments: z.number().int(),
          /** Operations whose routing step is done outside (it names a workshop). */
          outsideSteps: z.number().int(),
          /** Live (not cancelled, not closed) subcontract orders of the work order. */
          liveOrders: z.number().int(),
        }),
      ),
    }),
  },
})

export const stockContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional(), locationId: id().optional(), itemId: id().optional() }),
  response: {
    200: output({
      rows: z.array(
        output({
          site: output({ id: id(), code: z.string() }),
          workshop: ref,
          location: ref,
          item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
          colour: ref.nullable(),
          lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
          hide: ref.nullable(),
          /** In the item's base unit. */
          onHand: z.string(),
          /** The last move into the workshop's location of this stock (days out are W2b's ageing). */
          lastSentAt: instant().nullable(),
          unitCost: money.cost(z.string().nullable()),
          value: money.cost(z.number().int().nullable()),
          currency: z.string(),
        }),
      ),
      /** Per workshop location: how many stock rows it holds and their value (our stock, still in our books). */
      workshops: z.array(output({ workshop: ref, location: ref, site: output({ id: id(), code: z.string() }), lines: z.number().int(), value: money.cost(z.number().int().nullable()) })),
      truncated: z.boolean(),
    }),
  },
})

// ---- the order ----------------------------------------------------------------------------------------------------------

const sizeInput = input({ workOrderSizeId: id(), pieces: z.number().int().min(1).max(1_000_000) })
const operationFields = {
  pieces: z.number().int().min(1).max(1_000_000).optional(),
  /** Per cell of the work order, adding up to the pieces; [] = not split. Default: every cell with all its garments. */
  sizes: z.array(sizeInput).max(500).optional(),
  /** Default the routing step's fee (a cost). */
  pricePerPiece: money.cost(unitPrice()),
  expectedBackDate: businessDate().nullish(),
  note: note(),
}
const operationInput = input({ workOrderOperationId: id(), ...operationFields })

export const createOrderContract = defineContract({
  body: input({
    workOrderId: id(),
    /** The workshop; default the first operation's routing step's. */
    partyId: id().optional(),
    /** The workshop's stock location on the work order's site; default its only active one. */
    locationId: id().optional(),
    orderDate: businessDate().optional(),
    /** Default the latest of the operations' (their routing step's transit days from the order date, the workshop's closed days skipped). */
    expectedBackDate: businessDate().nullish(),
    currency: z.string().trim().length(3).optional(),
    note: note(),
    internalNote: note(),
    operations: z.array(operationInput).min(1).max(MAX_OPERATIONS),
    /** Plan the kit from the work order's planned materials of the cells sent (default false: add lines later). */
    planKit: z.boolean().optional(),
  }),
  response: { 201: one },
})

export const updateOrderContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    partyId: id().optional(),
    locationId: id().optional(),
    orderDate: businessDate().optional(),
    expectedBackDate: businessDate().nullish(),
    currency: z.string().trim().length(3).optional(),
    note: note(),
    internalNote: note(),
  }),
  response: { 200: one },
})

export const addOperationContract = defineContract({ params: orderParams, body: input({ version: version(), workOrderOperationId: id(), ...operationFields }), response: { 201: one } })
export const editOperationContract = defineContract({ params: operationParams, body: input({ version: version(), ...operationFields }), response: { 200: one } })
export const removeOperationContract = defineContract({ params: operationParams, querystring: versionQuery, response: { 200: one } })

const kitLineInput = input({
  itemId: id(),
  itemColourId: id().nullish(),
  lotId: id().nullish(),
  hideId: id().nullish(),
  quantity: quantity(),
  /** Default the item's base unit. */
  uom: z.enum(UOMS).optional(),
  note: note(),
})
export const addKitLinesContract = defineContract({ params: orderParams, body: input({ version: version(), lines: z.array(kitLineInput).min(1).max(MAX_KIT_LINES) }), response: { 201: one } })
export const planKitContract = defineContract({ params: orderParams, body: input({ version: version() }), response: { 200: one } })
export const editKitLineContract = defineContract({
  params: kitParams,
  body: input({ version: version(), quantity: quantity().optional(), uom: z.enum(UOMS).optional(), lotId: id().nullish(), hideId: id().nullish(), note: note() }),
  response: { 200: one },
})
export const removeKitLineContract = defineContract({ params: kitParams, querystring: versionQuery, response: { 200: one } })

export const issueOrderContract = defineContract({ params: orderParams, body: input({ version: version() }), response: { 200: one } })
export const reopenOrderContract = defineContract({ params: orderParams, body: input({ version: version() }), response: { 200: one } })
export const cancelOrderContract = defineContract({ params: orderParams, body: input({ version: version(), reason: z.string().trim().min(1).max(500) }), response: { 200: one } })
export const closeOrderContract = defineContract({ params: orderParams, body: input({ version: version(), note: note() }), response: { 200: one } })

// ---- kit out and goods back ---------------------------------------------------------------------------------------------

export const sendKitContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    /** PLANNED kit lines that go now, each from a location of the site (its lot and hide picked now when not planned). */
    lines: z
      .array(input({ lineId: id(), fromLocationId: id(), lotId: id().nullish(), hideId: id().nullish(), quantity: quantity().optional(), uom: z.enum(UOMS).optional() }))
      .max(MAX_LINES_PER_ACT)
      .default([]),
    /** Pieces that go now, per operation (default from the bundles named). */
    pieces: z.array(input({ operationId: id(), pieces: z.number().int().min(1).max(1_000_000) })).max(MAX_OPERATIONS).default([]),
    /** Cut bundles that travel (each is named on the DDT; their garments count as the pieces sent when `pieces` is empty). */
    bundles: z.array(input({ bundleId: id() })).max(MAX_LINES_PER_ACT).default([]),
    /** The DDT for work on our behalf (conto lavorazione) the goods travel with; null: none issued now (issue it later). */
    ddt: sourceRequest.omit({ version: true }).nullable(),
  }),
  response: {
    201: output({
      order: orderDetail,
      moveIds: z.array(id()),
      ddt: output({ id: id(), number: z.string(), file: fileView.nullable(), pdfProblem: z.string().nullable() }).nullable(),
    }),
  },
})

export const returnKitLineContract = defineContract({ params: kitParams, body: input({ version: version(), reason: z.string().trim().min(1).max(500) }), response: { 200: one } })

export const receiveContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    /** When the goods came back; default now. */
    receivedAt: instant().optional(),
    /** Pieces back per operation, and per bundle when the bundle is named. */
    lines: z
      .array(input({ operationId: id(), bundleId: id().optional(), good: pieces(), defective: pieces(), scrapped: pieces(), reason: z.string().trim().max(300).nullish() }))
      .max(MAX_LINES_PER_ACT)
      .default([]),
    /** Unused material and offcuts returned: out of the workshop's location into a location of the site. */
    returns: z
      .array(input({ itemId: id(), itemColourId: id().nullish(), lotId: id().nullish(), hideId: id().nullish(), quantity: quantity(), uom: z.enum(UOMS).optional(), toLocationId: id() }))
      .max(MAX_LINES_PER_ACT)
      .default([]),
    /** The workshop's DDT the goods came back with. */
    supplierDdt: input({ number: z.string().trim().min(1).max(40), date: businessDate().nullish() }).nullish(),
    note: note(),
  }),
  response: {
    201: output({
      order: orderDetail,
      receipt: receiptView,
      /** The workshop's fee for the pieces back good on the work order's cost ledger: entries posted now, or why it waits. */
      ledger: output({ posted: z.number().int(), waiting: z.array(z.string()) }),
    }),
  },
})
