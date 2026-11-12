import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { SET_ASIDE_REASONS } from '@nexus/factory-domain/planning/decisions'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { MAX_CONVERT, REORDER_METHODS, REQUEST_HOLDS, REQUEST_KINDS, REQUEST_STATUSES, REQUEST_WARNINGS } from '@nexus/factory-domain/purchasing/requests/requests'
import { SOURCE_PREFERENCES } from '@nexus/factory-domain/purchasing/sources/sources'
import { PURCHASE_REQUEST_SOURCES, PURCHASE_REQUEST_STATUSES } from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'

/**
 * Requests to buy (B-W2a-10; SCM-034, SCM-036; design purchasing.requests "Requests to buy": tiles, the queue, the
 * Request detail, "Draft POs for n"). Purchase prices and values are costs: marked money.cost, so the API drops them for
 * a caller without the cost grain (a planner, the warehouse) and the screens do not draw the columns. A request names the
 * `version` it was read at (the plan line's, the reorder rule's).
 */

const version = z.number().int().min(1)
const step = output({ rule: z.string(), quantity: z.string() })

const requestView = output({
  /** `plan:<requirement id>`, `reorder:<item planning id>` or `asked:<purchase request id>` (B-W2b-332). */
  id: z.string(),
  kind: z.enum(REQUEST_KINDS),
  /** The row behind it: the plan line (MaterialRequirement), the site's reorder rule (ItemPlanning) or the request asked (PurchaseRequest). */
  refId: id(),
  version: z.number().int(),
  status: z.enum(REQUEST_STATUSES),
  companyId: id(),
  siteId: id(),
  site: output({ code: z.string(), name: z.string() }),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS), purchaseUom: z.enum(UOMS), requiresCrViTest: z.boolean() }),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  needDate: z.string(),
  /** The ISO week of the need date (`YYYY-Www`), for "group by need week". */
  needWeek: z.string(),
  /** The day to order by: need date − safety days − lead time, the supplier's closed days not counted (a reorder row: today). */
  orderBy: output({ date: z.string(), leadTimeDays: z.number().int().nullable(), passed: z.boolean(), closedDaysSkipped: z.number().int() }),
  /** What to buy, in `uom` (the supplier's unit when its source applies), and the same in the base unit. */
  quantity: z.string(),
  uom: z.enum(UOMS),
  baseQuantity: z.string(),
  baseUom: z.enum(UOMS),
  estimatedHides: z.number().int().nullable(),
  /** FIRM a firm planned order; SOURCE the source's unit, minimum and steps; PLAN the run's suggestion; ITEM the material's terms. */
  quantityFrom: z.enum(['FIRM', 'SOURCE', 'PLAN', 'ITEM']),
  rounding: z.array(step),
  supplier: output({ id: id(), code: z.string(), name: z.string(), status: z.string() }).nullable(),
  /** CHOSEN by the buyer, FIRM a firm planned order's, SITE the site's preferred supplier, SOURCE the best approved one, DEFAULT the material's. */
  supplierFrom: z.enum(['CHOSEN', 'FIRM', 'SITE', 'SOURCE', 'DEFAULT']).nullable(),
  /** The approved source it takes (null: none for this supplier). */
  sourceId: id().nullable(),
  /** How many suppliers are approved for it (0: the material has no source yet: any supplier). */
  approvedSuppliers: z.number().int(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  currency: z.string().nullable(),
  /** Per `uom`, in `currency`: the source's price, else the material's standard purchase price. */
  unitPrice: money.cost(z.string().nullable()),
  /** quantity × unit price, minor units. */
  expectedAmount: money.cost(z.number().int().nullable()),
  /** Why it cannot be drafted now; null: it can. */
  hold: output({ code: z.enum(REQUEST_HOLDS), message: z.string() }).nullable(),
  warnings: z.array(output({ code: z.enum(REQUEST_WARNINGS), message: z.string() })),
  plan: output({
    runId: id(),
    runStatus: z.string(),
    runStartedAt: instant(),
    trigger: z.string(),
    /** Planning's netting in one line: need − usable − on order = short. */
    why: z.string(),
    grossQuantity: z.string(),
    usableStock: z.string(),
    heldStock: z.string(),
    onOrder: z.string(),
    netQuantity: z.string(),
    suggestedQuantity: z.string(),
    suggestedUom: z.enum(UOMS),
    orders: z.array(output({ id: id(), number: z.string() })),
    workOrders: z.array(z.string()),
    firm: z.boolean(),
    decidedAt: instant().nullable(),
    setAside: output({ reason: z.enum(SET_ASIDE_REASONS), note: z.string().nullable() }).nullable(),
    purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
  }).nullable(),
  reorder: output({
    method: z.enum(REORDER_METHODS),
    /** usable + on order − reserved, base unit. */
    position: z.string(),
    usable: z.string(),
    onOrder: z.string(),
    reserved: z.string(),
    /** The reorder point (REORDER_POINT) or the minimum (MIN_MAX). */
    level: z.string(),
    triggered: z.boolean(),
    /** What the rule orders, base unit (before the supplier's own unit and steps). */
    quantity: z.string(),
    why: z.string(),
    note: z.string().nullable(),
  }).nullable(),
  /** B-W2b-332: a request asked in the office: who asked, when and why, what exactly, the work order, the shortage as seen. */
  asked: output({
    purchaseRequestId: id(),
    source: z.enum(PURCHASE_REQUEST_SOURCES),
    status: z.enum(PURCHASE_REQUEST_STATUSES),
    requestedBy: output({ id: id(), name: z.string() }),
    requestedAt: instant(),
    reason: z.string(),
    description: z.string().nullable(),
    /** What was asked, in the unit asked (the queue's quantity is what it buys). */
    quantity: z.string(),
    uom: z.enum(UOMS),
    workOrder: output({ id: id(), number: z.string() }).nullable(),
    shortage: output({ word: z.enum(['NOT_ENOUGH', 'DELAYED']), short: z.string(), uom: z.string(), needDate: z.string(), runId: z.string().nullable(), workOrderNumber: z.string() }).nullable(),
    approvalTaskId: id().nullable(),
    rejected: output({ at: instant(), reason: z.string() }).nullable(),
    convertedAt: instant().nullable(),
    purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
  }).nullable(),
})

const filters = {
  siteId: id().optional(),
  kind: z.enum(REQUEST_KINDS).optional(),
}

export const listRequestsContract = defineContract({
  querystring: input({
    ...filters,
    /** Default OPEN: what is still to buy. */
    status: z.enum([...REQUEST_STATUSES, 'ALL']).default('OPEN'),
    supplierId: id().optional(),
    itemId: id().optional(),
    /** Needed on or before this day (the "Need date within 14 days" tile: today + 14). */
    needBy: businessDate().optional(),
    /** Only requests that cannot be drafted now (true), or only those that can (false). */
    held: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    /** The material's code or name, the supplier's name, an order or work order number; case-insensitive. */
    q: z.string().trim().min(1).max(60).optional(),
    /** The last request id of the previous page. */
    cursor: z.string().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: { 200: output({ asOf: instant(), requests: z.array(requestView), matching: z.number().int(), nextCursor: z.string().nullable() }) },
})

export const requestCountsContract = defineContract({
  querystring: input(filters),
  response: {
    200: output({
      asOf: instant(),
      /** Open requests: what is still to buy. */
      open: z.number().int(),
      needWithin14Days: z.number().int(),
      /** Requests asked in the office that wait for a yes (B-W2b-332). */
      waitingApproval: z.number().int(),
      convertedToday: z.number().int(),
    }),
  },
})

export const getRequestContract = defineContract({
  params: input({ kind: z.enum(['plan', 'reorder', 'asked']), refId: id() }),
  response: {
    200: output({
      request: requestView,
      /** The approved sources that reach it, best first: the suppliers the buyer may pick. */
      sources: z.array(
        output({
          id: id(),
          partyId: id(),
          supplier: output({ code: z.string(), name: z.string(), status: z.string() }),
          preference: z.enum(SOURCE_PREFERENCES),
          purchaseUom: z.enum(UOMS),
          unitPrice: money.cost(z.string().nullable()),
          currency: z.string(),
          minOrderQty: z.string().nullable(),
          orderMultiple: z.string().nullable(),
          leadTimeDays: z.number().int().nullable(),
          supplierArticleCode: z.string().nullable(),
        }),
      ),
      /** REORDER: the open purchase order lines its position counts. */
      onOrder: z.array(output({ purchaseOrderId: id(), number: z.string(), status: z.string(), openQuantity: z.string() })),
    }),
  },
})

const requestsBody = {
  /** The requests to draft, each with the version read and, when the buyer picked one, its supplier. */
  requests: z.array(input({ kind: z.enum(REQUEST_KINDS), id: id(), version, supplierId: id().optional() })).min(1).max(MAX_CONVERT),
  /** Per supplier (and delivery site): the draft to add to, or null for a new one. Default: its open draft, else a new one. */
  into: z.array(input({ supplierId: id(), siteId: id().optional(), purchaseOrderId: id().nullable() })).max(MAX_CONVERT).optional(),
}

const cardLine = output({
  requestId: z.string(),
  item: output({ id: id(), code: z.string(), name: z.string() }),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  needDate: z.string(),
  unitPrice: money.cost(z.string().nullable()),
  expectedAmount: money.cost(z.number().int().nullable()),
  warnings: z.array(output({ code: z.enum(REQUEST_WARNINGS), message: z.string() })),
})

/** What "Draft POs for n" would make: one card per supplier and delivery site. Nothing is written. */
export const previewConversionContract = defineContract({
  body: input(requestsBody),
  response: {
    200: output({
      cards: z.array(
        output({
          companyId: id(),
          siteId: id(),
          site: output({ code: z.string(), name: z.string() }),
          supplier: output({ id: id(), code: z.string(), name: z.string(), status: z.string() }),
          currency: z.string(),
          /** EXISTING: the lines go into this open draft; NEW: a new draft is made. */
          into: z.enum(['EXISTING', 'NEW']),
          draft: output({ id: id(), number: z.string(), lineCount: z.number().int() }).nullable(),
          /** The supplier's open draft for the site, when the card makes a new one anyway (the RadioCard's other choice). */
          openDraft: output({ id: id(), number: z.string(), lineCount: z.number().int() }).nullable(),
          lines: z.array(cardLine),
          expectedAmount: money.cost(z.number().int().nullable()),
          /** false: the caller may not draft for this supplier and site (purchasing.manage). */
          mayDraft: z.boolean(),
        }),
      ),
      /** The requests that cannot be drafted now, and why. */
      held: z.array(output({ requestId: z.string(), code: z.enum(REQUEST_HOLDS), message: z.string() })),
    }),
  },
})

export const convertRequestsContract = defineContract({
  body: input(requestsBody),
  response: {
    200: output({
      orders: z.array(output({ id: id(), number: z.string(), created: z.boolean(), companyId: id(), siteId: id(), supplierId: id(), lineIds: z.array(id()), lineCount: z.number().int() })),
      lines: z.array(output({ requestId: z.string(), purchaseOrderId: id(), purchaseOrderLineId: id() })),
    }),
  },
})
