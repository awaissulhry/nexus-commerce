import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { CSV_ENCODINGS } from '@nexus/factory-domain/imports/job'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { ADDRESS_APPROVALS, REFUSE_REASON_LIMITS } from '@nexus/factory-domain/parties/address-approval'
import { ACCEPT_AS, DRAFT_LATER_PARTS, DRAFT_PART_STATES, DRAFT_PARTS } from '@nexus/factory-domain/sales/portal-ordering/office'
import { REORDER_NOTICES } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import { ORDERING_LIMITS, PROBLEM_CODES, RANGE_FILTERS, REQUEST_STATUSES, SOURCES } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { DRAFT_FILE_PARTS } from '@nexus/factory-domain/sales/portal-ordering/draft-files' // B-CP-072
// B-CP-075: the lines of the customer's own kinds, their people, the parts sent later.
import { MEASURE_BY, PEOPLE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/people'
import { CUSTOM_LINE_KINDS, CUSTOM_LINE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/rules'
// B-CP-077: the accept's line map.
import { ACCEPT_MAP_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/office'
import { MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'

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
/** B-TH-304 (pick A, plan §0.5): the customer's own number of an order ("Your order 12"); the portal draws it, never `number`. */
const yourNumber = output({ seq: z.number().int(), words }).nullable()
const requestParams = input({ requestId: id() })
const sizeAsk = input({ size: z.string().trim().min(1).max(ORDERING_LIMITS.size), quantity: z.number().int().min(1).max(ORDERING_LIMITS.quantity) })
const sizes = z.array(sizeAsk).min(1).max(ORDERING_LIMITS.sizesPerLine)
// B-CP-075: + the part of the checklist it holds and the person of a roster it is on ("send problems per part").
const problem = output({ code: z.enum(PROBLEM_CODES), part: z.enum(DRAFT_PARTS), lineId: id().nullable(), size: z.string().nullable(), personId: id().nullable(), words })
const notice = output({ code: z.enum(REORDER_NOTICES), words })
const sizeRow = output({ size: z.string(), quantity: z.number().int() })

// ---- B-CP-072 (customer page plan C5): a draft's files, as the customer reads them -------------------------------------------
const draftFile = output({ id: id(), lineId: id().nullable(), originalName: z.string(), kind: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), version, createdAt: at })
const draftFiles = output({ logos: z.array(draftFile), references: z.array(draftFile), sheets: z.array(draftFile) })
// ---- end B-CP-072

// ---- B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4): the described and made-to-measure lines and their people ------------
/** A person of a by-person line: a measurement sheet the customer reads by name; the office without sales.measurements.view: locked, nameless. */
const person = output({
  id: id(),
  seq: z.number().int(),
  version,
  name: z.string(),
  number: z.string().nullable(),
  measureBy: z.enum(MEASURE_BY),
  size: z.string().nullable(),
  sheet: output({ id: id(), originalName: z.string().nullable(), locked: z.boolean() }).nullable(),
  note: z.string().nullable(),
})
const customLine = output({
  id: id(),
  seq: z.number().int(),
  version,
  kind: z.enum(CUSTOM_LINE_KINDS),
  description: z.string().nullable(),
  colourText: z.string().nullable(),
  /** A described line's own private-label style, or the style a made-to-measure line is made from (null: none named). */
  style: named.nullable(),
  colourway: named.nullable(),
  /** MADE_TO_MEASURE: the garment type (a measurement template's code) and its name. */
  garmentType: output({ code: z.string(), words }).nullable(),
  /** DESCRIBED: the pieces in all (the split by size may follow after Send). */
  quantity: z.number().int().nullable(),
  sizes: z.array(sizeRow),
  byPerson: z.boolean(),
  pieces: z.number().int(),
  people: z.array(person),
  /** By person, no one typed, a measurement sheet on the line: "People: in the attached sheet". */
  peopleInSheet: z.boolean(),
  note: z.string().nullable(),
  problems: z.array(problem),
})
// ---- end B-CP-075

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
  kind: z.literal('CATALOGUE'), // B-CP-075: the other kinds are the request's customLines
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
  source: output({ orderLineId: id(), orderId: id(), orderNumber: z.string(), yourNumber, customerRef: z.string().nullable(), orderDate: day }).nullable(),
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
  /** "This is a request. We confirm price, quantities and date with you …" (B-TH-041: never by when). */
  notice: words,
  /**
   * B-CP-070 (D11): what the reader may do now beside filling the draft — send it and withdraw it once sent (who may order: the
   * Buyer, the Admin), discard the draft (who may order, or the colleague who started it). False: held, with the page's words.
   */
  may: output({ send: z.boolean(), withdraw: z.boolean(), discard: z.boolean() }),
  /** B-CP-072: its logos, references and measurement sheets (the draft's own and its lines'). */
  files: draftFiles,
  /** B-CP-072 (D14): files go up here now; else why not, in words (live, until the virus scanner runs: send them by e-mail). */
  uploads: output({ open: z.boolean(), words: z.string().nullable() }),
  // ---- B-CP-075: the lines in the customer's own words (described, made to measure; with `lines`, one draft by seq), the parts it
  // sends later, who of the customer saved it last (a display name, never an id or an e-mail), and made to measure for it.
  customLines: z.array(customLine),
  laterParts: z.array(z.enum(DRAFT_LATER_PARTS)),
  lastEditedBy: z.string().nullable(),
  lastEditedAt: at.nullable(),
  /** A draft's: whether it may hold made-to-measure lines, and the garment types it may choose (null once it is sent). */
  madeToMeasure: output({ open: z.boolean(), words: words.nullable(), garmentTypes: z.array(output({ code: z.string(), words })) }).nullable(),
  // ---- end B-CP-075
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
  /** B-W2b-F13b: our check of an address the customer added (null: one of the factory's own); refused with its reason. */
  approval: output({ status: z.enum(ADDRESS_APPROVALS), words, refuseReason: z.string().nullable() }).nullable(),
  version,
})

const record = output({ request: requestBody, addresses: z.array(address), seesPrices: notMoney(z.boolean()) })

const header = {
  customerRef: z.string().trim().max(ORDERING_LIMITS.customerRef).nullish(),
  shipToAddressId: id().nullish(),
  requestedDate: day.nullish(),
  note: z.string().trim().max(ORDERING_LIMITS.note).nullish(),
  /** B-CP-075: the parts the customer sends later (each once; [] clears them) — a DRAFT's. */
  laterParts: z.array(z.enum(DRAFT_LATER_PARTS)).max(DRAFT_LATER_PARTS.length).optional(),
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
  // B-TH-041 (Owner decision 3): confirmBy is always null (no answer-time promise); kept until the portal's words drop it (B-TH-220).
  response: { 200: record.extend({ sent: output({ number: z.string(), confirmBy: z.null(), words }) }) },
})
export const withdrawContract = defineContract({ params: requestParams, body: input({ version }), response: { 200: record } })

// ---- B-CP-075: described and made-to-measure lines (a line out: DELETE …/lines/:lineId), and the people of a by-person line -----
const customLineFields = {
  description: z.string().trim().max(CUSTOM_LINE_LIMITS.description).nullish(),
  colourText: z.string().trim().max(CUSTOM_LINE_LIMITS.colourText).nullish(),
  styleId: id().nullish(),
  colourwayId: id().nullish(),
  garmentType: z.string().trim().max(CUSTOM_LINE_LIMITS.garmentType).nullish(),
  quantity: z.number().int().min(1).max(CUSTOM_LINE_LIMITS.total).nullish(),
  byPerson: z.boolean().optional(),
  /** A described line's split by size ([] clears it). */
  sizes: z.array(sizeAsk).max(ORDERING_LIMITS.sizesPerLine).optional(),
  note: z.string().trim().max(ORDERING_LIMITS.lineNote).nullish(),
}
const personFields = {
  name: z.string().trim().min(1).max(PEOPLE_LIMITS.name),
  number: z.string().trim().max(PEOPLE_LIMITS.number).nullish(),
  measureBy: z.enum(MEASURE_BY),
  size: z.string().trim().max(PEOPLE_LIMITS.size).nullish(),
  /** SHEET: a measurement sheet of this draft (its own or one of its lines'). */
  measurementFileId: id().nullish(),
  note: z.string().trim().max(PEOPLE_LIMITS.note).nullish(),
}
const lineParams = input({ requestId: id(), lineId: id() })
const personParams = input({ requestId: id(), lineId: id(), personId: id() })
export const addCustomLineContract = defineContract({ params: requestParams, body: input({ version, line: input({ kind: z.enum(CUSTOM_LINE_KINDS), ...customLineFields }) }), response: { 200: record } })
export const changeCustomLineContract = defineContract({ params: lineParams, body: input({ version, ...customLineFields }), response: { 200: record } })
export const addPeopleContract = defineContract({ params: lineParams, body: input({ version, people: z.array(input(personFields)).min(1).max(PEOPLE_LIMITS.perLine) }), response: { 200: record } })
export const changePersonContract = defineContract({
  params: personParams,
  body: input({ version, name: personFields.name.optional(), number: personFields.number, measureBy: personFields.measureBy.optional(), size: personFields.size, measurementFileId: personFields.measurementFileId, note: personFields.note }),
  response: { 200: record },
})
export const removePersonContract = defineContract({ params: personParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: record } })
// ---- end B-CP-075

// ---- B-CP-072: a draft's files (announce, complete, remove) ------------------------------------------------------------------

const fileParams = input({ requestId: id(), fileId: id() })
export const announceDraftFileContract = defineContract({
  params: requestParams,
  body: input({
    /** LOGO (filed as ARTWORK), REFERENCE, SHEET (a measurement sheet, MEASUREMENTS). */
    part: z.enum(DRAFT_FILE_PARTS),
    /** On one line of the draft (null: the draft's own). */
    lineId: id().nullish(),
    originalName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(100),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  response: { 201: output({ file: draftFile, upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})
export const completeDraftFileContract = defineContract({ params: fileParams, response: { 200: output({ file: draftFile }) } })
export const removeDraftFileContract = defineContract({ params: fileParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: record } })
// ---- end B-CP-072

// ---- reorder -----------------------------------------------------------------------------------------------------------

export const pastOrdersContract = defineContract({
  querystring: input({ q: z.string().trim().max(80).optional() }),
  response: { 200: output({ orders: z.array(output({ id: id(), number: z.string(), yourNumber, customerRef: z.string().nullable(), orderDate: day.nullable(), lines: z.number().int(), pieces: z.number().int() })) }) },
})

export const pastOrderContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), yourNumber, customerRef: z.string().nullable(), orderDate: day.nullable() }),
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
  /** B-W2b-F13b: when it was asked for and when we decided (null: never checked, or not yet). */
  requestedAt: at.nullable(),
  decidedAt: at.nullable(),
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

// ---- B-CP-071 (customer page plan D10, K9 reversed): a draft as the office reads it (read-only; null once it is sent) ----------
const officeDraftFile = output({ id: id(), lineId: id().nullable(), originalName: z.string().nullable(), kind: z.string(), sizeBytes: z.number().int(), status: z.string(), locked: z.boolean() }) // B-CP-072
const officeDraft = output({
  startedBy: z.string().nullable(),
  startedAt: at,
  /** The customer's colleague who changed it last, and when. */
  lastEditedBy: z.string().nullable(),
  lastEditedAt: at,
  /** The first line's style; null: "Untitled draft" (the page's words). */
  title: z.string().nullable(),
  /** The people of its roster (B-CP-075). */
  people: z.number().int(),
  /**
   * The checklist (12 §2): each part's state, READY parts of the parts counted, the problems that hold the send. Part 6 "Your
   * price" is counted only for a reader with the price grain (review B4): `of` is 7 for them, 6 for anyone else.
   */
  readiness: output({ parts: z.array(output({ part: z.enum(DRAFT_PARTS), state: z.enum(DRAFT_PART_STATES) })), done: z.number().int(), of: z.number().int(), problems: z.number().int() }),
  /** The parts the customer marked "we send it later" (B-CP-075). */
  later: z.array(z.enum(DRAFT_LATER_PARTS)),
  /** Its conversation, for a reader of its thread (null: not one): messages, the newest, whether the factory designer was asked. */
  thread: output({ messages: z.number().int(), lastAt: at.nullable(), designerAsked: z.boolean() }).nullable(),
  problems: z.array(problem),
  /** B-CP-072: its files by part; a measurement sheet without sales.measurements.view is `locked` and nameless. */
  files: output({ logos: z.array(officeDraftFile), references: z.array(officeDraftFile), sheets: z.array(officeDraftFile) }),
})
// ---- end B-CP-071

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
    /** B-W2b-F13b: `approvalStatus` WAITING — the customer added it in the portal; accepting the request approves it. */
    shipTo: output({ id: id(), name: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string(), status: z.string(), approvalStatus: z.enum(ADDRESS_APPROVALS).nullable() }).nullable(),
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
    /** B-CP-071: a draft's facts (accept and refuse are held while it is one: `may` all false). */
    draft: officeDraft.nullable(),
    /** B-CP-075: the described and made-to-measure lines with their people (a measurement sheet locked without sales.measurements.view); the accept maps them (B-CP-077). */
    customLines: z.array(customLine),
    /**
     * B-CP-077: what the accept needs — the described and made-to-measure lines to map to style lines (ids, in the request's
     * order; none: nothing to map), and why it is not accepted as an order (a made-to-measure line: a quote first; null: it may be).
     */
    acceptMap: output({ lineIds: z.array(id()), orderHeld: z.string().nullable() }),
  }),
  may: output({ order: z.boolean(), quote: z.boolean(), refuse: z.boolean() }),
})

export const officeListContract = defineContract({
  // B-CP-071: DRAFT lists one customer's drafts (partyId required; never in OPEN or ALL).
  querystring: input({ status: z.enum(['OPEN', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN', 'ALL', 'DRAFT']).default('OPEN'), partyId: id().optional(), q: z.string().trim().max(80).optional() }),
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
          /** B-CP-071: a draft's facts (null for a sent request). */
          draft: officeDraft.nullable(),
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
    /** ORDER: a unit price typed per catalogue line of the request (else the customer's list price today). */
    lines: z.array(input({ lineId: id(), unitPrice: money.price(z.string().regex(/^\d{1,12}(\.\d{1,6})?$/)) })).max(ORDERING_LIMITS.lines).optional(),
    /**
     * B-CP-077: each described or made-to-measure line of the request and the style line(s) it is made into — a style and colourway
     * the company sells (never another customer's own label), its sizes (else the request line's own: its size rows, or its people's
     * sizes when each has one), for an ORDER maybe a typed unit price (else the list price), a description and a note (else where it
     * came from: the request, the line, the customer's words, how many people). A made-to-measure line is accepted as a QUOTE only.
     */
    map: z
      .array(
        input({
          lineId: id(),
          into: z
            .array(
              input({
                styleId: id(),
                colourwayId: id(),
                sizes: sizes.optional(),
                unitPrice: money.price(z.string().regex(/^\d{1,12}(\.\d{1,6})?$/)),
                description: z.string().trim().max(MAX_TEXT.description).nullish(),
                note: z.string().trim().max(ACCEPT_MAP_LIMITS.note).nullish(),
              }),
            )
            .min(1)
            .max(ACCEPT_MAP_LIMITS.into),
        }),
      )
      .max(ORDERING_LIMITS.lines)
      .optional(),
  }),
  response: {
    200: officeRecord.extend({
      made: output({
        as: z.enum(ACCEPT_AS),
        salesOrderId: id().nullable(),
        quoteId: id().nullable(),
        number: z.string(),
        dropped: z.array(output({ seq: z.number().int(), size: z.string().nullable(), reason: z.string() })),
        warnings: z.array(z.string()),
        /** B-CP-077: the accept's ONE map — each request line (by id, and its place) and the order or quote lines made from it. */
        lines: z.array(output({ requestLineId: id(), requestSeq: z.number().int(), into: z.array(output({ lineId: id(), seq: z.number().int() })) })),
        /** B-CP-077: the customer's logos carried onto the lines made (on a line) or the order or quote itself (on the draft); and those not. */
        artwork: output({
          carried: z.array(output({ sourceFileId: id(), fileId: id(), name: z.string(), recordType: z.string(), recordId: id() })),
          notCarried: z.array(output({ sourceFileId: id(), name: z.string(), reason: z.string() })),
        }),
      }),
    }),
  },
})
export const refuseContract = defineContract({ params: requestParams, body: input({ version, reason: z.string().trim().min(1).max(ORDERING_LIMITS.reason) }), response: { 200: officeRecord } })

// ---- the office's check of the delivery addresses customers add (B-W2b-F13b, wave 23) ----------------------------------

const addressCheck = output({
  id: id(),
  party: named,
  kinds: z.array(z.string()),
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
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  approval: output({
    status: z.enum(ADDRESS_APPROVALS),
    requestedAt: at.nullable(),
    /** The customer's person who added it. */
    requestedBy: z.string().nullable(),
    decidedAt: at.nullable(),
    decidedBy: z.string().nullable(),
    refuseReason: z.string().nullable(),
  }),
  version,
  may: output({ decide: z.boolean() }),
})
const addressCheckParams = input({ addressId: id() })

export const addressChecksContract = defineContract({
  querystring: input({ state: z.enum(['WAITING', 'APPROVED', 'REFUSED', 'ALL']).default('WAITING'), partyId: id().optional() }),
  response: { 200: output({ addresses: z.array(addressCheck) }) },
})
export const approveAddressContract = defineContract({ params: addressCheckParams, body: input({ version }), response: { 200: output({ address: addressCheck }) } })
export const refuseAddressContract = defineContract({
  params: addressCheckParams,
  body: input({ version, reason: z.string().trim().min(1).max(REFUSE_REASON_LIMITS.max) }),
  response: { 200: output({ address: addressCheck }) },
})
