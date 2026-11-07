import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_ANSWER, MAX_NOTE, REQUEST_KINDS, REQUEST_STATUSES, VERDICT_CODES, CUTOFF_STATUSES, MAX_CUTOFF_DAYS } from '@nexus/factory-domain/sales/change-requests/rules'
import { MAX_REASON, SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { MAX_SIZE_QUANTITY, SALES_LINE_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { diffView, impactView } from '../orders/daily-contract'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077, SAL-078; design portal.customer.orders "Ask for a
 * change", "Ask to cancel"; the office's Home › Approvals and the order's Changes tab). Every verdict and state carries its
 * words in Italian and English (`words`). The customer's answers hold no price, no cost and no office person (never who
 * answered); the office's preview of the amendment carries money only with the price grain (W2a's diff).
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const named = output({ code: z.string(), name: z.string() })
const issue = output({ path: z.string(), message: z.string() })
const live = output({ events: z.array(z.string()) })
const version = z.number().int().min(1)
const verdict = output({ possible: z.boolean(), code: z.enum(VERDICT_CODES), day: day.nullable(), words })
const address = output({ id: id(), label: z.string() })

const cell = output({
  lineId: id(),
  seq: z.number().int(),
  style: named.nullable(),
  colourway: named.nullable(),
  /** null: the line as a whole (a line cancelled). */
  size: z.string().nullable(),
  /** The pieces when it was asked, and the pieces asked (0: none). */
  before: z.number().int(),
  asked: z.number().int(),
})

const requestFields = {
  id: id(),
  orderId: id(),
  orderNumber: z.string(),
  /** Their purchase order number. */
  customerRef: z.string().nullable(),
  kind: z.enum(REQUEST_KINDS),
  kindWords: words,
  status: z.enum(REQUEST_STATUSES),
  words,
  askedAt: instant(),
  cells: z.array(cell),
  /** A cancel of the whole order (no lines named). */
  wholeOrder: z.boolean(),
  requestedDate: day.nullable(),
  shipTo: address.nullable(),
  reasonCode: z.string().nullable(),
  reasonWords: words.nullable(),
  note: z.string().nullable(),
  /** The office's words (never who answered). */
  answer: z.string().nullable(),
  answeredAt: instant().nullable(),
  withdrawnAt: instant().nullable(),
  version: z.number().int(),
}

/** The customer's view of a request: `mine` when the person asked it. */
const partnerRequest = output({ ...requestFields, mine: z.boolean() })

const orderParams = input({ orderId: id() })
const requestParams = input({ orderId: id(), requestId: id() })

// ---- the portal --------------------------------------------------------------------------------------------------------------

export const rulesContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      asOf: instant(),
      order: output({ id: id(), number: z.string(), customerRef: z.string().nullable(), status: z.enum(SALES_ORDER_STATUSES), requestedDate: day.nullable(), promiseDate: day.nullable(), version: z.number().int() }),
      /** May a change be asked at all; may the whole order be asked to be cancelled. */
      change: verdict,
      cancel: verdict,
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          kind: z.enum(SALES_LINE_KINDS),
          style: named.nullable(),
          colourway: named.nullable(),
          /** The style's sizes in its range's order: the pieces ordered and whether the size may be asked (its SKU active). */
          sizes: z.array(output({ size: z.string(), quantity: z.number().int(), offered: z.boolean() })),
          change: verdict,
          cancel: verdict,
        }),
      ),
      /** The cancel reasons (the CANCEL reason list), and whether one asks for their words. */
      reasons: z.array(output({ code: z.string(), words, needsNote: z.boolean() })),
      /** Their delivery addresses in use (for "Ship-to"). */
      addresses: z.array(address),
      /** SAL-304: a made-to-measure order for a consumer: no right of withdrawal applies (said in the cancel pop-up). */
      noWithdrawal: words.nullable(),
      /** The request that waits (one per order). */
      openRequestId: id().nullable(),
      live,
    }),
  },
})

export const askContract = defineContract({
  params: orderParams,
  body: input({
    kind: z.enum(REQUEST_KINDS),
    /** A change: the pieces wanted per size (0 drops the size). */
    cells: z.array(input({ lineId: id(), size: z.string().trim().min(1).max(40), quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY) })).max(500).optional(),
    /** A change: "We would like it by". */
    requestedDate: day.nullable().optional(),
    /** A change: one of their delivery addresses. */
    shipToAddressId: id().nullable().optional(),
    /** A cancel: the lines (none: the whole order). */
    lineIds: z.array(id()).max(200).optional(),
    /** A cancel: a code of the reasons offered. */
    reasonCode: z.string().trim().min(1).max(40).optional(),
    note: z.string().max(MAX_NOTE).nullable().optional(),
  }),
  response: { 201: output({ request: partnerRequest }) },
})

export const partnerListContract = defineContract({
  params: orderParams,
  response: { 200: output({ asOf: instant(), items: z.array(partnerRequest), live }) },
})

export const withdrawContract = defineContract({ params: requestParams, body: input({ version }), response: { 200: output({ request: partnerRequest }) } })

// ---- the office ---------------------------------------------------------------------------------------------------------------

const officeRequest = output({
  ...requestFields,
  companyId: id(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  /** The customer's person who asked. */
  askedBy: z.string().nullable(),
  answeredBy: z.string().nullable(),
  /** The amendment an accepted change made. */
  amendment: output({ id: id(), revision: z.number().int() }).nullable(),
  /** The reader may accept or refuse it now (orders.manage over the order, the request OPEN). */
  mayAnswer: z.boolean(),
})

export const officeListContract = defineContract({
  querystring: input({
    status: z.enum([...REQUEST_STATUSES, 'ALL']).default('OPEN'),
    orderId: id().optional(),
    partyId: id().optional(),
    companyId: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: {
    200: output({
      asOf: instant(),
      items: z.array(officeRequest),
      /** Rows in the status asked (and the filters). */
      count: z.number().int(),
      counts: output({ OPEN: z.number().int(), ACCEPTED: z.number().int(), REFUSED: z.number().int(), WITHDRAWN: z.number().int() }),
      live,
    }),
  },
})

export const officeRecordContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      asOf: instant(),
      request: officeRequest,
      /** What the cut-off rules say of each line now (the customer saw them when asking). */
      rulesNow: z.array(output({ lineId: id(), seq: z.number().int(), change: verdict, cancel: verdict })),
      /**
       * What accepting would do, for a reader who may answer an OPEN request: the amendment W2a would make (lines old → new,
       * money by grain, whether the customer must accept again) or its problems in words; the whole order's cancel impact;
       * the lines a partial cancel closes; a problem with the delivery address. Null otherwise.
       */
      preview: output({
        ok: z.boolean(),
        problems: z.array(issue),
        amendment: diffView.nullable(),
        cancel: impactView.nullable(),
        /** A cancel of some lines: what W2a's close of lines closes (the pieces that will not be made or shipped). */
        closes: z.array(output({ lineId: id(), seq: z.number().int(), closedShortQuantity: z.number().int() })).nullable(),
      }).nullable(),
      live,
    }),
  },
})

const answerBody = { version, answer: z.string().trim().max(MAX_ANSWER).nullable().optional() }

export const acceptContract = defineContract({
  params: input({ requestId: id() }),
  body: input({
    ...answerBody,
    /** The amendment's (or the cancel's) reason, kept with the order; default: the request's own words. */
    reason: z.string().trim().min(1).max(MAX_REASON).optional(),
  }),
  response: { 200: output({ request: officeRequest, orderCancelled: z.boolean() }) },
})

export const refuseContract = defineContract({
  params: input({ requestId: id() }),
  body: input({ version, answer: z.string().trim().min(1).max(MAX_ANSWER) }),
  response: { 200: output({ request: officeRequest }) },
})

// ---- the cut-off settings ------------------------------------------------------------------------------------------------------

const cutoffs = output({
  cancelCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
  cancelCutoffDays: z.number().int().nullable(),
  changeCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
})

const settingsAnswer = output({
  /** The company asked (null: the tenant-wide row). */
  companyId: id().nullable(),
  /** Where the rules in force come from: the company's sales settings, the tenant's, or none (no rule). */
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  inForce: cutoffs,
  /** The row asked for (the company's, or the tenant's), to save it; null: no sales settings saved there yet. */
  row: output({ id: id(), version: z.number().int(), cutoffs }).nullable(),
})

export const settingsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: settingsAnswer } })

export const saveSettingsContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    version,
    cancelCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
    cancelCutoffDays: z.number().int().min(1).max(MAX_CUTOFF_DAYS).nullable(),
    changeCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
  }),
  response: { 200: settingsAnswer },
})
