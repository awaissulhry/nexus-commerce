import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { SALES_LINE_KINDS, STORED_DEPOSIT_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { PROGRESS_STAGES } from '@nexus/factory-domain/sales/portal-orders/progress'
import { PROMISE_REASON_CODES } from '@nexus/factory-domain/sales/portal-orders/promise'
import { CUSTOMER_SHIPMENT_STATUSES, SHIPMENT_MILESTONES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { CUSTOMER_ORDER_STATUSES, MILESTONE_STATES, MILESTONES, ORDER_CHIPS } from '@nexus/factory-domain/sales/portal-orders/status'
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'

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

const nextShipment = output({
  id: id(),
  number: z.string(),
  status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
  words,
  date: day.nullable(),
  carrierName: z.string().nullable(),
  /** B-W2b-F14: when the carrier expects to deliver it (while packed or on the way); null: not said. */
  expectedDeliveryAt: instant().nullable(),
})

const row = output({
  /** ORDER, or REQUEST: a portal order request sent and not decided yet (its number is the request's). */
  kind: z.enum(['ORDER', 'REQUEST']),
  id: id(),
  /** Their purchase order number (first in the row). */
  customerRef: z.string().nullable(),
  number: z.string().nullable(),
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
})

export const listContract = defineContract({
  querystring: input({
    chip: z.enum(ORDER_CHIPS).default('OPEN'),
    /** Their PO number, our order number, or a style's code or name. */
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
      progressShared: z.boolean(),
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
        number: z.string(),
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
      }),
      milestones: z.array(milestone),
      promiseHistory: z.array(
        output({ on: day, from: day.nullable(), to: day, lines: z.array(z.number().int()), reason: output({ code: z.enum(PROMISE_REASON_CODES), words }) }),
      ),
      deposits: z.array(output({ id: id(), kind: z.enum(STORED_DEPOSIT_KINDS), status: z.string(), amount: money.price(z.number().int()), currency: z.string(), dueDate: day, paidAt: instant().nullable() })),
      lines: z.array(line),
      pieces: pieces.extend({ closedShort: z.number().int() }),
      /** The customer sees production progress (C1): GET …/progress answers. */
      progressShared: z.boolean(),
      shipments: output({ shown: z.number().int(), onTheWay: z.number().int() }),
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
  number: z.string(),
  status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
  words,
  transportBy: z.string(),
  carrierName: z.string().nullable(),
  packedAt: instant().nullable(),
  shippedAt: instant().nullable(),
  deliveredAt: instant().nullable(),
  /** B-W2b-F14: when the carrier expects to deliver it (while packed or on the way; none once delivered or returned). */
  expectedDeliveryAt: instant().nullable(),
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
  papers: z.array(output({ fileId: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), versionNo: z.number().int() })),
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

export const inTransitContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      items: z.array(
        output({
          shipmentId: id(),
          number: z.string(),
          order: output({ id: id(), number: z.string(), customerRef: z.string().nullable() }),
          status: z.enum(CUSTOMER_SHIPMENT_STATUSES),
          words,
          carrierName: z.string().nullable(),
          shippedAt: instant().nullable(),
          /** B-W2b-F14: when the carrier expects to deliver it; null: not said. */
          expectedDeliveryAt: instant().nullable(),
          trackingNumbers: z.array(z.string()),
          /** B-W2b-F14: "Track on the carrier's site" per tracking number (https pages only). */
          trackingLinks: z.array(output({ trackingNumber: z.string(), url: z.string(), words })),
          lastEvent: trackingEvent.nullable(),
        }),
      ),
      live,
    }),
  },
})
