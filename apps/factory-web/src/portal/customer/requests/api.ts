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
  // ---- B-TH-291 (B-TH-095): the version a withdrawal names, and whether Withdraw is offered (else why not, in the person's words).
  version: z.number().optional(),
  withdraw: z.object({ allowed: z.boolean(), words: z.string().nullable() }).optional(),
  // ---- end B-TH-291
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
  // th-backend-g step 2: `mailed` — the receipt mail went to the person who sent it (absent: an answer of before).
  receipt: z.object({ number: z.string(), yourNumber, subject: z.string(), words, mailed: z.boolean().optional() }),
})
export type SendAnswer = z.infer<typeof sendAnswerSchema>

export const openAnswerSchema = z.object({
  open: z.boolean(),
  reason: words.nullable(),
  // B-TH-282 (B-TH-085): whether files may go with a request now, and why not in the person's words (the scanner's sentence).
  files: z.object({ open: z.boolean(), words: z.string().nullable() }).optional(),
})
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

// ---- B-TH-282 (B-TH-085): the customer's files — onto its request while undecided (`/portal/inquiries/:id/files…`), else through
// the request's thread (`/portal/threads/Inquiry/:id/files…`, the composer's own route); then one message of the customer carries
// them. The body names no party or company: the session's (W11, W25, W37).
const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const partnerFile = z.object({ id: z.string(), originalName: z.string(), kind: z.string(), sizeBytes: z.number(), status: z.string(), measurementSheet: z.boolean() })
export type PartnerFile = z.infer<typeof partnerFile>
const announced = z.object({ file: partnerFile, upload: presigned })

/** What a file announces: its name, type, size and SHA-256; "This is a measurement sheet" ticked or not. */
export interface FileAnnounce {
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
  measurementSheet?: boolean
}

/** The door a file goes through: the request's own while undecided, the request's thread after. */
export type FileDoor = 'request' | 'thread'

const filesPath = (door: FileDoor, id: string) => (door === 'request' ? `/portal/inquiries/${encodeURIComponent(id)}/files` : `/portal/threads/Inquiry/${encodeURIComponent(id)}/files`)

export const announceFile = (api: ApiClient, door: FileDoor, id: string, body: FileAnnounce, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(filesPath(door, id), { body: { ...body, ...(body.measurementSheet ? { measurementSheet: true } : {}) }, schema: announced, idempotencyKey })

export const completeFile = (api: ApiClient, door: FileDoor, id: string, fileId: string, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`${filesPath(door, id)}/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: partnerFile }), idempotencyKey }).then((answer) => answer.file)

/** One message of the customer carrying the files sent (each available after the scan). */
export function attachFiles(api: ApiClient, door: FileDoor, id: string, fileIds: readonly string[], idempotencyKey: string = newIdempotencyKey()): Promise<unknown> {
  return door === 'request'
    ? api.post(`/portal/inquiries/${encodeURIComponent(id)}/files/attach`, { body: { fileIds: [...fileIds] }, idempotencyKey })
    : api.post(`/portal/threads/Inquiry/${encodeURIComponent(id)}/messages`, { body: { body: '', attachments: [...fileIds] }, idempotencyKey })
}
// ---- end B-TH-282

// ---- B-TH-291 (B-TH-095): the customer withdraws its own request before the office decided ------------------------------------
export const withdrawRequest = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<RequestView> =>
  api.post(`/portal/inquiries/${encodeURIComponent(id)}/withdraw`, { body: { version }, schema: z.object({ request: requestViewSchema }), idempotencyKey }).then((answer) => answer.request)
// ---- end B-TH-291
