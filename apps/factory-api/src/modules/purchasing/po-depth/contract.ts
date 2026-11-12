import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { DATE_SOURCES, MAX_CONTACT_NAME, MAX_DATE_REASON } from '@nexus/factory-domain/purchasing/po-depth/dates'
import { MAX_DELIVERIES, MAX_DELIVERY_NOTE } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { MAX_TOLERANCE_NOTE, TOLERANCE_ACTIONS, TOLERANCE_STATUSES } from '@nexus/factory-domain/purchasing/po-depth/tolerances'

/**
 * The contracts of purchase orders in depth (B-W2b-296; SCM-052, SCM-061, SCM-065, SCM-066, SCM-088, SCM-147). The order's
 * value in the company's currency is a cost (money.cost: dropped for a caller without the cost grain); the rate itself is
 * no money. Every write names the order's (or the tolerance's) version: the edit-conflict guard.
 */

const version = z.number().int().min(1)
const orderParams = input({ purchaseOrderId: id() })
const lineParams = input({ purchaseOrderId: id(), lineId: id() })
const percent = z.string().trim().min(1).max(12)

const toleranceOfLine = output({
  overPct: z.string(),
  underPct: z.string(),
  /** REASON: more than ordered only with the receiver's reason (W1); BLOCK: refused; APPROVAL: needs a yes (refused while no yes exists for a receipt). */
  whenBeyond: z.enum(['REASON', ...TOLERANCE_ACTIONS]),
  /** LINE: the line's own (a leather line's area tolerance); RULE: a delivery tolerance; NONE: exactly as ordered. */
  source: z.enum(['LINE', 'RULE', 'NONE']),
  toleranceId: id().nullable(),
})

const deliveryView = output({
  id: id(),
  seq: z.number().int(),
  quantity: z.string(),
  baseQuantity: z.string(),
  /** The day asked: never overwritten by the supplier's answer. */
  needDate: z.string(),
  /** The supplier's day (null until it gives one). */
  confirmedDate: z.string().nullable(),
  /** Confirmed later than needed by so many days (0 when not later). */
  confirmedLaterBy: z.number().int(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const dateChangeView = output({
  id: id(),
  lineId: id(),
  lineSeq: z.number().int(),
  deliveryId: id().nullable(),
  deliverySeq: z.number().int().nullable(),
  seq: z.number().int(),
  fromDate: z.string(),
  toDate: z.string(),
  source: z.enum(DATE_SOURCES),
  changedAt: instant(),
  supplierContactName: z.string().nullable(),
  reason: z.string(),
  words: z.string(),
  createdById: id().nullable(),
  createdAt: instant(),
})

const addressView = output({ id: id(), name: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string(), contactName: z.string().nullable(), phone: z.string().nullable(), deliveryNotes: z.string().nullable(), usable: z.boolean() })

export const depthView = output({
  orderId: id(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  /** The order's version now (the next write names it). */
  version: z.number().int(),
  currency: output({
    order: z.string(),
    company: z.string(),
    /** The order is in another currency than its company's: it takes a rate at order before it is sent. */
    takesRate: z.boolean(),
    rateAtOrder: z.string().nullable(),
    /** "1 EUR = 1.085 USD". */
    rateWords: z.string().nullable(),
    /** The order's net in the company's currency at the rate at order (minor units): frozen with the send. */
    companyNetAmount: money.cost(z.number().int().nullable()),
  }),
  shipTo: output({
    partyId: id(),
    party: output({ code: z.string(), name: z.string(), roles: z.array(z.string()) }),
    addressId: id().nullable(),
    address: addressView.nullable(),
    locationId: id().nullable(),
    location: output({ code: z.string(), name: z.string() }).nullable(),
    /** WORKSHOP: the receipt lands on the workshop's place (its stock of ours); OFFICE_PICKS: the office says where. */
    receiptLandsAt: z.enum(['WORKSHOP', 'OFFICE_PICKS']),
  }).nullable(),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      itemId: id(),
      itemCode: z.string(),
      quantity: z.string(),
      uom: z.enum(UOMS),
      baseQuantity: z.string(),
      needDate: z.string(),
      confirmedDate: z.string().nullable(),
      confirmedLaterBy: z.number().int(),
      /** Cancelled or closed short: its deliveries and dates change no more. */
      ended: z.boolean(),
      deliveries: z.array(deliveryView),
      tolerance: toleranceOfLine,
    }),
  ),
  /** Every move of a confirmed day, oldest first. */
  dateChanges: z.array(dateChangeView),
})

const depthAnswer = output({ depth: depthView })

export const getDepthContract = defineContract({ params: orderParams, response: { 200: depthAnswer } })

export const putScheduleContract = defineContract({
  params: lineParams,
  body: input({
    version,
    deliveries: z.array(input({ quantity: quantity(), needDate: businessDate(), note: z.string().max(MAX_DELIVERY_NOTE).nullable().optional() })).min(1).max(MAX_DELIVERIES),
  }),
  response: { 200: depthAnswer },
})

export const clearScheduleContract = defineContract({
  params: lineParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: depthAnswer },
})

export const supplierDateContract = defineContract({
  params: lineParams,
  body: input({
    version,
    /** One of the line's deliveries; none: the line's own confirmed day (a line without a schedule). */
    deliveryId: id().nullable().optional(),
    /** The supplier's day: the first one of a delivery, or the day a confirmed one moves to. */
    date: businessDate(),
    /** Who moved it (a move only): the supplier said so, or the buyer agreed it with the supplier. */
    source: z.enum(DATE_SOURCES),
    reason: z.string().max(MAX_DATE_REASON).nullable().optional(),
    supplierContactName: z.string().max(MAX_CONTACT_NAME).nullable().optional(),
    /** When it was said or agreed (default now). */
    changedAt: instant().nullable().optional(),
  }),
  response: { 200: depthAnswer.extend({ recorded: z.enum(['FIRST', 'MOVED']), dateChangeIds: z.array(id()) }) },
})

export const putRateContract = defineContract({
  params: orderParams,
  body: input({ version, rateAtOrder: z.string().trim().max(30).nullable() }),
  response: { 200: depthAnswer },
})

export const putShipToContract = defineContract({
  params: orderParams,
  body: input({ version, partyId: id().nullable(), addressId: id().nullable().optional(), locationId: id().nullable().optional() }),
  response: { 200: depthAnswer },
})

// ---- delivery tolerances --------------------------------------------------------------------------------------------------

export const toleranceView = output({
  id: id(),
  companyId: id().nullable(),
  company: output({ code: z.string(), name: z.string() }).nullable(),
  supplierId: id().nullable(),
  supplier: output({ code: z.string(), name: z.string() }).nullable(),
  itemId: id().nullable(),
  item: output({ code: z.string(), name: z.string() }).nullable(),
  itemKind: z.enum(ITEM_KINDS).nullable(),
  overPct: z.string(),
  underPct: z.string(),
  whenBeyond: z.enum(TOLERANCE_ACTIONS),
  status: z.enum(TOLERANCE_STATUSES),
  note: z.string().nullable(),
  /** The scope in words ("Company A · Supplier P2 · Leather"). */
  scope: z.string(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  updatedById: id().nullable(),
  /** The caller may change it (purchasing.tolerances.manage over its company; every company's: a role over every company). */
  mayChange: z.boolean(),
})

export const listTolerancesContract = defineContract({
  querystring: input({ companyId: id().optional(), supplierId: id().optional(), itemId: id().optional(), status: z.enum(TOLERANCE_STATUSES).optional() }),
  response: { 200: output({ tolerances: z.array(toleranceView) }) },
})

export const createToleranceContract = defineContract({
  body: input({
    companyId: id().nullable(),
    supplierId: id().nullable(),
    itemId: id().nullable(),
    itemKind: z.enum(ITEM_KINDS).nullable(),
    overPct: percent,
    underPct: percent,
    whenBeyond: z.enum(TOLERANCE_ACTIONS),
    note: z.string().max(MAX_TOLERANCE_NOTE).nullable().optional(),
  }),
  response: { 201: output({ tolerance: toleranceView }) },
})

export const updateToleranceContract = defineContract({
  params: input({ toleranceId: id() }),
  body: input({ version, overPct: percent.optional(), underPct: percent.optional(), whenBeyond: z.enum(TOLERANCE_ACTIONS).optional(), note: z.string().max(MAX_TOLERANCE_NOTE).nullable().optional() }),
  response: { 200: output({ tolerance: toleranceView }) },
})

export const moveToleranceContract = defineContract({
  params: input({ toleranceId: id() }),
  body: input({ version }),
  response: { 200: output({ tolerance: toleranceView }) },
})
