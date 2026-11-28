import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson, money, notMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels'
import { SALES_LINE_KINDS, STORED_DEPOSIT_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { PROGRESS_STAGES } from '@nexus/factory-domain/sales/portal-orders/progress'
import { PROMISE_REASON_CODES } from '@nexus/factory-domain/sales/portal-orders/promise'
import { CUSTOMER_SHIPMENT_STATUSES, SHIPMENT_MILESTONES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { CUSTOMER_ORDER_STATUSES, MILESTONE_STATES, MILESTONES, ORDER_CHIPS } from '@nexus/factory-domain/sales/portal-orders/status'
import { ORDER_GROUPS } from '@nexus/factory-domain/sales/portal-orders/status' // pg-s1 S1.2
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { PICTURES_MAX } from '../../product/images/small-pictures' // pg-s2 S2.1: the office's batch body (1–200 ids); owb- po1.1: of both kinds
// owb- po1.4 (order workflow): the customer's own columns (the shared answer shapes).
import { ownColumn, ownValue, recordOwnColumns } from '../own-columns/schemas'
// owb- po2.2 (order workflow): the customer's Money tab and its "I paid" notice.
import { ADDS_UP_KEYS, MONEY_DOCUMENT_KINDS, NOTICE_STATES, PLAN_STATES, PLAN_STEP_KINDS } from '@nexus/factory-domain/sales/portal-orders/money'
// owb- po1.1 (order workflow): the sheet's row kinds and waits, the nine life words, the line model kinds.
import { SHEET_ROW_KINDS, SHEET_WAITS } from '@nexus/factory-domain/sales/portal-orders/sheet-rows'
import { LIFE_NOTE_KINDS, ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { LINE_MODEL_KINDS } from '@nexus/factory-domain/sales/portal-ordering/line-moves'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081; design portal.customer.orders). Every
 * status, step and stage comes with its words in Italian and English (`words`). Money is marked price: the API drops it
 * for a role without the price grain (customer Quality, Designer, Viewer; an office preview), and `seesPrices` tells the
 * page to say "Prices are not part of your access" once. No cost, no margin, no person of the office or the floor.
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const status = z.enum(CUSTOMER_ORDER_STATUSES)
const pieces = output({ ordered: z.number().int(), shipped: z.number().int(), open: z.number().int() })
const named = output({ code: z.string(), name: z.string() })
const orderParams = input({ orderId: id() })
const live = output({ events: z.array(z.string()) })
/** B-TH-105: the customer's own number of a record with its words (null: none). */
const yourNumber = output({ seq: z.number().int(), words }).nullable()

const nextShipment = output({
  id: id(),
  /** pg-s1 S1.3 (Owner D6): never the office's shipment series — a shipment is named by its order ("Your order 12 · parcel 1"). */
  number: z.null(),
  /** pg-s1 S1.3 (D6): which of the order's shipments that left it is (1-based, by the moment it left); a packed one not left yet: the next. */
  parcel: z.number().int(),
  status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
  words,
  date: day.nullable(),
  carrierName: z.string().nullable(),
  /** B-W2b-F14: when the carrier expects to deliver it (while packed or on the way); null: not said. */
  expectedDeliveryAt: instant().nullable(),
})

const row = output({
  /**
   * ORDER, or REQUEST: a portal order request sent and not decided yet. fix-portal-numbers-1 (B-TH-303): an order's `number` is
   * null — the customer reads its own `yourNumber`, never the office's series; pg-s1 S1.3 (G3-B1): a request's too (its RQ-… is
   * the company's series: it would tell how much the others ask; the search still finds the row by it).
   */
  kind: z.enum(['ORDER', 'REQUEST']),
  id: id(),
  /** Their purchase order number (first in the row). */
  customerRef: z.string().nullable(),
  /** pg-fx4 (Z5): a REQUEST row's subject (the sent draft's title, 1 to 200 characters); null: none, and always for an ORDER row. */
  subject: z.string().nullable(),
  number: z.null(),
  /** B-TH-105 (Owner decision PR-06): "Your order 12", the customer's own count beside our number (a request: null). */
  yourNumber,
  orderedOn: day.nullable(),
  status,
  words,
  promiseDate: day.nullable(),
  /** The first promise (kept): the moved mark when it differs from the promise now. */
  originalPromiseDate: day.nullable(),
  promiseMoved: z.boolean(),
  /** The promise moved in the last 14 days (the "Date moved" chip). */
  movedLately: z.boolean(),
  requestedDate: day.nullable(),
  pieces,
  netAmount: money.price(z.number().int().nullable()),
  currency: z.string(),
  nextShipment: nextShipment.nullable(),
  /** With progress=true, for the first 10 rows of the page when the customer shares progress (C1); else null. */
  progressPercent: z.number().int().nullable(),
  /** pg-s1 (Z4): the row's one mark "Needs your answer" — an OPEN order whose revision waits for their re-confirmation; a request: false. */
  needsYou: z.boolean(),
})

export const listContract = defineContract({
  querystring: input({
    chip: z.enum(ORDER_CHIPS).default('OPEN'),
    /**
     * Their PO number, our order number, or a style's code or name; pg-fx4: a request's subject. pg-s1 S1.3: a number alone ("12",
     * "#12") is their own number, matched exactly ("Your order 12", never 112), or (without "#") a PO holding it.
     */
    q: z.string().trim().max(80).optional(),
    /** The production progress % of the page's first 10 rows (Home's next deliveries), when shared. */
    progress: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: {
    200: output({
      asOf: instant(),
      seesPrices: notMoney(z.boolean()),
      chip: z.enum(ORDER_CHIPS),
      chips: z.array(output({ chip: z.enum(ORDER_CHIPS), count: z.number().int(), words })),
      /** Rows in the chip (after the search). */
      count: z.number().int(),
      items: z.array(row),
      live,
    }),
  },
})

const milestone = output({ key: z.enum(MILESTONES), words, state: z.enum(MILESTONE_STATES), date: day.nullable(), expected: day.nullable(), current: z.boolean() })

const sizeRow = output({ size: z.string().nullable(), ordered: z.number().int(), shipped: z.number().int(), open: z.number().int(), closedShort: z.number().int(), unitPrice: money.price(z.string().nullable()) })

const line = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(SALES_LINE_KINDS),
  style: named.nullable(),
  colourway: named.nullable(),
  description: z.string().nullable(),
  /** A made-to-measure unit: the rider and the measurement revision it is made to, and its base size. */
  measurement: output({ riderName: z.string(), revision: z.number().int() }).nullable(),
  baseSize: z.string().nullable(),
  quantity: z.number().int(),
  unitPrice: money.price(z.string()),
  netAmount: money.price(z.number().int()),
  vatAmount: money.price(z.number().int()),
  /** The line's own dates when they differ from the order's (null: the order's). */
  requestedDate: day.nullable(),
  promiseDate: day.nullable(),
  /** Closed short: the pieces that will not be made or shipped, and the day. */
  closedShort: output({ quantity: z.number().int(), on: day.nullable() }).nullable(),
  sizes: z.array(sizeRow),
  pieces,
})

export const recordContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      asOf: instant(),
      seesPrices: notMoney(z.boolean()),
      order: output({
        id: id(),
        customerRef: z.string().nullable(),
        /** owb- po2 (S1 lead add): the subject of the Draft/Sent order it was confirmed from (its title); null: none. */
        subject: z.string().nullable(),
        // pp-s s.1 (O3-W1): the office's series (a count across every customer) is never in the customer's order: its own
        // number (`yourNumber`) and its PO name it. A key left out here is stripped from the answer.
        // B-TH-105
        yourNumber,
        status,
        words,
        orderDate: day,
        requestedDate: day.nullable(),
        promiseDate: day.nullable(),
        originalPromiseDate: day.nullable(),
        promiseMoved: z.boolean(),
        currency: z.string(),
        language: z.string(),
        /** The delivery address as agreed (the order's snapshot). */
        shipTo: z.record(z.string(), z.unknown()),
        paymentTerms: z.string().nullable(),
        /** Made to measure for a consumer: no right of withdrawal applies. */
        noWithdrawal: z.boolean(),
        /** Production starts when the deposit is received. */
        depositRequired: z.boolean(),
        netAmount: money.price(z.number().int()),
        vatAmount: money.price(z.number().int()),
        grossAmount: money.price(z.number().int()),
        /** A revised order waits for their re-confirmation (the re-confirm step is its own page). */
        reconfirmNeeded: z.boolean(),
        cancelledOn: day.nullable(),
        version: z.number().int(),
        /** B-OM-005 (order money tab M1-S4): what is still to pay on the order, by the office's own rule (a cancelled order owes 0). */
        stillToPay: money.price(z.number().int().nullable()),
      }),
      milestones: z.array(milestone),
      promiseHistory: z.array(
        // B-OL-004 (18 F23): `reason` null — the office gave none (the customer reads no reason, never "Our planning changed").
        output({ on: day, from: day.nullable(), to: day, lines: z.array(z.number().int()), reason: output({ code: z.enum(PROMISE_REASON_CODES), words }).nullable() }),
      ),
      deposits: z.array(
        output({
          id: id(),
          kind: z.enum(STORED_DEPOSIT_KINDS),
          status: z.string(),
          amount: money.price(z.number().int()),
          currency: z.string(),
          dueDate: day,
          paidAt: instant().nullable(),
          /** B-OM-005 (order money tab M3-B6): what the customer's payments placed on it so far (a part payment shows). */
          paidAmount: money.price(z.number().int()),
        }),
      ),
      lines: z.array(line),
      pieces: pieces.extend({ closedShort: z.number().int() }),
      /**
       * What the customer sees of its production (its own share level, C1; B-PR-40: the old progress switch dropped): GET
       * …/progress answers from PROGRESS on (production-brand/levels shares(level, 'progress')).
       */
      productionLevel: z.enum(PRODUCTION_SHARE_LEVELS),
      shipments: output({ shown: z.number().int(), onTheWay: z.number().int() }),
      /** owb- po1.4: the customer's own columns ON this order (in order) and their values (lineId → columnId → value). */
      ownColumns: recordOwnColumns,
      /** owb- po1.5: the order's chosen picture (fileId null: none — the first line's design), when, and the file's type when the customer opens it. */
      picture: output({ fileId: id().nullable(), setAt: instant().nullable(), contentType: z.string().nullable() }),
      live,
    }),
  },
})

const stageFigures = { ordered: z.number().int(), cut: z.number().int().nullable(), sewn: z.number().int().nullable(), inspected: z.number().int().nullable(), packed: z.number().int().nullable() }

export const progressContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      /** When the counts were read (at most once a minute). */
      asOf: instant(),
      refreshSeconds: z.number().int(),
      stages: z.array(output({ key: z.enum(PROGRESS_STAGES), words })),
      lines: z.array(
        output({ lineId: id(), seq: z.number().int(), style: named.nullable(), colourway: named.nullable(), ...stageFigures, sizes: z.array(output({ size: z.string().nullable(), ...stageFigures })) }),
      ),
      whole: output(stageFigures),
      percent: z.number().int().nullable(),
    }),
  },
})

const trackingEvent = output({ at: instant(), status: z.enum(TRACKING_STATUSES), words, description: z.string().nullable(), location: z.string().nullable(), parcelSeq: z.number().int().nullable() })

const shipment = output({
  id: id(),
  // owb-po2c: no `number` — the office's shipment series (SH-…) never reaches the customer (it would tell how much others ship).
  status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
  words,
  transportBy: z.string(),
  carrierName: z.string().nullable(),
  packedAt: instant().nullable(),
  shippedAt: instant().nullable(),
  deliveredAt: instant().nullable(),
  /** B-W2b-F14: when the carrier expects to deliver it (while packed or on the way; none once delivered or returned). */
  expectedDeliveryAt: instant().nullable(),
  /** B-OP-031: the number typed for a carrier booked by hand; no carrier feeds it ("No live tracking"). null: none. */
  typedTrackingNumber: z.string().nullable(),
  /** B-OP-034: the tracking link typed beside it ("Track ›", https only); null: none. */
  typedTrackingUrl: z.string().nullable(),
  ddt: output({ number: z.string(), date: day }).nullable(),
  milestones: z.array(output({ key: z.enum(SHIPMENT_MILESTONES), words, done: z.boolean(), at: instant().nullable() })),
  parcels: z.array(
    output({
      seq: z.number().int(),
      trackingNumber: z.string().nullable(),
      /** B-W2b-F14: "Track on the carrier's site": the carrier's https tracking page and the link's words; null: none. */
      trackingLink: output({ url: z.string(), words }).nullable(),
      status: z.enum(TRACKING_STATUSES).nullable(),
      words: words.nullable(),
      lastEvent: trackingEvent.nullable(),
    }),
  ),
  events: z.array(trackingEvent),
  lines: z.array(output({ lineSeq: z.number().int(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), quantity: z.number().int() })),
  /** B-OP-044 (order page N6): the customer's other orders this shipment carries — "also N pieces of your order #12" (empty: none). */
  otherOrders: z.array(output({ yourNumber, customerRef: z.string().nullable(), pieces: z.number().int() })),
  papers: z.array(output({ fileId: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), versionNo: z.number().int() })),
  /** owb- po2.6 (S3's ss1): "At the factory's warehouse" — where it is there (S3's value as is); null: it goes straight to the customer. */
  atWarehouse: output({ place: z.string(), city: z.string().nullable(), since: instant().nullable(), sentOn: z.boolean(), labelSent: z.boolean() }).nullable().optional(),
})

export const shipmentsContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      asOf: instant(),
      shipments: z.array(shipment),
      stillToShip: z.array(
        output({ lineId: id(), seq: z.number().int(), style: named.nullable(), colourway: named.nullable(), size: z.string().nullable(), ordered: z.number().int(), shipped: z.number().int(), open: z.number().int(), expected: day.nullable() }),
      ),
      /** Nothing shipped yet: the first day expected (the earliest open line's). */
      firstExpected: day.nullable(),
      live,
    }),
  },
})

// ---- B-TH-061 (SHEET-G10, Owner decision 13; wall W39 / T39): the customer's own sheet — the list's rows with the columns the office
// ticked for the portal, and "Download all" written by the server in the partner scope (never the export job).
const portalColumn = output({
  /** The column id (`cf:<code>`, a money one `cf:price:<code>`). */
  columnId: z.string(),
  code: z.string(),
  type: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  unit: z.string().nullable(),
  grain: z.string().nullable(),
  /** A list's values the rows use (null: not a list field). */
  options: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string() })).nullable(),
})
const portalCell = output({ value: grainedJson(), wordsIt: z.string().nullable(), wordsEn: z.string().nullable() })

// ---- owb- po1.1 (order workflow; the S1 build's FIXED Shape "SHEET"): the order as ONE thing — each row's page, life, lines (C rows),
// own columns, waits and acts; drafts as rows when asked (`drafts=true`).
const sheetLine = output({
  id: id(),
  seq: z.number().int(),
  /** OWN (the customer's own label) · RANGE (the factory's collection) · NEW (a new design: a garment type) · TEXT (the customer's words). */
  model: output({ kind: z.enum(LINE_MODEL_KINDS), words: z.string().nullable(), garmentType: z.string().nullable() }),
  /** Settle 4: the line's "Material" choice, else the colourway's name. */
  material: z.string().nullable(),
  /** "50 × 2 · 52 × 3"; null: none (a by-person line: its people). */
  sizes: z.string().nullable(),
  pieces: z.number().int(),
  /** columnId → value (the columns ON the row only). */
  ownValues: z.record(z.string(), ownValue),
})
const sheetFacts = {
  /** The order page the row opens: a confirmed order, or a Draft or Sent order (its request). */
  page: output({ kind: z.enum(['order', 'request']), id: id() }),
  /** The base's nine words (orderLifeOf) and its note ("40 of 114", cancelled, refused, waits for the office's yes …). */
  life: z.enum(ORDER_LIFE),
  lifeNote: output({ kind: z.enum(LIFE_NOTE_KINDS), shipped: z.number().int().optional(), total: z.number().int().optional() }).nullable(),
  lines: z.array(sheetLine),
  ownColumnIds: z.array(id()),
  /** "Waits · news": only what waits; SEND_LABEL (owb- po2.6): a shipment arrived at the factory's warehouse waits for the customer's label. */
  waits: z.array(output({ kind: z.enum(SHEET_WAITS), count: z.number().int().nullable() })),
  may: output({ edit: z.boolean(), send: z.boolean(), delete: z.boolean(), takeBack: z.boolean(), picture: z.boolean() }),
}
// ---- end owb- po1.1

export const sheetContract = defineContract({
  // owb- po1.1: `drafts=true` adds the party's drafts on the first page of OPEN and ALL (an older web asks without it: no DRAFT kind).
  querystring: listContract.querystring.extend({ drafts: z.enum(['true', 'false']).default('false') }),
  response: {
    200: output({
      asOf: instant(),
      seesPrices: notMoney(z.boolean()),
      chip: z.enum(ORDER_CHIPS),
      chips: z.array(output({ chip: z.enum(ORDER_CHIPS), count: z.number().int(), words })),
      count: z.number().int(),
      // ---- pg-s1 S1.2 (portal grid Z3, H4): the band's numbers, counted by the server over the party's own rows BEFORE the search
      // (a search never moves them) — its orders, catalogue requests and requests; never another customer's.
      /** Each group of the band, in the groups' order (factory-domain ORDER_GROUPS). */
      groups: z.array(output({ group: z.enum(ORDER_GROUPS), count: z.number().int() })),
      /** Every open order and request (Requests … Shipped), each once. */
      open: z.number().int(),
      /** The requests we asked something about (NEED_INFO) and the OPEN orders waiting for their re-confirmation. */
      needsYou: z.number().int(),
      // ---- end pg-s1 S1.2
      /** The portal columns: every customer's fields shown in the portal and this customer's own. */
      columns: z.array(portalColumn),
      /** The list's rows (`number` null: the customer reads its own `yourNumber`, never an office series), each with its cells by column id. */
      // owb- po1.1: + kind DRAFT (status null: no customer status yet) and every row's facts.
      items: z.array(row.extend({ kind: z.enum(SHEET_ROW_KINDS), status: status.nullable(), values: z.record(z.string(), portalCell), ...sheetFacts })),
      /** owb- po1.1: the customer's own columns any row on the page uses, each once. */
      ownColumns: z.array(ownColumn),
      live,
    }),
  },
})

export const sheetDownloadContract = defineContract({
  querystring: input({
    chip: z.enum(ORDER_CHIPS).default('OPEN'),
    q: z.string().trim().max(80).optional(),
    format: z.enum(['XLSX', 'CSV']).default('XLSX'),
    /** Default: the person's language. */
    locale: z.enum(['it', 'en']).optional(),
  }),
  response: {},
})
// ---- end B-TH-061

// ---- owb- po2.2 (order workflow; design § 5m; the S1 Shape "MONEY"): the customer's Money tab — the price grain only (403 without) —
// and "I paid: tell the factory…" (a notice: nothing owed changes). Amounts in minor units, marked price.
const amount = money.price(z.number().int())
const notice = output({ id: id(), stepId: id().nullable(), amount, paidOn: day, state: z.enum(NOTICE_STATES) })
export const moneyContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      currency: z.string(),
      totals: output({ order: amount, invoiced: amount, paid: amount, stillToPay: amount }),
      /** How it adds up: lines, charges, VAT, credit notes (negative), paid (negative). */
      addsUp: z.array(output({ key: z.enum(ADDS_UP_KEYS), amount })),
      /** The payment plan: its milestones (else its deposit requests) and the rest (`id` 'REST': no deposit request, no milestone). */
      plan: z.array(output({ id: z.string(), kind: z.enum(PLAN_STEP_KINDS), percent: z.number().nullable(), amount, due: day.nullable(), state: z.enum(PLAN_STATES), paid: amount, noticeOpen: z.boolean() })),
      /** The order's invoices and their credit notes (the customer's own documents: their numbers shown). */
      invoices: z.array(output({ id: id(), kind: z.enum(MONEY_DOCUMENT_KINDS), number: z.string(), date: z.string(), amount, open: amount, documentId: id().nullable() })),
      notices: z.array(notice),
      may: output({ notify: z.boolean() }),
    }),
  },
})
export const paymentNoticeContract = defineContract({
  params: orderParams,
  body: input({
    /** A step of the plan (a milestone or a deposit request of this order); null: none (the rest). */
    stepId: id().nullable(),
    amount: money.price(z.number().int().min(1)),
    paidOn: day,
    method: z.string().trim().max(60).optional(),
    note: z.string().trim().max(1000).optional(),
    /** A receipt the customer sent (one of its own files). */
    fileId: id().optional(),
  }),
  response: { 200: notice },
})
// ---- end owb- po2.2

// ---- owb- po2.4 (order workflow): factory people for your brand — the office people of THIS customer's pool (never a worker, a team,
// a phone or an e-mail); a picture of letters (no photo yet).
export const factoryPeopleContract = defineContract({
  response: {
    200: output({
      people: z.array(output({ id: id(), name: z.string(), role: words, picture: output({ kind: z.enum(['LETTERS', 'ICON']), icon: z.string().nullable(), colour: z.string().nullable() }) })),
    }),
  },
})
// ---- end owb- po2.4

// ---- pg-s2 S2.1 (portal grid D4, Z12, H6): the small pictures of the customer's own orders (the list's picture column) -----------
/**
 * POST /portal/sales-orders/pictures {orderIds 1–200, each once}: the office's batch answer shape (product/images/small-pictures
 * smallPicturesView) for the customer's OWN orders only — an id that is not one of them is absent; never a file id (`fileId` null).
 */
export const picturesContract = defineContract({
  // owb- po1.1: + the party's Draft and Sent orders (`requestIds`); at least one id in all, at most 200 (the handler says it in words).
  body: input({ orderIds: z.array(id()).max(PICTURES_MAX).default([]), requestIds: z.array(id()).max(PICTURES_MAX).default([]) }),
  response: {
    200: output({
      pictures: z.array(
        output({
          /** One of the customer's own orders, or (owb- po1.1) one of its Draft or Sent orders (another customer's, or an unknown id, is absent). */
          id: id(),
          /** owb- po1.1: null only for a Draft or Sent order whose lines name no style (its chosen picture shows). */
          styleId: id().nullable(),
          styleCode: z.string().nullable(),
          styleName: z.string().nullable(),
          /** The order's distinct goods styles ("+2" beside the picture). */
          styleCount: z.number().int(),
          /** Always null: the portal never gets a file id it could open. */
          fileId: z.null(),
          contentType: z.string().nullable(),
          /** A presigned GET of the ~320 px preview (60 seconds); null until it exists, or without a picture. */
          small: output({ url: z.string(), expiresAt: instant() }).nullable(),
        }),
      ),
      asOf: instant(),
    }),
  },
})
// ---- end pg-s2 S2.1
