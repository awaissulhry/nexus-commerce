import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { DAILY_ORDER_ACTIONS } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON, ORDER_ACTIONS, SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { DEPOSIT_KINDS, SALES_LINE_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'

/**
 * The sales orders' contracts (B-W1-25; A2 SCR-038 "Orders", SCR-039 "Order record"). Money is marked: prices and totals
 * money.price, costs money.cost; the API drops a marked field the caller's grains do not reach. Per-size progress
 * carries no money. Every write sends the order's `version` (COL-078: a stale one is a 409 naming the current one).
 */

const version = z.number().int().min(1)
const reason = z.string().trim().min(1).max(MAX_REASON)
const json = z.record(z.string(), z.unknown())
const status = z.enum(SALES_ORDER_STATUSES)
const flag = z.enum(['true', 'false'])
const orderParams = input({ orderId: id() })

/** Ordered, in work orders, made (null until the floor's scans), released by quality, shipped, invoiced, still to ship. */
const progressView = output({
  ordered: z.number().int(),
  inWorkOrders: z.number().int(),
  made: z.null(),
  released: z.number().int(),
  shipped: z.number().int(),
  /** A decimal string: issued invoices less issued credit notes. */
  invoiced: z.string(),
  toShip: z.number().int(),
  /** B-W2a-30: pieces closed short (will not be made or shipped). */
  closedShort: z.number().int(),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(SALES_LINE_KINDS),
  quoteLineId: id().nullable(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string() }).nullable(),
  /** The RELEASED revision it is made to, when the order fixes one (else the work order chooses). */
  styleRevisionId: id().nullable(),
  styleRevision: output({ revision: z.number().int(), status: z.string() }).nullable(),
  colourwayId: id(),
  colourway: output({ code: z.string(), name: z.string() }).nullable(),
  measurementProfileId: id().nullable(),
  baseSize: z.string().nullable(),
  description: z.string().nullable(),
  note: z.string().nullable(),
  quantity: z.number().int(),
  /** On the order's price basis (net for a business, VAT included for a consumer), as accepted. */
  unitPrice: money.price(z.string()),
  netAmount: money.price(z.number().int()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatAmount: money.price(z.number().int()),
  unitCost: money.cost(z.string().nullable()),
  costAmount: money.cost(z.number().int().nullable()),
  /** The line's own dates and priority; null: the order's. */
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  priority: z.number().int().nullable(),
  siteId: id().nullable(),
  /** B-W2a-30 (SAL-210): closed short — the pieces that will not be made or shipped, when, by whom, why; null: open. */
  closedShort: output({ quantity: z.number().int(), at: instant().nullable(), byId: id().nullable(), reason: z.string().nullable() }).nullable(),
  version: z.number().int(),
  /** Its size grid in the style's range order (a made-to-measure unit: one entry, size null), with the progress of each. */
  sizes: z.array(output({ size: z.string().nullable(), quantity: z.number().int(), unitPrice: money.price(z.string().nullable()), progress: progressView })),
  progress: progressView,
})

const depositView = output({
  id: id(),
  quoteVersionId: id().nullable(),
  orderId: id().nullable(),
  kind: z.enum(DEPOSIT_KINDS),
  depositPct: z.string().nullable(),
  currency: z.string(),
  amount: money.price(z.number().int()),
  dueDate: z.string(),
  fiscalDocument: z.enum(['TD02', 'NONE']),
  fiscalRule: z.string(),
  status: z.enum(['OPEN', 'PAID', 'WAIVED', 'CANCELLED']),
  paidAt: instant().nullable(),
  createdAt: instant(),
  /** What payments placed on it so far (allocations less their reversals). */
  paidAmount: money.price(z.number().int()),
  /** Its latest bank-details page sent to the customer (DEPOSIT_INFO link), or null when none was sent. */
  link: output({ sentAt: instant(), to: z.string().nullable(), expiresAt: instant(), state: z.enum(LINK_STATES) }).nullable(),
  /**
   * B-W2a-F2: the payment-schedule step that names it — DEPOSIT (the deposit production waits for) or BEFORE_SHIPPING
   * (the balance paid before the goods leave, invoiced as an advance); null: no step names it (an order made before the
   * schedule existed: its deposit).
   */
  stepKind: z.enum(['DEPOSIT', 'BEFORE_SHIPPING']).nullable(),
})

const settlementView = output({
  /** Every line shipped, invoiced and paid (the money module's answer). */
  settled: z.boolean(),
  missing: z.array(output({ code: z.string(), message: z.string() })),
  source: z.string(),
})

export const orderView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }).nullable(),
  customerRef: z.string().nullable(),
  status,
  orderDate: z.string(),
  currency: z.string(),
  language: z.string(),
  taxMode: z.enum(PARTY_TAX_MODES),
  /** NET for a business, GROSS (VAT included) for a consumer: the basis of every unit price. */
  priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
  /** The buyer and the delivery address as accepted. */
  billTo: json,
  shipTo: json,
  paymentTerms: z.string().nullable(),
  /** B-W2a-30: the library terms its payment schedule comes from. */
  paymentTermsId: id().nullable(),
  requestedDate: z.string().nullable(),
  promiseDate: z.string().nullable(),
  /** The first promise: never changes. */
  originalPromiseDate: z.string().nullable(),
  /** Days past the promise while not shipped (0 on time; null without a promise or once shipped). */
  daysLate: z.number().int().nullable(),
  priority: z.number().int(),
  noWithdrawal: z.boolean(),
  /** Production waits for a PAID or WAIVED deposit request (the work orders' deposit gate). */
  depositRequired: z.boolean(),
  netAmount: money.price(z.number().int()),
  vatAmount: money.price(z.number().int()),
  grossAmount: money.price(z.number().int()),
  costAmount: money.cost(z.number().int().nullable()),
  /** The estimated margin % of the net from the accepted costs (null without a complete cost). */
  marginPct: money.margin(z.string().nullable()),
  reapprovalNeededAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  closedAt: instant().nullable(),
  internalNote: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
  lines: z.array(lineView),
  progress: progressView,
  /** The record chain: quote and version → order → deposit requests → work orders → shipments → invoices. */
  chain: output({
    quote: output({ id: id(), number: z.string(), versionId: id(), revision: z.number().int() }).nullable(),
    depositRequests: z.array(depositView),
    workOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), siteId: id(), releasedAt: instant().nullable() })),
    shipments: z.array(output({ id: id(), number: z.string(), status: z.string(), shippedAt: instant().nullable(), deliveredAt: instant().nullable() })),
    invoices: z.array(output({ id: id(), number: z.string().nullable(), docType: z.string(), status: z.string(), issueDate: z.string().nullable(), /** A TD02: the deposit request it bills. */ depositRequestId: id().nullable() })),
  }),
  /** Every promise change, newest first: who, when, from → to, which lines (none: the order), why. */
  promiseHistory: z.array(output({ at: instant(), actorId: id(), from: z.string().nullable(), to: z.string(), lineIds: z.array(id()), reason: z.string().nullable() })),
  /** The names of the people the record names (promise changes, who made it). */
  people: z.array(output({ id: id(), name: z.string() })),
  settlement: settlementView,
  /** What may be done next, held with the first reason in words. */
  actions: z.array(output({ action: z.enum(ORDER_ACTIONS), allowed: z.boolean(), needsReason: z.boolean(), held: z.string().nullable() })),
  /** B-W2a-30: amend, close and reopen lines, copy as a new quote — each held with its reason in words. */
  dailyActions: z.array(output({ action: z.enum(DAILY_ORDER_ACTIONS), allowed: z.boolean(), held: z.string().nullable() })),
  /** B-W2a-30 (SAL-217): its amendments so far (GET …/amendments has them whole). */
  amendments: output({ count: z.number().int(), latestRevision: z.number().int().nullable(), latestAt: instant().nullable() }),
  /** SAL-209: a confirmed order's lines change only through an amendment. */
  locked: z.boolean(),
})

const one = output({ order: orderView })

const filterFields = {
  companyId: id().optional(),
  partyId: id().optional(),
  promiseFrom: businessDate().optional(),
  promiseTo: businessDate().optional(),
  /** Number or customer reference, case-insensitive. */
  q: z.string().trim().min(1).max(100).optional(),
}

export const listOrdersContract = defineContract({
  querystring: input({
    status: status.optional(),
    /** Only orders not shipped yet. */
    open: flag.optional(),
    /** The promise passed and the order is not shipped yet. */
    late: flag.optional(),
    /** The order needs a deposit and a request of it is still OPEN. */
    deposit: z.enum(['OPEN']).optional(),
    ...filterFields,
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          companyId: id(),
          partyId: id(),
          partyName: z.string(),
          customerRef: z.string().nullable(),
          status,
          /** Not needed, missing (needed, no request), open (with its due date), paid or waived. */
          deposit: output({ state: z.enum(['NOT_NEEDED', 'MISSING', 'OPEN', 'PAID', 'WAIVED']), dueDate: z.string().nullable() }),
          lineCount: z.number().int(),
          units: z.number().int(),
          shippedUnits: z.number().int(),
          orderDate: z.string(),
          requestedDate: z.string().nullable(),
          promiseDate: z.string().nullable(),
          daysLate: z.number().int().nullable(),
          currency: z.string(),
          netAmount: money.price(z.number().int()),
          grossAmount: money.price(z.number().int()),
          quote: output({ id: id(), number: z.string(), versionId: id(), revision: z.number().int() }).nullable(),
          version: z.number().int(),
          updatedAt: instant(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const boardContract = defineContract({
  querystring: input(filterFields),
  response: {
    200: output({
      byStatus: z.array(output({ status, count: z.number().int() })),
      /** The board's lanes, in order (closed and cancelled are counted in byStatus). */
      lanes: z.array(status),
      /** Each tile's count is the list's total under its filter (the same query parameters). */
      tiles: z.array(output({ key: z.enum(['late', 'waitingForDeposit', 'inProduction', 'readyToShip']), count: z.number().int(), filter: z.record(z.string(), z.string()) })),
      asOf: instant(),
    }),
  },
})

export const getOrderContract = defineContract({ params: orderParams, response: { 200: one } })

export const makeOrderContract = defineContract({
  body: input({ quoteVersionId: id() }),
  response: { 200: output({ created: z.boolean(), order: orderView }), 201: output({ created: z.boolean(), order: orderView }) },
})

export const promiseContract = defineContract({
  params: orderParams,
  body: input({
    version,
    promiseDate: businessDate(),
    reason,
    /** Only these lines get the new promise; none: the whole order. */
    lineIds: z.array(id()).max(200).optional(),
  }),
  response: { 200: one },
})

export const readyContract = defineContract({ params: orderParams, body: input({ version, reason }), response: { 200: one } })


export const closeContract = defineContract({
  params: orderParams,
  /** A reason is needed when the order is not settled (and the right to close it then, orders.close). */
  body: input({ version, reason: z.string().trim().max(MAX_REASON).nullish() }),
  response: { 200: one },
})
