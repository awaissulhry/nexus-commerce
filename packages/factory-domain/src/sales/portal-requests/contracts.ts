import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { PORTAL_REQUEST_LIMITS } from './rules'
import { PORTAL_REQUEST_STATES } from './state'

/**
 * The customer's requests in the portal (B-TH-010 send, B-TH-103 reads, B-TH-011 states, B-TH-105 its own numbers, B-TH-012
 * whether the door is open): what apps/factory-api's modules/sales/portal-requests accepts and answers. The request's company
 * and party are the session's, never a field. Every state comes with its words in Italian and English. Never an office person,
 * an office note, the target price or anything only the office sees; a line's price shown only with the price grain.
 */

/** Words of several lines (no control characters but line breaks and tabs). */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), { message: 'No control characters.' })
/** One line of words. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value), { message: 'One line, no control characters.' })

const words = output({ it: z.string(), en: z.string() })
const yourNumber = output({ seq: z.number().int(), words }).nullable()

/** POST /portal/inquiries: "New order" as an e-mail (P-CUS-NEW): everything but the message is optional. */
export const sendRequestBody = input({
  subject: line(PORTAL_REQUEST_LIMITS.subject).nullish(),
  message: text(PORTAL_REQUEST_LIMITS.message).refine((value) => value.trim() !== '', { message: 'Write what you need.' }),
  customerRef: line(PORTAL_REQUEST_LIMITS.customerRef).nullish(),
  wantedDate: businessDate().nullish(),
  shipToAddressId: id().nullish(),
})
export type SendRequestBody = z.infer<typeof sendRequestBody>

/** GET /portal/inquiries: the open requests (default), the closed ones, or all. */
export const requestListQuery = input({
  state: z.enum(['OPEN', 'CLOSED', 'ALL']).default('OPEN'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type RequestListQuery = z.infer<typeof requestListQuery>

export const inquiryParams = input({ inquiryId: id() })

const state = output({ code: z.enum(PORTAL_REQUEST_STATES), words, open: z.boolean(), needsYou: z.boolean() })

/** One request of the list (P-CUS-ORD-LIST, Kind = Request). */
export const portalRequestRow = output({
  id: id(),
  /** th2-backend step 7 (threads plan §0.5, counts do not leak): the customer's own reference ("#7"); the office's INQ-… series
   *  is the office's only. */
  number: z.string(),
  /** B-TH-105: "Your request 7" (the customer's own count). */
  yourNumber,
  /** Their own reference (their PO), shown first. */
  customerRef: z.string().nullable(),
  /** The subject used (the request's first line). */
  subject: z.string(),
  state,
  wantedDate: businessDate().nullable(),
  receivedAt: instant(),
  /** When it last moved (its own change, its quote's or its order's). */
  updatedAt: instant(),
  pieces: z.number().int(),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  style: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  colourText: z.string().nullable(),
  description: z.string().nullable(),
  sizes: z.record(z.string(), z.number().int()),
  quantity: z.number().int().nullable(),
  note: z.string().nullable(),
  unitPriceShown: money.price(z.string().nullable()),
})

/** What was made of it: the quote (once there is one) and the order made from that quote, each with the customer's own number. */
const made = output({
  quote: output({ id: id(), number: z.string(), yourNumber, sent: z.boolean() }).nullable(),
  order: output({ id: id(), number: z.string(), yourNumber }).nullable(),
})

/** One request (X-P-CUS-REQ): its state, what was asked as written, the details, what was made of it. */
export const portalRequestView = portalRequestRow.extend({
  /** The customer's words as written (the first message of the request's thread says the same). */
  request: z.string(),
  source: z.string(),
  shipTo: output({ id: id(), name: z.string().nullable(), line1: z.string(), postalCode: z.string(), city: z.string(), country: z.string(), waiting: z.boolean() }).nullable(),
  lines: z.array(lineView),
  made,
  closedAt: instant().nullable(),
  // ---- B-TH-095 (N20): the version a withdrawal names, and whether Withdraw is offered (before the office decided, to who sends
  // requests) or why not, in the person's words. Optional for the web's typed demo data.
  version: z.number().int().optional(),
  withdraw: output({ allowed: z.boolean(), words: z.string().nullable() }).optional(),
})

/** B-TH-095: POST /portal/inquiries/:inquiryId/withdraw — the request's version as read. */
export const withdrawRequestBody = input({ version: z.number().int().min(1) })

export const portalRequestList = output({
  rows: z.array(portalRequestRow),
  /** The tiles: requests waiting for the customer ("We need something from you") and open requests. */
  counts: output({ needsYou: z.number().int(), open: z.number().int() }),
  /** The list holds every request of the choice (false: more than `limit`). */
  complete: z.boolean(),
})

/** The answer of a send: the request as the customer now reads it, and its receipt (P-CUS-NEW.receipt). */
export const sendRequestAnswer = output({
  request: portalRequestView,
  receipt: output({
    number: z.string(),
    yourNumber,
    subject: z.string(),
    words,
    /** th-backend-g step 2 (P-CUS-NEW.receipt-F02): the receipt mail went to the person who sent it (false: the page says it could not). */
    mailed: z.boolean(),
  }),
})

/** GET /portal/inquiries/open (B-TH-012): whether "New order" takes a request for the session's company, with the reason. */
export const requestsOpenAnswer = output({
  open: z.boolean(),
  reason: words.nullable(),
  /**
   * B-TH-085 (P-CUS-NEW.files, T6-F07): whether files may go with the request after Send, and why not in the person's words (the
   * outside uploads' sentence while the virus scanner does not run here, or their access). Optional for the web's typed demo data.
   */
  files: output({ open: z.boolean(), words: z.string().nullable() }).optional(),
})
