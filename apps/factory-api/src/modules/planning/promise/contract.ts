import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ATP_MAX_WEEKS } from '@nexus/factory-domain/planning/promise/atp'
import { MATERIAL_SOURCES, PROMISE_REASON_CODES, SIZE_STATES } from '@nexus/factory-domain/planning/promise/rules'
import { CERTIFICATE_STATES } from './certificates'

/**
 * Promise dates (B-W2b-301; PLN-168, PLN-169, PLN-171, PLN-179; design planning.promise › atp, the Promise calculator,
 * Sales › Quote "Suggest date" / "Check capacity"). Days are the site's calendar days; quantities are whole garments; no
 * money anywhere, no person but the office user who recorded a promise (inside one order line's history).
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const MAX_SIZES = 200
const sizeCode = z.string().trim().min(1).max(20)

const where = {
  site: output({ id: id(), companyId: id(), code: z.string(), name: z.string() }),
  today: businessDate(),
  asOf: instant(),
  /** The market the goods go to (the certificate and shipment rules read it); null: none named. */
  market: output({ code: z.string(), name: z.string() }).nullable(),
  destination: z.string().nullable(),
  /** The site's working plan read (a promise recorded from these dates names it). */
  planVersion: output({ id: id(), version: z.number().int() }).nullable(),
}

const certificate = output({
  state: z.enum(CERTIFICATE_STATES),
  words: z.string(),
  certificate: z.string().nullable(),
  validTo: businessDate().nullable(),
  requirementCode: z.string().nullable(),
  heldAtShipment: z.string().nullable(),
})

const arrival = output({
  itemId: id(),
  itemColourId: id().nullable(),
  label: z.string(),
  source: z.enum(MATERIAL_SOURCES),
  date: businessDate(),
  leadTimeDays: z.number().int().nullable(),
  purchaseOrderLineId: id().nullable(),
  words: z.string(),
})

const bridge = output({
  materialDays: z.number().int(),
  baseDays: z.number().int(),
  queueDays: z.number().int(),
  spanDays: z.number().int(),
  materialDate: businessDate(),
  finish: businessDate(),
})

const warning = output({ code: z.string(), words: z.string() })

export const sizeAnswer = output({
  size: z.string(),
  quantity: z.number().int(),
  fromStock: z.number().int(),
  toMake: z.number().int(),
  state: z.enum(SIZE_STATES),
  date: businessDate().nullable(),
  readyDate: businessDate().nullable(),
  meetsWanted: z.boolean().nullable(),
  daysLate: z.number().int().nullable(),
  material: output({ date: businessDate(), setBy: arrival.nullable(), arrivals: z.array(arrival) }).nullable(),
  bridge: bridge.nullable(),
  certificate: certificate.nullable(),
  words: z.string(),
})

export const askAnswer = output({
  key: z.string(),
  style: named,
  colourway: named,
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }).nullable(),
  madeToMeasure: z.boolean(),
  wantedDate: businessDate().nullable(),
  date: businessDate().nullable(),
  earliest: businessDate().nullable(),
  complete: z.boolean(),
  meetsWanted: z.boolean().nullable(),
  daysLate: z.number().int().nullable(),
  sizes: z.array(sizeAnswer),
  groups: z.array(output({ sizes: z.array(z.string()), date: businessDate().nullable(), words: z.string() })),
  groupsWords: z.string(),
  bridge: bridge.nullable(),
  bridgeWords: z.string().nullable(),
  steps: z.array(output({ seq: z.number().int(), name: z.string(), outside: z.boolean(), laneKey: z.string().nullable(), lane: output({ code: z.string(), name: z.string() }).nullable(), start: businessDate(), finish: businessDate() })),
  warnings: z.array(warning),
  words: z.string(),
})

// ---- available to promise ----------------------------------------------------------------------------------------------

const atpCell = output({
  key: z.string(),
  from: businessDate(),
  to: businessDate(),
  receipts: z.number().int(),
  committed: z.number().int(),
  cumulative: z.number().int(),
  available: z.number().int(),
  short: z.number().int(),
  lastReceipt: businessDate().nullable(),
})
const atpLine = {
  onHand: z.number().int(),
  availableNow: z.number().int(),
  later: output({ receipts: z.number().int(), committed: z.number().int() }),
  cells: z.array(atpCell),
}

export const atpContract = defineContract({
  querystring: input({ siteId: id(), styleId: id(), weeks: z.coerce.number().int().min(1).max(ATP_MAX_WEEKS).optional() }),
  response: {
    200: output({
      ...where,
      style: output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(z.string()) }),
      /** A SKU of it is set to make to stock at the site (PLN-061): the grid is for stock styles; others are shown as they are. */
      stockStyle: z.boolean(),
      weeks: z.array(output({ key: z.string(), from: businessDate(), to: businessDate() })),
      colourways: z.array(
        output({
          colourway: named,
          ...atpLine,
          sizes: z.array(
            output({
              size: z.string(),
              sku: z.string().nullable(),
              /** MAKE_TO_STOCK | MAKE_TO_ORDER | ASSEMBLE_TO_ORDER; null: make to order (no row). */
              strategy: z.string().nullable(),
              ...atpLine,
              sources: z.array(output({ kind: z.enum(['WORK_ORDER', 'PLANNED_ORDER', 'ORDER_LINE']), id: id(), number: z.string(), date: businessDate().nullable(), pieces: z.number().int() })),
            }),
          ),
        }),
      ),
      /** "This style has no stock or planned receipts" when nothing is on hand or coming. */
      empty: z.boolean(),
    }),
  },
})

export const atpStylesContract = defineContract({
  querystring: input({ siteId: id(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
  response: { 200: output({ siteId: id(), styles: z.array(output({ id: id(), code: z.string(), name: z.string(), makeToStock: z.boolean(), onHand: z.boolean() })) }) },
})

// ---- the calculator -----------------------------------------------------------------------------------------------------

export const calculateContract = defineContract({
  body: input({
    siteId: id(),
    styleId: id(),
    colourwayId: id(),
    revisionId: id().optional(),
    sizes: z.array(input({ size: sizeCode, quantity: z.number().int().min(1).max(100_000) })).min(1).max(MAX_SIZES),
    /** The day the customer wants it; the answer says whether it is met. */
    wantedDate: businessDate().optional(),
    /** Where the goods go (ISO country code): the certificate and shipment rules of that market. */
    country: z.string().trim().min(2).max(3).optional(),
    /** B-W2b-365: the options of the garment asked (active values of groups the style offers); a routing step only for some options counts when one of them is asked. */
    optionValueIds: z.array(id()).max(100).optional(),
  }),
  response: { 200: output({ ...where, answer: askAnswer }) },
})

// ---- a quote's suggested dates ------------------------------------------------------------------------------------------

export const quoteContract = defineContract({
  params: input({ quoteId: id() }),
  querystring: input({ revision: z.coerce.number().int().min(1).optional(), siteId: id().optional(), wantedDate: businessDate().optional() }),
  response: {
    200: output({
      ...where,
      quote: output({ id: id(), number: z.string(), revision: z.number().int(), status: z.string(), promiseDate: businessDate().nullable(), version: z.number().int() }),
      /** The suggested promise of the version (every line ready: ship complete); null: no line can be promised. */
      promiseDate: businessDate().nullable(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          answer: askAnswer,
          /** The line's delivery schedule the dates suggest: one delivery per day, its sizes (QuoteLineDelivery's shape). */
          deliveries: z.array(output({ deliveryDate: businessDate(), sizeQuantities: z.record(z.string(), z.number().int()).nullable(), quantity: z.number().int() })),
        }),
      ),
      /** Lines not asked (fees). */
      skipped: z.array(output({ lineId: id(), seq: z.number().int(), why: z.string() })),
      /** The version is a DRAFT and the caller keeps quotes: "Use on quote" (PATCH /sales/quotes/:quoteId { promiseDate }). */
      mayUse: z.boolean(),
      words: z.string(),
    }),
  },
})

// ---- an order line's promise per size ------------------------------------------------------------------------------------

const current = output({ date: businessDate(), source: z.enum(['RECORD', 'TYPED']), kind: z.enum(['FIRST', 'RE_PROMISE']).nullable(), recordId: id().nullable(), ownSize: z.boolean() })

const lineView = output({
  ...where,
  order: output({ id: id(), number: z.string(), status: z.string(), orderDate: businessDate(), promiseDate: businessDate().nullable(), originalPromiseDate: businessDate().nullable() }),
  line: output({ id: id(), seq: z.number().int(), kind: z.string(), style: named, colourway: named, promiseDate: businessDate().nullable(), requestedDate: businessDate().nullable() }),
  sizes: z.array(
    output({
      /** null: the line's one made-to-measure unit. */
      size: z.string().nullable(),
      ordered: z.number().int(),
      shipped: z.number().int(),
      open: z.number().int(),
      current: current.nullable(),
      /** The open work orders making it, with the board's planned finish. */
      workOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), pieces: z.number().int(), dueDate: businessDate().nullable(), plannedFinish: businessDate().nullable(), finish: businessDate().nullable() })),
      plannedOrders: z.array(output({ id: id(), pieces: z.number().int(), dueDate: businessDate() })),
      /** Open pieces nothing makes yet: the calculator's date for them. */
      uncovered: z.number().int(),
      /** The day the plan says the size's open pieces are ready; null: not promised (see `certificate`, `words`). */
      proposed: businessDate().nullable(),
      state: z.enum(SIZE_STATES),
      certificate: certificate.nullable(),
      /** The proposal differs from the current promise. */
      differs: z.boolean(),
      words: z.string(),
    }),
  ),
  groups: z.array(output({ sizes: z.array(z.string()), date: businessDate().nullable(), words: z.string() })),
  groupsWords: z.string(),
  history: z.array(
    output({
      id: id(),
      size: z.string().nullable(),
      promisedDate: businessDate(),
      kind: z.enum(['FIRST', 'RE_PROMISE']),
      reasonCode: z.string().nullable(),
      reason: z.string().nullable(),
      promisedAt: instant(),
      promisedBy: output({ id: id(), name: z.string() }).nullable(),
      customerToldAt: instant().nullable(),
    }),
  ),
  warnings: z.array(warning),
  may: output({ record: z.boolean() }),
})

export const orderLineContract = defineContract({
  params: input({ orderLineId: id() }),
  response: { 200: lineView },
})

export const recordContract = defineContract({
  params: input({ orderLineId: id() }),
  body: input({
    /** A date per size (size left out: every size, one date; a made-to-measure line's unit). */
    sizes: z.array(input({ size: sizeCode.nullable().optional(), date: businessDate() })).min(1).max(MAX_SIZES),
    /** Why a size is promised apart from the line (a re-promise): one of the list; SIZES_FINISH_APART when none is given. */
    reasonCode: z.enum(PROMISE_REASON_CODES).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  }),
  response: {
    200: output({
      written: z.array(output({ id: id(), size: z.string().nullable(), promisedDate: businessDate(), kind: z.enum(['FIRST', 'RE_PROMISE']), reasonCode: z.string().nullable(), backfill: z.boolean(), words: z.string() })),
      unchanged: z.array(z.string().nullable()),
      replayed: z.boolean(),
      view: lineView,
    }),
  },
})

