import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { DAILY_ORDER_ACTIONS } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON, ORDER_ACTIONS, SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
// B-TH-017: None / Part / All (rule C8).
import { INVOICED_STATES } from '@nexus/factory-domain/sales/orders/invoiced'
import { MAX_TEXT, SALES_LINE_KINDS, STORED_DEPOSIT_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { ORDER_SORTS } from './sort' // B-TH-057
// B-TH-058 / B-TH-059: the office's priority levels, the customer's own urgency (read-only).
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
// B-SA-012: why a waiting order waits.
import { WAIT_WORDS, type WaitReason } from '@nexus/factory-domain/sales/orders-depth/rules'
import { CUSTOMER_URGENCIES } from './customer-urgency'
import { pictureIds, smallPicturesView } from '../../product/images/small-pictures' // B-SA-011
// B-SA-070: the production columns of a row (the customer's Work tab).
import { BRAND_HEALTHS } from '@nexus/factory-domain/production-brand/health'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
import { IDS_TERM_MAX, PRODUCTION_WITHHELD } from './production-columns'

/**
 * The sales orders' contracts (B-W1-25; A2 SCR-038 "Orders", SCR-039 "Order record"). Money is marked: prices and totals
 * money.price, costs money.cost; the API drops a marked field the caller's grains do not reach. Per-size progress
 * carries no money. Every write sends the order's `version` (COL-078: a stale one is a 409 naming the current one).
 */

const version = z.number().int().min(1)
/** B-SA-012: why a waiting order waits (factory-domain orders-depth WAIT_WORDS' codes). */
const WAIT_REASONS = Object.keys(WAIT_WORDS) as [WaitReason, ...WaitReason[]]
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
  /** B-W2b-16: `reasonCode` = the CANCEL reason code chosen at the close (null for a line closed before W2b). */
  closedShort: output({ quantity: z.number().int(), at: instant().nullable(), byId: id().nullable(), reason: z.string().nullable(), reasonCode: z.string().nullable() }).nullable(),
  version: z.number().int(),
  /** Its size grid in the style's range order (a made-to-measure unit: one entry, size null), with the progress of each. */
  sizes: z.array(output({ size: z.string().nullable(), quantity: z.number().int(), unitPrice: money.price(z.string().nullable()), progress: progressView })),
  progress: progressView,
})

const depositView = output({
  id: id(),
  quoteVersionId: id().nullable(),
  orderId: id().nullable(),
  kind: z.enum(STORED_DEPOSIT_KINDS),
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
  /** B-W2b-16: its version (the owner's waive of a request no step names is sent at it). */
  version: z.number().int(),
})

const settlementView = output({
  /** Every line shipped, invoiced and paid (the money module's answer). */
  settled: z.boolean(),
  missing: z.array(output({ code: z.string(), message: z.string() })),
  source: z.string(),
})

// ── B-SA-034: the parts of the order page a live message re-reads, and those whose last change the order read names ──
export const ORDER_PAGE_PARTS = ['order', 'headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes', 'money', 'shipments', 'files'] as const
export type OrderPagePart = (typeof ORDER_PAGE_PARTS)[number]
export const LAST_CHANGE_PARTS = ['order', 'changes', 'work', 'shipments', 'money'] as const
export type LastChangePart = (typeof LAST_CHANGE_PARTS)[number]
const lastChangeView = output({
  by: output({ kind: z.enum(['OFFICE', 'CUSTOMER', 'FLOOR', 'SYSTEM']), name: z.string().nullable(), words: output({ it: z.string(), en: z.string() }) }),
  at: instant(),
})
// ── end B-SA-034 ──

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
  // ── B-SA-034 (Sales page plan P17): the order page's live watch list, the server's, and who changed each part last ──
  live: output({
    /** Each declared event type the page listens to, and the parts it re-reads on it (matched by the ids below). */
    events: z.array(output({ type: z.string(), parts: z.array(z.enum(ORDER_PAGE_PARTS)) })),
    /** The order's own records (work orders: only those the reader reaches). No party id ever. */
    ids: output({
      workOrderIds: z.array(id()),
      shipmentIds: z.array(id()),
      invoiceIds: z.array(id()),
      depositRequestIds: z.array(id()),
      requestIds: z.array(id()),
      changeIds: z.array(id()),
    }),
  }),
  /** Per part, the newest change: an office person or the order's own customer by name, "the floor" or "Nexus"; null: none. */
  lastChange: output({ order: lastChangeView.nullable(), changes: lastChangeView.nullable(), work: lastChangeView.nullable(), shipments: lastChangeView.nullable(), money: lastChangeView.nullable() }),
  // ── end B-SA-034 ──
})

const one = output({ order: orderView })

const filterFields = {
  companyId: id().optional(),
  partyId: id().optional(),
  promiseFrom: businessDate().optional(),
  promiseTo: businessDate().optional(),
  /** Number or customer reference, case-insensitive. */
  q: z.string().trim().min(1).max(100).optional(),
  // ── B-TH-225 (threads plan TH-1a, picture 23: Brand narrows the sheet) ──
  /** The label on the garment: orders with a line of a style of this brand party, or `own` (our own collection). */
  brand: z.union([id(), z.literal('own')]).optional(),
  // ── end B-TH-225 ──
  // ── B-TH-057 (threads plan TH-4, SHEET-G05: screen = file) ──
  /** The custom fields' filter (`code:A,B;code>=X`, platform/fields filters): the list, its counts and its file keep the same rows. */
  cf: z.string().trim().min(1).max(2000).optional(),
  // ── end B-TH-057 ──
  // ── B-TH-058 / B-TH-059 (threads plan TH-4: every total of the overall view opens exactly its rows) ──
  /** None / Part / All by pieces on issued invoices less issued credit notes (the row's Invoiced, rule C8). */
  invoiced: z.enum(INVOICED_STATES).optional(),
  /** The ORDER_LATE_RISK rule calls it at risk now: still being made, promised within the rule's days for its company. */
  atRisk: flag.optional(),
  /** The customer's own mark (Urgent / Regular), read-only; none until the production lane's reader is registered. */
  customerUrgency: z.enum(CUSTOMER_URGENCIES).optional(),
  /** The order's currency (ISO 4217): a money total per currency opens its own rows. */
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  // ── end B-TH-058 / B-TH-059 ──
  /** B-TH-244: shipped goods no issued invoice bills yet (the Orders sheet's built-in view "Shipped, not invoiced"). */
  shippedNotInvoiced: flag.optional(),
  // ── B-SA-020 (sales page plan N7, pick P12): made-to-measure orders — the list, the board's counts, the tiles, the totals and the file alike ──
  /** `mtm`: orders with a made-to-measure unit (a line of kind MADE_TO_MEASURE). */
  kind: z.enum(['mtm']).optional(),
  // ── B-SA-021: a rider's orders — a unit of any revision of the rider's garment profile; only with sales.measurements.view (403 in words) ──
  profile: id().optional(),
  // ── B-SA-070 (sales page plan R5): the customer's Work tab's "Waiting on us" — the keeper says the order waits on us, or a customer
  // request on it is still OPEN; the list, the board's counts, the totals and the file alike ──
  waiting: z.enum(['us']).optional(),
}

/** B-TH-058: the list's every row term (the overall view's totals take the same, so each total opens exactly its rows). */
const viewTermFields = {
  status: status.optional(),
  /** Only orders not shipped yet. */
  open: flag.optional(),
  /** The promise passed and the order is not shipped yet. */
  late: flag.optional(),
  /** The order needs a deposit and a request of it is still OPEN. */
  deposit: z.enum(['OPEN']).optional(),
  /** B-W2b-323: a change waits for the customer to accept it (reapprovalNeededAt set), the order not closed or cancelled. */
  reaccept: flag.optional(),
  ...filterFields,
}

export const listOrdersContract = defineContract({
  querystring: input({
    ...viewTermFields, // B-TH-058: the same terms as before, named once
    // ── B-TH-057 (SHEET-G15): the server sort; with it the cursor is the page before's sort key and id (opaque) ──
    /** customer, brand, promise, daysLate, ordered; `-` in front: the other way round. None: newest first. */
    sort: z.enum(ORDER_SORTS).optional(),
    cursor: z.string().trim().min(1).max(600).optional(),
    // ── end B-TH-057 ──
    /** B-TH-059: count each row's production progress (the Progress column is shown): it reads the floor's records of the page's work orders. */
    progress: flag.optional(),
    // ── B-SA-070: the production columns (stage, health, waiting on, held, supervisor mark, open requests and issues), and the rows in
    // view read again (≤ 50 order ids, comma separated; ids the reader may not see are left out) ──
    production: flag.optional(),
    ids: z.string().trim().min(36).max(IDS_TERM_MAX * 37).optional(),
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
          // ── B-TH-017 (threads plan TH-1a, pictures 23 + 24): the sheet's columns and the ids its doors open ─────────────
          /**
           * The main picture of the first line's style: its file only with files.read (null: the placeholder); `small`: its
           * ~320 px preview exists (POST /sales/orders/pictures serves it, B-SA-011; the sheet never loads the original).
           */
          picture: output({ styleId: id(), styleCode: z.string(), styleName: z.string(), fileId: id().nullable(), contentType: z.string().nullable(), small: z.boolean() }).nullable(),
          /** The order's distinct styles ("+2" beside the picture). */
          styleCount: z.number().int(),
          /**
           * The label on the garment (the style's brand), one entry per label across the lines: `own` = our own collection;
           * a label of a party the reader may not see has neither id nor name.
           */
          brands: z.array(output({ partyId: id().nullable(), name: z.string().nullable(), own: z.boolean() })),
          /** None / Part / All by pieces on issued invoices less issued credit notes (drafts and deposit invoices left out). */
          invoiced: output({ state: z.enum(INVOICED_STATES), pieces: z.string(), toInvoice: z.number().int(), amount: money.price(z.number().int()) }),
          /** The ids each cell opens, only those the reader may open (null: no right; the row's own words stay). */
          doors: output({
            quote: output({ id: id(), versionId: id() }).nullable(),
            depositInvoice: output({ id: id(), number: z.string().nullable() }).nullable(),
            deliveryNotes: output({ count: z.number().int(), only: output({ id: id(), number: z.string() }).nullable(), shipmentId: id().nullable() }).nullable(),
            invoices: output({ count: z.number().int(), only: output({ id: id(), number: z.string().nullable(), docType: z.string() }).nullable() }).nullable(),
          }),
          // ── end B-TH-017 ──────────────────────────────────────────────────────────────────────────────────────────────
          // ── B-TH-059 (threads plan TH-4; N23, ORD-G08): the later columns ─────────────────────────────────────────────
          /** Pieces it still owes: an open order's pieces less those closed short and those that left (0 once shipped, closed or cancelled). */
          openUnits: z.number().int(),
          /**
           * Only with `progress=true`: its lines' cells in work orders past DRAFT (not REPAIR, not cancelled), summed over every
           * work order and site — `inWork` their pieces, `cut` from the cutting log, `sewn` and `finished` from the floor's scans
           * (the work order record's counts; a step no cell counts: null). null: no work order past DRAFT yet. Totals only.
           */
          progress: output({ inWork: z.number().int(), cut: z.number().int().nullable(), sewn: z.number().int().nullable(), finished: z.number().int().nullable() }).nullable().optional(),
          /** Received for the order: its deposit requests' payments and its share of its invoices' payments, less refunds (price grain). */
          paid: money.price(z.number().int()),
          /** Still to pay: its gross less what will never be billed, its credit notes and what is paid; never below 0 (price grain). */
          balance: money.price(z.number().int()),
          /** The sites that make it (its lines' sites and its work orders'), each once. */
          sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
          /** The order note: the office's own, the customer never sees it. */
          internalNote: z.string().nullable(),
          /** The office's own priority: its level (with its words), number within the level and urgent reason. */
          priority: output({ level: z.enum(SALES_ORDER_PRIORITY_LEVELS), words: output({ en: z.string(), it: z.string() }), number: z.number().int(), urgentReason: z.string().nullable() }),
          /** The ORDER_LATE_RISK rule calls it at risk: days left to the promise and the rule's threshold; null: not at risk or no rule. */
          atRisk: output({ daysLeft: z.number().int(), daysBeforePromise: z.number().int() }).nullable(),
          /** The customer's own mark, read-only (Sales › Orders' Priority stays the office's); null: none known. */
          customerUrgency: z.enum(CUSTOMER_URGENCIES).nullable(),
          // ── end B-TH-059 ──────────────────────────────────────────────────────────────────────────────────────────────
          /** B-SA-012: why a PENDING_APPROVAL order waits (a yes asked, credit, the factory review, a yes nobody asked); null otherwise. */
          waits: z.array(z.enum(WAIT_REASONS)).nullable(),
          /**
           * B-SA-020: its made-to-measure units (null: none) — the units still owed (closed short left out), those whose measures the
           * factory review has not confirmed, and the riders ONLY for a reader of measurements (sales.measurements.view over the
           * customer: the first two names and how many riders in all; null without it). Never a measurement, a base size or a photo.
           */
          madeToMeasure: output({ units: z.number().int(), waitingReview: z.number().int(), riders: output({ names: z.array(z.string()), count: z.number().int() }).nullable() }).nullable(),
          /**
           * B-SA-070: only with `production=true` — the keeper's stored state (no facts read per row): the plain stage and since when,
           * the shown health (a standing raise counts), who it waits on and since when, a live work order of it on hold, the supervisor
           * mark (Me / Someone else / Not set, never a name) and the open production issues only with workorders.view over the order
           * (else null, named in `withheld`), and the customer requests still OPEN.
           */
          production: output({
            stage: z.enum(BRAND_STAGES).nullable(),
            stageSince: businessDate().nullable(),
            health: z.enum(BRAND_HEALTHS).nullable(),
            waitingOn: z.enum(WAITING_ON).nullable(),
            since: instant().nullable(),
            held: z.boolean(),
            supervisorMark: z.enum(SUPERVISOR_MARKS).nullable(),
            openRequests: z.number().int(),
            openIssues: z.number().int().nullable(),
            withheld: z.array(z.enum(PRODUCTION_WITHHELD)),
          }).optional(),
        }),
      ),
      /** B-TH-057: the next page's cursor (an id newest first; an opaque sort key and id in a server sort). */
      nextCursor: z.string().nullable(),
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
      // B-W2b-323: + waitingForCustomer (design sec:orders.tiles "Waiting for the customer to accept a change").
      // B-SA-012: + waitingForApproval (status PENDING_APPROVAL: the board's first lane).
      tiles: z.array(output({ key: z.enum(['late', 'waitingForApproval', 'waitingForDeposit', 'inProduction', 'readyToShip', 'waitingForCustomer']), count: z.number().int(), filter: z.record(z.string(), z.string()) })),
      asOf: instant(),
    }),
  },
})

export const getOrderContract = defineContract({ params: orderParams, response: { 200: one } })

export const makeOrderContract = defineContract({
  // B-W2b-290 (SAL-013): the customer's PO number, when its terms with the company require one and the quote had none.
  body: input({ quoteVersionId: id(), customerRef: z.string().trim().max(MAX_TEXT.customerRef).nullish() }),
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

// ── B-SA-011 (sales page plan N8): the small pictures of a page of orders in ONE read (modules/product/images/small-pictures.ts) ──
export const orderPicturesReadContract = defineContract({ body: input({ orderIds: pictureIds() }), response: { 200: smallPicturesView } })
// ── end B-SA-011 ──

// ── B-TH-019: the Customer switcher's numbers ─────────────────────────────────────────────────────────────────────────
export const customersContract = defineContract({
  querystring: input({
    /** A customer's name or code, case-insensitive. */
    q: z.string().trim().min(1).max(100).optional(),
    companyId: id().optional(),
    /** B-SA-020: the counts of made-to-measure orders only (the sheet's `kind=mtm`: "3 open · 1 late" counts what the rows show). */
    kind: z.enum(['mtm']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      /** The customers with orders the reader may see, most recent order first. */
      customers: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          archived: z.boolean(),
          /** Orders in all, open (not shipped yet) and late (the promise passed, not shipped yet). */
          orders: z.number().int(),
          open: z.number().int(),
          late: z.number().int(),
          lastOrderDate: z.string().nullable(),
        }),
      ),
      /** How many customers match (the picker says "type to find" beyond the first `limit`): a count, not money. */
      total: notMoney(z.number().int()),
      // ── B-TH-226: every grant of the reader's orders.view names its customers ("All my customers (3)", a fixed label for one) ──
      limited: z.boolean(),
      asOf: instant(),
    }),
  },
})
// ── end B-TH-019 ──────────────────────────────────────────────────────────────────────────────────────────────────────

// ── B-TH-058 (threads plan TH-4; SHEET-G08; features SHEET.overall-F02, -F03, -F08, -F11; wall W30 / T30): the overall view ──
/** A number that opens its rows: the list's terms (GET /sales/orders) that read exactly what it counts; null: none (it counts nothing). */
const door = output({ count: z.number().int(), filter: z.record(z.string(), z.string()).nullable() })

/** The figures of a view or of one customer of it, each a door; `net` per currency only with the price grain (never summed across). */
const figuresView = output({
  /** The orders. */
  orders: door,
  /** Pieces ordered and shipped (the rows' `units` and `shippedUnits` sum to them) and still owed (open orders: `openUnits`). */
  pieces: output({ ordered: door, shipped: door, open: door }),
  /** The promise passed, not shipped yet (the list's one definition of late). */
  late: door,
  /** The ORDER_LATE_RISK rule calls them at risk (the row's `atRisk`). */
  atRisk: door,
  /** Invoiced None / Part / All (rule C8). */
  invoiced: output({ NONE: door, PART: door, ALL: door }),
  /** The net per currency, one entry each (price grain: absent without it). */
  net: money.price(z.array(output({ currency: z.string(), amount: money.price(z.number().int()), filter: z.record(z.string(), z.string()).nullable() }))),
})

export const summaryContract = defineContract({
  querystring: input({
    ...viewTermFields,
    /** `party`: the figures per customer too (one header per customer), beside those of the whole view. */
    group: z.enum(['party']).optional(),
  }),
  response: {
    200: output({
      /** The whole view (the pinned grand total): every order the terms keep that the reader may see, never only the loaded rows. */
      all: figuresView,
      /** With group=party: one entry per customer of the view (by name), its sheet's name and code and its invoicing rhythm; else null. */
      groups: z
        .array(output({ partyId: id(), code: z.string(), name: z.string(), invoiceTiming: z.enum(['PER_SHIPMENT', 'MONTHLY']), figures: figuresView }))
        .nullable(),
      /** The reader's orders.view names its customers: the figures are of "Your customers" (nothing is said of the others). */
      limited: z.boolean(),
      asOf: instant(),
    }),
  },
})
// ── end B-TH-058 ──────────────────────────────────────────────────────────────────────────────────────────────────────
