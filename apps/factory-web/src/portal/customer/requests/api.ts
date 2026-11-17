import { z } from 'zod'
import { PORTAL_REQUEST_STATES } from '@nexus/factory-domain/sales/portal-requests/state'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The customer's requests in its portal (B-TH-220 send, B-TH-222 one request, B-TH-223 the list, B-TH-303 its own numbers),
 * every answer checked against the API's contract (factory-domain sales/portal-requests/contracts; apps/factory-api
 * modules/sales/portal-requests): POST /portal/inquiries, GET /portal/inquiries, GET /portal/inquiries/open and
 * GET /portal/inquiries/:id. The request's company and party are the session's: the send's body names neither (W11). The web
 * reads only what it uses; the office's number (`number`, INQ-…) is read but never drawn — a customer reads its own count,
 * "Your request 7" (Owner decision PR-06, pick A: a shared series would tell it how much the others order).
 */

export { PORTAL_REQUEST_STATES }
export type RequestStateCode = (typeof PORTAL_REQUEST_STATES)[number]

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
/** "Your request 7": the customer's own count with its words (null: none yet). */
const yourNumber = z.object({ seq: z.number(), words }).nullable()
export type YourNumber = z.infer<typeof yourNumber>

const state = z.object({ code: z.enum(PORTAL_REQUEST_STATES), words, open: z.boolean(), needsYou: z.boolean() })

export const requestRowSchema = z.object({
  id: z.string(),
  /** The office's number (INQ-…): kept for the office's words, never shown in the portal (B-TH-303). */
  number: z.string(),
  yourNumber,
  customerRef: z.string().nullable(),
  subject: z.string(),
  state,
  wantedDate: z.string().nullable(),
  receivedAt: z.string(),
  updatedAt: z.string(),
  pieces: z.number(),
})
export type RequestRow = z.infer<typeof requestRowSchema>

const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  colourText: z.string().nullable(),
  description: z.string().nullable(),
  sizes: z.record(z.string(), z.number()),
  quantity: z.number().nullable(),
  note: z.string().nullable(),
  /** A price the customer saw: absent without the price grain. */
  unitPriceShown: z.string().nullable().optional(),
})
export type RequestLine = z.infer<typeof lineSchema>

export const requestViewSchema = requestRowSchema.extend({
  request: z.string(),
  source: z.string(),
  shipTo: z.object({ id: z.string(), name: z.string().nullable(), line1: z.string(), postalCode: z.string(), city: z.string(), country: z.string(), waiting: z.boolean() }).nullable(),
  lines: z.array(lineSchema),
  made: z.object({
    quote: z.object({ id: z.string(), number: z.string(), yourNumber, sent: z.boolean() }).nullable(),
    order: z.object({ id: z.string(), number: z.string(), yourNumber }).nullable(),
  }),
  closedAt: z.string().nullable(),
})
export type RequestView = z.infer<typeof requestViewSchema>

export const requestListSchema = z.object({
  rows: z.array(requestRowSchema),
  counts: z.object({ needsYou: z.number(), open: z.number() }),
  complete: z.boolean(),
})
export type RequestList = z.infer<typeof requestListSchema>

export const sendAnswerSchema = z.object({
  request: requestViewSchema,
  receipt: z.object({ number: z.string(), yourNumber, subject: z.string(), words }),
})
export type SendAnswer = z.infer<typeof sendAnswerSchema>

export const openAnswerSchema = z.object({ open: z.boolean(), reason: words.nullable() })
export type OpenAnswer = z.infer<typeof openAnswerSchema>

/** POST /portal/inquiries: what the customer typed. Never a party or a company: the session's (W11). */
export interface SendBody {
  subject?: string | null
  message: string
  customerRef?: string | null
  wantedDate?: string | null
  shipToAddressId?: string | null
}

export const sendRequest = (api: ApiClient, body: SendBody, idempotencyKey: string = newIdempotencyKey()): Promise<SendAnswer> =>
  api.post('/portal/inquiries', { body, schema: sendAnswerSchema, idempotencyKey })

export const fetchRequests = (api: ApiClient, query: { state?: 'OPEN' | 'CLOSED' | 'ALL'; limit?: number } = {}, signal?: AbortSignal): Promise<RequestList> =>
  api.get('/portal/inquiries', { query: { state: query.state ?? 'OPEN', limit: query.limit ?? 50 }, schema: requestListSchema, signal })

export const fetchRequestsOpen = (api: ApiClient, signal?: AbortSignal): Promise<OpenAnswer> => api.get('/portal/inquiries/open', { schema: openAnswerSchema, signal })

export const fetchRequest = (api: ApiClient, id: string, signal?: AbortSignal): Promise<RequestView> =>
  api.get(`/portal/inquiries/${encodeURIComponent(id)}`, { schema: z.object({ request: requestViewSchema }), signal }).then((answer) => answer.request)
