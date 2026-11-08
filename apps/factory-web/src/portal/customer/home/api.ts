import { z } from 'zod'
import { APPROVAL_DECISIONS, APPROVAL_KINDS, APPROVAL_STATUSES, type ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { CUSTOMER_ORDER_STATUSES } from '@nexus/factory-domain/sales/portal-orders/status'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { previewLink } from '../../../record-panels/files/api'
import { readFromStore } from '../../../record-panels/store'

/**
 * What the customer's Home reads besides the frame's one task list (B-W2b-187; design portal.customer.home, SAL-063): the
 * counts at a glance (GET /portal/home, B-W2b-167's sources: orders B-W2b-175, invoices B-W2b-185, documents B-W2b-178,
 * returns B-W2b-192, approvals B-W2b-184), the next five open orders by promise (B-W2b-175), the documents new since the
 * last visit (B-W2b-178), our last three messages (B-W2b-168), the open invoices' amount for the Finance tile (B-W2b-185),
 * and the approval a row of What waits for you asks (B-W2b-184). Each answer is checked; the web reads only what it uses.
 * Money comes only with the person's price grain (the API drops it otherwise: those fields are optional here).
 */

const words = z.object({ it: z.string(), en: z.string() })
const live = z.object({ events: z.array(z.string()) })

// ── the counts ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const homeSchema = z.object({
  asOf: z.string(),
  kind: z.string().nullable(),
  counts: z.array(z.object({ key: z.string(), area: z.string(), words, value: z.number().nullable() })),
  live,
})
export type HomeRead = z.infer<typeof homeSchema>
export const fetchHome = (api: ApiClient, signal?: AbortSignal): Promise<HomeRead> => api.get('/portal/home', { schema: homeSchema, signal })

// ── the next deliveries ────────────────────────────────────────────────────────────────────────────────────────────────
export const orderRowSchema = z.object({
  kind: z.enum(['ORDER', 'REQUEST']).catch('ORDER'),
  id: z.string(),
  customerRef: z.string().nullable(),
  number: z.string().nullable(),
  status: z.enum(CUSTOMER_ORDER_STATUSES),
  promiseDate: z.string().nullable(),
  originalPromiseDate: z.string().nullable(),
  promiseMoved: z.boolean(),
  requestedDate: z.string().nullable(),
  pieces: z.object({ ordered: z.number(), shipped: z.number(), open: z.number() }),
  nextShipment: z.object({ id: z.string(), number: z.string(), status: z.string(), words }).nullable(),
  progressPercent: z.number().nullable(),
})
export type OrderRow = z.infer<typeof orderRowSchema>

export const ordersSchema = z.object({
  asOf: z.string(),
  progressShared: z.boolean(),
  chips: z.array(z.object({ chip: z.string(), count: z.number() })),
  count: z.number(),
  items: z.array(orderRowSchema),
  live,
})
export type OrdersRead = z.infer<typeof ordersSchema>

/** The next five open orders by promise date, with the production % where the customer shares it (C1). */
export const fetchNextOrders = (api: ApiClient, signal?: AbortSignal): Promise<OrdersRead> =>
  api.get('/portal/sales-orders', { query: { chip: 'OPEN', limit: 5, progress: 'true' }, schema: ordersSchema, signal })

const promiseHistorySchema = z.object({
  promiseHistory: z.array(z.object({ on: z.string(), from: z.string().nullable(), to: z.string(), reason: z.object({ code: z.string(), words }) })),
})
export type PromiseHistory = z.infer<typeof promiseHistorySchema>['promiseHistory']

/** Why an order's promise moved (its history, newest first, in curated reasons only). */
export const fetchPromiseHistory = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PromiseHistory> =>
  api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}`, { schema: promiseHistorySchema, signal }).then((read) => read.promiseHistory)

// ── the new documents ──────────────────────────────────────────────────────────────────────────────────────────────────
const replacementSchema = z.object({ id: z.string().nullable(), title: words, version: z.number() })

export const documentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  kindWords: words,
  group: z.string(),
  title: words,
  for: z
    .object({ type: z.string(), id: z.string(), label: z.string().nullable(), order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable() }).nullable() })
    .nullable(),
  date: z.string(),
  version: z.number(),
  fingerprint: z.string(),
  language: z.string().nullable(),
  current: z.boolean(),
  replacedBy: replacementSchema.nullable(),
  new: z.boolean(),
  files: z.array(z.object({ fileId: z.string(), format: z.enum(['PDF', 'XML', 'FILE']).catch('FILE'), name: z.string(), contentType: z.string(), sizeBytes: z.number() })),
})
export type CustomerDocument = z.infer<typeof documentSchema>

export const documentsSchema = z.object({ asOf: z.string(), count: z.number(), newCount: z.number(), lastVisitAt: z.string().nullable(), items: z.array(documentSchema), live })
export type DocumentsRead = z.infer<typeof documentsSchema>

/** The documents issued since the last visit and not opened yet (SAL-086), newest first. */
export const fetchNewDocuments = (api: ApiClient, signal?: AbortSignal): Promise<DocumentsRead> =>
  api.get('/portal/customer-documents', { query: { new: 'true', limit: 5 }, schema: documentsSchema, signal })

export const oneDocumentSchema = z.object({
  document: documentSchema.nullable(),
  withdrawn: z.object({ title: words, version: z.number(), replacedBy: replacementSchema.nullable() }).nullable(),
  versions: z.array(documentSchema),
})
export type OneDocument = z.infer<typeof oneDocumentSchema>
export const fetchDocument = (api: ApiClient, fileId: string, signal?: AbortSignal): Promise<OneDocument> =>
  api.get(`/portal/customer-documents/${encodeURIComponent(fileId)}`, { schema: oneDocumentSchema, signal })

const downloadSchema = z.object({
  document: z.object({ id: z.string(), title: words, version: z.number(), format: z.enum(['PDF', 'XML', 'FILE']).catch('FILE'), name: z.string() }),
  download: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})

/**
 * A document's bytes (ONE logged open: POST …/download, the API writes the audit row, then the 60-second address is read
 * at once). `preview` opens in place; `download` is saved. The open clears NEW for this person.
 */
export async function documentBytes(api: ApiClient, fileId: string, mode: 'preview' | 'download'): Promise<{ name: string; bytes: Uint8Array }> {
  const answer = await api.post(`/portal/customer-documents/${encodeURIComponent(fileId)}/download`, { body: { mode }, schema: downloadSchema, idempotencyKey: newIdempotencyKey() })
  const bytes = await readFromStore({ method: 'GET', url: answer.download.url, headers: answer.download.headers, expiresAt: answer.download.expiresAt })
  return { name: answer.document.name, bytes }
}

// ── our last messages ──────────────────────────────────────────────────────────────────────────────────────────────────
export const conversationSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), theirRef: z.string().nullable(), ourRef: z.string().nullable(), subtitle: z.string().nullable(), status: z.string().nullable() }),
  thread: z.object({ id: z.string(), status: z.string() }),
  last: z.object({ id: z.string(), side: z.string(), channel: z.string(), authorName: z.string().nullable(), excerpt: z.string(), attachmentCount: z.number(), at: z.string() }),
})
export type Conversation = z.infer<typeof conversationSchema>
export const fetchRecentMessages = (api: ApiClient, signal?: AbortSignal): Promise<{ conversations: Conversation[] }> =>
  api.get('/portal/threads', { query: { from: 'company', limit: 3 }, schema: z.object({ conversations: z.array(conversationSchema) }), signal })

// ── the open invoices' amount (Finance) ────────────────────────────────────────────────────────────────────────────────
export const openItemsSchema = z.object({
  byCurrency: z.array(z.object({ currency: z.string(), open: z.number().optional(), overdue: z.number().optional() })),
  counts: z.object({ invoices: z.number(), overdue: z.number(), deposits: z.number() }),
})
export type OpenItemsRead = z.infer<typeof openItemsSchema>
export const fetchOpenItems = (api: ApiClient, signal?: AbortSignal): Promise<OpenItemsRead> => api.get('/portal/payments/open-items', { schema: openItemsSchema, signal })

/** The statement of account as a PDF in a new tab (made on the fly, stored nowhere; B-W2b-185). */
export const statementHref = (language: 'it' | 'en'): string => `/api/portal/payments/statement/pdf?language=${language}`

// ── an approval we ask (B-W2b-184's portal page: the link page's shape without `link`) ─────────────────────────────────
const fileSchema = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })
export type ApprovalFile = z.infer<typeof fileSchema>

const revisedLineSchema = z.object({
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED']).catch('CHANGED'),
  lineId: z.string(),
  seq: z.number(),
  style: z.object({ code: z.string(), name: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }),
  piecesBefore: z.number(),
  piecesAfter: z.number(),
  sizes: z.array(z.object({ size: z.string(), before: z.number(), after: z.number() })),
})
export type RevisedLine = z.infer<typeof revisedLineSchema>

const revisedOrderSchema = z.object({
  orderNumber: z.string(),
  revision: z.number(),
  currency: z.string(),
  lines: z.array(revisedLineSchema),
  header: z.array(z.object({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
  prices: z.array(z.object({ lineId: z.string(), unitPrice: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(), netBefore: z.number(), netAfter: z.number() })).optional(),
  netAmountBefore: z.number().optional(),
  netAmountAfter: z.number().optional(),
  grossAmountBefore: z.number().optional(),
  grossAmountAfter: z.number().optional(),
})
export type RevisedOrder = z.infer<typeof revisedOrderSchema>

export const approvalSchema = z.object({
  request: z.object({
    id: z.string(),
    kind: z.enum(APPROVAL_KINDS),
    label: z.string(),
    question: z.string(),
    from: z.object({ companyName: z.string() }),
    dueAt: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    answer: z.object({ at: z.string(), typedName: z.string(), words: z.string().nullable() }).nullable(),
    version: z.number(),
  }),
  content: z.object({ facts: z.array(z.object({ label: z.string(), value: z.string() })), revisedOrder: revisedOrderSchema.nullable() }),
  files: z.array(fileSchema),
  may: z.object({ answer: z.boolean(), withChanges: z.boolean() }),
  locale: z.enum(['it', 'en']),
  receipt: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable().optional(),
})
export type ApprovalRead = z.infer<typeof approvalSchema>

export const fetchApproval = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<ApprovalRead> =>
  api.get(`/portal/approvals/${encodeURIComponent(requestId)}`, { schema: approvalSchema, signal })

export interface ApprovalAnswer {
  decision: ApprovalDecision
  answer: string | null
  typedName: string
  version: number
}
export const APPROVAL_ANSWERS = APPROVAL_DECISIONS

/** The signed answer in the portal (ONE command; the request's task closes with it). */
export const answerApproval = (api: ApiClient, requestId: string, body: ApprovalAnswer): Promise<ApprovalRead> =>
  api.post(`/portal/approvals/${encodeURIComponent(requestId)}/answer`, { body: { ...body, markup: null }, schema: approvalSchema, idempotencyKey: newIdempotencyKey() })

/** One of the request's files, read once through the files route (presigned for 60 seconds). */
export async function approvalFileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { preview } = await previewLink(api, fileId)
  return readFromStore({ method: 'GET', url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt })
}
