import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * New order & reorder in the portal (apps/factory-api modules/sales/portal-ordering, B-W2b-190; SAL-072, SAL-073, SAL-074;
 * design portal.customer.neworder, SCR-185): the customer's draft request kept on the server (`?draft=<id>`), its header,
 * lines with their size runs, a past order copied at today's prices, a sheet read with a dry run, the send. Every write
 * carries the request's `version` (409 when someone changed it) and an Idempotency-Key. Prices are decimal strings that
 * come ONLY with the price grain. The API's English and Italian sentences (`words`, `held`, `notice`, a problem's or a
 * notice's words, the send's words) are dropped: the page says everything from codes and figures in its own words. A
 * sheet row's reasons have no code: they are kept as the pair the domain wrote (`reasons`), shown in the page's language.
 */

export const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestStatus = (typeof STATUSES)[number]
export const SOURCES = ['PICKER', 'REORDER', 'UPLOAD'] as const
export type RequestSource = (typeof SOURCES)[number]
export const PROBLEM_CODES = ['NO_LINES', 'TOO_MANY_LINES', 'DATE_PAST', 'SHIP_TO_ARCHIVED', 'STYLE_NOT_SOLD', 'COLOUR_DISCONTINUED', 'SIZE_NOT_OFFERED', 'NO_SIZES', 'PRICE_CHANGED'] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]
export const NOTICE_CODES = ['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED', 'COLOUR_DISCONTINUED', 'STYLE_NOT_SOLD', 'MADE_TO_MEASURE', 'NO_SIZES_LEFT'] as const
export type NoticeCode = (typeof NOTICE_CODES)[number]
export const APPROVALS = ['WAITING', 'APPROVED', 'REFUSED'] as const

/** The API's limits (factory-domain sales/portal-ordering ORDERING_LIMITS). */
export const LIMITS = Object.freeze({ lines: 200, sizesPerLine: 60, quantity: 99_999, customerRef: 100, note: 4000, lineNote: 1000 })

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const sizeRow = z.object({ size: z.string(), quantity: z.number() })
const pair = z.object({ it: z.string(), en: z.string() })
export type Pair = z.infer<typeof pair>

export const problemSchema = z.object({ code: z.enum(PROBLEM_CODES), lineId: z.string().nullable(), size: z.string().nullable() })
export type Problem = z.infer<typeof problemSchema>
export const noticeSchema = z.object({ code: z.enum(NOTICE_CODES) })
export type Notice = z.infer<typeof noticeSchema>

export const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  style: named,
  colourway: named,
  sizes: z.array(z.object({ size: z.string(), quantity: z.number(), offered: z.boolean() })),
  /** The colourway's sizes offered today, in range order: the grid's columns. */
  offered: z.array(z.string()),
  /** The style's colours the customer may choose. */
  colours: z.array(named),
  pieces: z.number(),
  unitPriceShown: z.string().nullable().optional(),
  priceNow: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  note: z.string().nullable(),
  source: z.object({ orderLineId: z.string(), orderId: z.string(), orderNumber: z.string(), customerRef: z.string().nullable(), orderDate: z.string() }).nullable(),
  notices: z.array(noticeSchema),
  problems: z.array(problemSchema),
})
export type DraftLine = z.infer<typeof lineSchema>

export const requestSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.enum(STATUSES),
  source: z.enum(SOURCES),
  customerRef: z.string().nullable(),
  shipToAddressId: z.string().nullable(),
  requestedDate: z.string().nullable(),
  note: z.string().nullable(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  salesOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  quote: z.object({ id: z.string(), number: z.string() }).nullable(),
  version: z.number(),
  lines: z.array(lineSchema),
  summary: z.object({ lines: z.number(), pieces: z.number(), net: z.string().nullable().optional() }),
  problems: z.array(problemSchema),
  pricesChanged: z.number(),
})
export type DraftRequest = z.infer<typeof requestSchema>

export const addressSchema = z.object({
  id: z.string(),
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
  approval: z.object({ status: z.enum(APPROVALS) }).nullable(),
  version: z.number(),
})
export type ShipTo = z.infer<typeof addressSchema>

export const recordSchema = z.object({ request: requestSchema, addresses: z.array(addressSchema), seesPrices: z.boolean() })
export type DraftRecord = z.infer<typeof recordSchema>

// ── the drafts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const draftRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.enum(STATUSES),
  source: z.enum(SOURCES),
  customerRef: z.string().nullable(),
  lines: z.number(),
  pieces: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
})
export type DraftRow = z.infer<typeof draftRowSchema>
export const draftsSchema = z.object({ requests: z.array(draftRowSchema), seesPrices: z.boolean() })

/** The party's drafts, newest first. */
export const fetchDrafts = async (api: ApiClient, signal?: AbortSignal): Promise<DraftRow[]> =>
  (await api.get('/portal/order-requests', { query: { status: 'DRAFT' }, schema: draftsSchema, signal })).requests

export interface HeaderBody {
  customerRef?: string | null
  shipToAddressId?: string | null
  requestedDate?: string | null
  note?: string | null
}

const path = (id: string) => `/portal/order-requests/${encodeURIComponent(id)}`

export const createDraft = (api: ApiClient, body: { source: RequestSource } & HeaderBody, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post('/portal/order-requests', { body, schema: recordSchema, idempotencyKey })

export const fetchDraft = (api: ApiClient, id: string, signal?: AbortSignal): Promise<DraftRecord> => api.get(path(id), { schema: recordSchema, signal })

export const changeHeader = (api: ApiClient, id: string, body: { version: number } & HeaderBody, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PATCH', path(id), { body, schema: recordSchema, idempotencyKey })

export interface SizeAsk {
  size: string
  quantity: number
}
export interface NewLine {
  styleId: string
  colourwayId: string
  sizes: SizeAsk[]
  note?: string | null
}

export const addLines = (api: ApiClient, id: string, body: { version: number; lines: NewLine[] }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/lines`, { body, schema: recordSchema, idempotencyKey })

export const changeLine = (api: ApiClient, id: string, lineId: string, body: { version: number; sizes?: SizeAsk[]; colourwayId?: string; note?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PUT', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey })

export const removeLine = (api: ApiClient, id: string, lineId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('DELETE', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { query: { version }, schema: recordSchema, idempotencyKey })

export const takeTodaysPrices = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/prices`, { body: { version }, schema: recordSchema, idempotencyKey })

export const discardDraft = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<{ discarded: true }> =>
  api.request('DELETE', path(id), { query: { version }, schema: z.object({ discarded: z.literal(true) }), idempotencyKey })

export const sentSchema = recordSchema.extend({ sent: z.object({ number: z.string(), confirmBy: z.string().nullable() }) })
export type SentRecord = z.infer<typeof sentSchema>
export const sendDraft = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<SentRecord> =>
  api.post(`${path(id)}/send`, { body: { version }, schema: sentSchema, idempotencyKey })

// ── reorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const pastOrderRowSchema = z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable(), orderDate: z.string().nullable(), lines: z.number(), pieces: z.number() })
export type PastOrderRow = z.infer<typeof pastOrderRowSchema>
export const fetchPastOrders = async (api: ApiClient, q: string | null, signal?: AbortSignal): Promise<PastOrderRow[]> =>
  (await api.get('/portal/reorder/orders', { query: { q: q && q.trim() !== '' ? q.trim() : undefined }, schema: z.object({ orders: z.array(pastOrderRowSchema) }), signal })).orders

export const pastLineSchema = z.object({
  orderLineId: z.string(),
  seq: z.number(),
  style: named,
  colourway: named,
  sizesOrdered: z.array(sizeRow),
  sizes: z.array(sizeRow),
  pieces: z.number(),
  unitPriceThen: z.string().nullable().optional(),
  priceNow: z.string().nullable().optional(),
  addable: z.boolean(),
  needsColour: z.boolean(),
  colours: z.array(named),
  notices: z.array(noticeSchema),
})
export type PastLine = z.infer<typeof pastLineSchema>
export const pastOrderSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable(), orderDate: z.string().nullable() }),
  lines: z.array(pastLineSchema),
  seesPrices: z.boolean(),
})
export type PastOrder = z.infer<typeof pastOrderSchema>
export const fetchPastOrder = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PastOrder> =>
  api.get(`/portal/reorder/orders/${encodeURIComponent(orderId)}`, { schema: pastOrderSchema, signal })

const merges = z.array(z.object({ lineId: z.string(), size: z.string() }))
export const reorderSchema = recordSchema.extend({ added: z.number(), merged: merges, kept: merges, skipped: z.array(z.object({ orderLineId: z.string(), seq: z.number(), notices: z.array(noticeSchema) })) })
export type ReorderAnswer = z.infer<typeof reorderSchema>
export const reorderInto = (api: ApiClient, id: string, body: { version: number; orderId: string; lines?: { orderLineId: string; colourwayId?: string }[] }, idempotencyKey: string = newIdempotencyKey()): Promise<ReorderAnswer> =>
  api.post(`${path(id)}/reorder`, { body, schema: reorderSchema, idempotencyKey })

// ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const verdictSchema = z.object({
  rowNumber: z.number(),
  status: z.enum(['READY', 'REFUSED']),
  style: z.string().nullable(),
  colour: z.string().nullable(),
  size: z.string().nullable(),
  quantity: z.number().nullable(),
  yourCode: z.string().nullable(),
  styleId: z.string().nullable(),
  colourwayId: z.string().nullable(),
  /** The domain's own reasons (it/en): a sheet row has no code. */
  reasons: z.array(pair),
})
export type Verdict = z.infer<typeof verdictSchema>
export const uploadSchema = z.object({
  dryRun: z.object({
    rows: z.number(),
    ready: z.number(),
    refused: z.number(),
    verdicts: z.array(verdictSchema),
    lines: z.array(z.object({ styleId: z.string(), styleCode: z.string(), colourwayId: z.string(), colourwayCode: z.string(), sizes: z.array(sizeRow), note: z.string().nullable() })),
    refusedCsv: z.string().nullable(),
    columns: z.array(z.object({ header: z.string(), column: z.string() })),
    ignored: z.array(z.string()),
  }),
  applied: z.boolean(),
  added: z.number().optional(),
  merged: merges.optional(),
  kept: merges.optional(),
  record: recordSchema.nullable(),
})
export type UploadAnswer = z.infer<typeof uploadSchema>
export interface UploadBody {
  fileName: string
  contentType: string
  content: string
  numberFormat: 'it' | 'en'
  locale: 'it' | 'en'
  apply: boolean
  version?: number
}
export const uploadSheet = (api: ApiClient, id: string, body: UploadBody, idempotencyKey: string = newIdempotencyKey()): Promise<UploadAnswer> =>
  api.post(`${path(id)}/upload`, { body, schema: uploadSchema, idempotencyKey })

/** The order template (tab:template): a GET the browser saves (the portal cookie goes with it). */
export const templateHref = (locale: 'it' | 'en'): string => `/api/portal/order-template?format=xlsx&numberFormat=${locale}`

/** At most about 700 KB of sheet travel in the JSON body (the API's limit). */
export const SHEET_MAX_BYTES = 700 * 1024

/** A file's bytes as base64 (the upload's `content`). */
export async function fileContent(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
