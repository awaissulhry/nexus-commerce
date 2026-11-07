import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { CSV_ENCODINGS } from '@nexus/factory-domain/imports/job'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { ACCEPT_AS } from '@nexus/factory-domain/sales/portal-ordering/office'
import { REORDER_NOTICES } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import { ORDERING_LIMITS, PROBLEM_CODES, RANGE_FILTERS, REQUEST_STATUSES, SOURCES } from '@nexus/factory-domain/sales/portal-ordering/rules'

/**
 * Portal ordering (B-W2b-190; SAL-071, SAL-072, SAL-073, SAL-074, SAL-079; design portal.customer.catalogue,
 * portal.customer.neworder, portal.customer.account › Delivery addresses) and the office's decision (home.approvals).
 * Every status, problem and difference comes with its words in Italian and English (`words`). Money is marked price:
 * the API drops it for a role without the price grain (customer Quality, Designer, Viewer; an office preview; an office
 * role without prices), and `seesPrices` tells the page to say "Prices are not part of your access" once. No cost, no
 * margin.
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const at = instant()
const version = z.number().int().min(1)
const named = output({ id: id(), code: z.string(), name: z.string() })
const numbered = output({ id: id(), number: z.string() })
const requestParams = input({ requestId: id() })
const sizeAsk = input({ size: z.string().trim().min(1).max(ORDERING_LIMITS.size), quantity: z.number().int().min(1).max(ORDERING_LIMITS.quantity) })
const sizes = z.array(sizeAsk).min(1).max(ORDERING_LIMITS.sizesPerLine)
const problem = output({ code: z.enum(PROBLEM_CODES), lineId: id().nullable(), size: z.string().nullable(), words })
const notice = output({ code: z.enum(REORDER_NOTICES), words })
const sizeRow = output({ size: z.string(), quantity: z.number().int() })

// ---- the catalogue -----------------------------------------------------------------------------------------------------

const card = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: output({ it: z.string().optional(), en: z.string().optional() }).nullable(),
  productType: z.string(),
  season: z.string().nullable(),
  /** The customer's own label (else the open range). */
  ownLabel: z.boolean(),
  colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  sizes: z.array(z.string()),
  /** "48–56". */
  range: z.string(),
  ppe: output({ category: z.string(), standard: z.string().nullable(), class: z.string().nullable(), words }),
  /** The lowest of its colours' prices ("from 189.00"). */
  priceFrom: money.price(z.string().nullable()),
})
const facet = z.array(output({ value: z.string(), count: z.number().int() }))

export const catalogueContract = defineContract({
  querystring: input({
    /** A style's code or name. */
    q: z.string().trim().max(80).optional(),
    category: z.string().trim().max(40).optional(),
    season: z.string().trim().max(40).optional(),
    ppe: z.string().trim().max(20).optional(),
    range: z.enum(RANGE_FILTERS).default('ALL'),
  }),
  response: {
    200: output({
      styles: z.array(card),
      count: z.number().int(),
      total: notMoney(z.number().int()),
      facets: output({ categories: facet, seasons: facet, ppe: facet, ownLabel: z.number().int(), openRange: z.number().int() }),
      currency: z.string(),
      asOf: at,
      seesPrices: notMoney(z.boolean()),
    }),
  },
})

export const catalogueStyleContract = defineContract({
  params: input({ styleId: id() }),
  response: {
    200: output({
      style: card.extend({
        description: z.string().nullable(),
        baseSize: z.string().nullable(),
        /** The released revision it is made to now. */
        revision: z.number().int().nullable(),
        colourways: z.array(output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(output({ size: z.string(), offered: z.boolean() })), price: money.price(z.string().nullable()) })),
      }),
      currency: z.string(),
      asOf: at,
      seesPrices: notMoney(z.boolean()),
    }),
  },
})

// ---- order requests (the customer's) -----------------------------------------------------------------------------------

const line = output({
  id: id(),
  seq: z.number().int(),
  version,
  style: named,
  colourway: named,
  sizes: z.array(output({ size: z.string(), quantity: z.number().int(), offered: z.boolean() })),
  /** The sizes the colourway offers today, in range order (the grid's columns). */
  offered: z.array(z.string()),
  /** The style's colours the customer may choose (for a discontinued one). */
  colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  pieces: z.number().int(),
  /** The price the customer was shown when the line was added (or last accepted). */
  unitPriceShown: money.price(z.string().nullable()),
  /** The customer's price today. */
  priceNow: money.price(z.string().nullable()),
  amount: money.price(z.string().nullable()),
  note: z.string().nullable(),
  /** A reorder line: the order line it came from. */
  source: output({ orderLineId: id(), orderId: id(), orderNumber: z.string(), customerRef: z.string().nullable(), orderDate: day }).nullable(),
  notices: z.array(notice),
  problems: z.array(problem),
})

const requestBody = output({
  id: id(),
  number: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  words,
  source: z.enum(SOURCES),
  customerRef: z.string().nullable(),
  shipToAddressId: id().nullable(),
  requestedDate: day.nullable(),
  note: z.string().nullable(),
  currency: z.string(),
  createdAt: at,
  updatedAt: at,
  sentAt: at.nullable(),
  decidedAt: at.nullable(),
  refuseReason: z.string().nullable(),
  withdrawnAt: at.nullable(),
  salesOrder: numbered.nullable(),
  quote: numbered.nullable(),
  version,
  lines: z.array(line),
  summary: output({ lines: z.number().int(), pieces: z.number().int(), net: money.price(z.string().nullable()) }),
  /** What holds the send (a draft's; none once sent). */
  problems: z.array(problem),
  /** "2 problems to fix" (null: nothing holds it). */
  held: words.nullable(),
  /** Lines whose price changed since it was shown ("Prices changed since you started — Review"). */
  pricesChanged: notMoney(z.number().int()),
  /** "This is a request. We confirm price, quantities and date within 1 working day …" */
  notice: words,
})

const address = output({
  id: id(),
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  deliveryNotes: z.string().nullable(),
  isDefault: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version,
})

const record = output({ request: requestBody, addresses: z.array(address), seesPrices: notMoney(z.boolean()) })

const header = {
  customerRef: z.string().trim().max(ORDERING_LIMITS.customerRef).nullish(),
  shipToAddressId: id().nullish(),
  requestedDate: day.nullish(),
  note: z.string().trim().max(ORDERING_LIMITS.note).nullish(),
}

const newLine = input({ styleId: id(), colourwayId: id(), sizes, note: z.string().trim().max(ORDERING_LIMITS.lineNote).nullish() })

export const listRequestsContract = defineContract({
  querystring: input({ status: z.enum([...REQUEST_STATUSES, 'ALL']).default('ALL') }),
  response: {
    200: output({
      requests: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          status: z.enum(REQUEST_STATUSES),
          words,
          source: z.enum(SOURCES),
          customerRef: z.string().nullable(),
          requestedDate: day.nullable(),
          lines: z.number().int(),
          pieces: z.number().int(),
          net: money.price(z.string().nullable()),
          currency: z.string(),
          createdAt: at,
          updatedAt: at,
          sentAt: at.nullable(),
          decidedAt: at.nullable(),
          salesOrder: numbered.nullable(),
          quote: numbered.nullable(),
          version,
        }),
      ),
      seesPrices: notMoney(z.boolean()),
    }),
  },
})

export const createRequestContract = defineContract({ body: input({ source: z.enum(SOURCES).optional(), ...header }), response: { 201: record } })
export const getRequestContract = defineContract({ params: requestParams, response: { 200: record } })
export const changeRequestContract = defineContract({ params: requestParams, body: input({ version, ...header }), response: { 200: record } })
export const addLinesContract = defineContract({ params: requestParams, body: input({ version, lines: z.array(newLine).min(1).max(ORDERING_LIMITS.lines) }), response: { 200: record } })
export const changeLineContract = defineContract({
  params: input({ requestId: id(), lineId: id() }),
  body: input({ version, colourwayId: id().optional(), sizes: sizes.optional(), note: z.string().trim().max(ORDERING_LIMITS.lineNote).nullish() }),
  response: { 200: record },
})
export const removeLineContract = defineContract({ params: input({ requestId: id(), lineId: id() }), querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: record } })
export const pricesContract = defineContract({ params: requestParams, body: input({ version }), response: { 200: record } })
export const discardContract = defineContract({ params: requestParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ discarded: z.literal(true) }) } })
export const sendContract = defineContract({
  params: requestParams,
  body: input({ version }),
  response: { 200: record.extend({ sent: output({ number: z.string(), confirmBy: day.nullable(), words }) }) },
})
export const withdrawContract = defineContract({ params: requestParams, body: input({ version }), response: { 200: record } })

// ---- reorder -----------------------------------------------------------------------------------------------------------

export const pastOrdersContract = defineContract({
  querystring: input({ q: z.string().trim().max(80).optional() }),
  response: { 200: output({ orders: z.array(output({ id: id(), number: z.string(), customerRef: z.string().nullable(), orderDate: day.nullable(), lines: z.number().int(), pieces: z.number().int() })) }) },
})

export const pastOrderContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), customerRef: z.string().nullable(), orderDate: day.nullable() }),
      lines: z.array(
        output({
          orderLineId: id(),
          seq: z.number().int(),
          style: named,
          colourway: named,
          sizesOrdered: z.array(sizeRow),
          /** What would go into the draft today. */
          sizes: z.array(sizeRow),
          pieces: z.number().int(),
          unitPriceThen: money.price(z.string().nullable()),
          priceNow: money.price(z.string().nullable()),
          addable: z.boolean(),
          needsColour: z.boolean(),
          colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
          notices: z.array(notice),
        }),
      ),
      seesPrices: notMoney(z.boolean()),
    }),
  },
})

export const reorderContract = defineContract({
  params: requestParams,
  body: input({ version, orderId: id(), lines: z.array(input({ orderLineId: id(), colourwayId: id().optional() })).min(1).max(ORDERING_LIMITS.lines).optional() }),
  response: {
    200: record.extend({
      /** New lines. */
      added: z.number().int(),
      /** Sizes added to a line the draft already had for the style and colour. */
      merged: z.array(output({ lineId: id(), size: z.string() })),
      /** Sizes the draft's line already had: its quantity was kept. */
      kept: z.array(output({ lineId: id(), size: z.string() })),
      skipped: z.array(output({ orderLineId: id(), seq: z.number().int(), notices: z.array(notice) })),
    }),
  },
})

// ---- upload ------------------------------------------------------------------------------------------------------------

export const templateContract = defineContract({ querystring: input({ format: z.enum(['csv', 'xlsx']).default('xlsx'), numberFormat: z.enum(NUMBER_FORMATS).optional() }), response: {} })

export const uploadContract = defineContract({
  params: requestParams,
  body: input({
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(200),
    /** The file's bytes, base64 (at most about 700 KB of sheet). */
    content: z.string().min(1).max(1_000_000),
    numberFormat: z.enum(NUMBER_FORMATS).optional(),
    sheetName: z.string().trim().max(100).nullish(),
    encoding: z.enum(CSV_ENCODINGS).nullish(),
    /** false: the dry run (nothing written); true: add the ready rows to the draft (with its version). */
    apply: z.boolean().optional(),
    version: version.optional(),
    /** The refused rows' CSV in this language. */
    locale: z.enum(['it', 'en']).optional(),
  }),
  response: {
    200: output({
      dryRun: output({
        rows: z.number().int(),
        ready: z.number().int(),
        refused: z.number().int(),
        verdicts: z.array(
          output({
            rowNumber: z.number().int(),
            status: z.enum(['READY', 'REFUSED']),
            style: z.string().nullable(),
            colour: z.string().nullable(),
            size: z.string().nullable(),
            quantity: z.number().int().nullable(),
            yourCode: z.string().nullable(),
            styleId: id().nullable(),
            colourwayId: id().nullable(),
            reasons: z.array(words),
          }),
        ),
        lines: z.array(output({ styleId: id(), styleCode: z.string(), colourwayId: id(), colourwayCode: z.string(), sizes: z.array(sizeRow), note: z.string().nullable() })),
        /** The refused rows to fix (Row; Style; Colour; Size; Quantity; Your code; Reason), null when none. */
        refusedCsv: z.string().nullable(),
        columns: z.array(output({ header: z.string(), column: z.string() })),
        ignored: z.array(z.string()),
      }),
      applied: z.boolean(),
      added: z.number().int().optional(),
      merged: z.array(output({ lineId: id(), size: z.string() })).optional(),
      kept: z.array(output({ lineId: id(), size: z.string() })).optional(),
      record: record.nullable(),
    }),
  },
})

// ---- delivery addresses ------------------------------------------------------------------------------------------------

const portalAddress = address.extend({
  createdAt: at,
  addedBy: output({ kind: z.enum(['COLLEAGUE', 'FACTORY']), name: z.string().nullable(), you: z.boolean() }),
})
const addressList = output({ addresses: z.array(portalAddress), canManage: z.boolean() })

export const addressesContract = defineContract({ response: { 200: addressList } })
export const addAddressContract = defineContract({
  body: input({
    name: z.string().trim().max(200).nullish(),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullish(),
    postalCode: z.string().trim().min(1).max(20),
    city: z.string().trim().min(1).max(100),
    province: z.string().trim().max(50).nullish(),
    country: z.string().trim().length(2),
    contactName: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(50).nullish(),
    deliveryNotes: z.string().trim().max(1000).nullish(),
    isDefault: z.boolean().optional(),
  }),
  response: { 201: output({ address: portalAddress }) },
})
export const addressMoveContract = defineContract({ params: input({ addressId: id() }), body: input({ version }), response: { 200: addressList } })

// ---- the office --------------------------------------------------------------------------------------------------------

const officeLine = output({
  id: id(),
  seq: z.number().int(),
  style: named,
  colourway: named,
  sizes: z.array(sizeRow),
  pieces: z.number().int(),
  unitPriceShown: money.price(z.string().nullable()),
  listPriceNow: money.price(z.string().nullable()),
  amountShown: money.price(z.string().nullable()),
  note: z.string().nullable(),
  sourceOrderLineId: id().nullable(),
  problems: z.array(output({ code: z.enum(PROBLEM_CODES), size: z.string().nullable(), words })),
})

const officeRecord = output({
  request: output({
    id: id(),
    number: z.string().nullable(),
    status: z.enum(REQUEST_STATUSES),
    words,
    source: z.enum(SOURCES),
    party: named,
    customerRef: z.string().nullable(),
    requestedDate: day.nullable(),
    note: z.string().nullable(),
    currency: z.string(),
    shipTo: output({ id: id(), name: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string(), status: z.string() }).nullable(),
    sentAt: at.nullable(),
    sentBy: z.string().nullable(),
    decidedAt: at.nullable(),
    decidedBy: z.string().nullable(),
    refuseReason: z.string().nullable(),
    withdrawnAt: at.nullable(),
    salesOrder: numbered.nullable(),
    quote: numbered.nullable(),
    version,
    lines: z.array(officeLine),
    summary: output({ lines: z.number().int(), pieces: z.number().int(), netShown: money.price(z.string().nullable()) }),
  }),
  may: output({ order: z.boolean(), quote: z.boolean(), refuse: z.boolean() }),
})

export const officeListContract = defineContract({
  querystring: input({ status: z.enum(['OPEN', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN', 'ALL']).default('OPEN'), partyId: id().optional(), q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      requests: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          status: z.enum(REQUEST_STATUSES),
          source: z.enum(SOURCES),
          party: named,
          customerRef: z.string().nullable(),
          requestedDate: day.nullable(),
          sentAt: at.nullable(),
          sentBy: z.string().nullable(),
          decidedAt: at.nullable(),
          lines: z.number().int(),
          pieces: z.number().int(),
          netShown: money.price(z.string().nullable()),
          currency: z.string(),
          salesOrderId: id().nullable(),
          quoteId: id().nullable(),
          version,
        }),
      ),
    }),
  },
})

export const officeGetContract = defineContract({ params: requestParams, response: { 200: officeRecord } })
export const acceptContract = defineContract({
  params: requestParams,
  body: input({
    version,
    as: z.enum(ACCEPT_AS),
    promiseDate: day.nullish(),
    /** ORDER: a unit price typed per request line (else the customer's list price today). */
    lines: z.array(input({ lineId: id(), unitPrice: money.price(z.string().regex(/^\d{1,12}(\.\d{1,6})?$/)) })).max(ORDERING_LIMITS.lines).optional(),
  }),
  response: {
    200: officeRecord.extend({
      made: output({ as: z.enum(ACCEPT_AS), salesOrderId: id().nullable(), quoteId: id().nullable(), number: z.string(), dropped: z.array(output({ seq: z.number().int(), size: z.string().nullable(), reason: z.string() })), warnings: z.array(z.string()) }),
    }),
  },
})
export const refuseContract = defineContract({ params: requestParams, body: input({ version, reason: z.string().trim().min(1).max(ORDERING_LIMITS.reason) }), response: { 200: officeRecord } })
