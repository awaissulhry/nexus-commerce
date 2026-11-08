import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The supplier's ship notices in the portal (apps/factory-api modules/purchasing/ship-notices, B-W2b-182; design
 * portal.supplier.asn, SCR-227): the deliveries announced and how each was received, the open lines of confirmed orders,
 * a notice with its checks per hide and per line, its packing list by sheet (read and judged first, kept on the second
 * call), its transport terms, the send and the cancel. NOTHING here is money (Owner answer C2): no schema holds a price,
 * cost or amount. The API's English sentences (`words`, `verdictWords`, `sendHeld`, `warnings`, a reason's `words`, the
 * send's `done`) are left out or read only as counts: the page says everything from codes and figures in its own words.
 * Every write carries an Idempotency-Key and the notice's version; quantities are decimal strings in the line's unit,
 * days calendar days, times UTC instants.
 */

const live = z.object({ events: z.array(z.string()) })

export const NOTICE_STATES = ['DRAFT', 'ANNOUNCED', 'IN_TRANSIT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCES', 'CANCELLED'] as const
export type NoticeState = (typeof NOTICE_STATES)[number]
export const isNoticeState = (value: unknown): value is NoticeState => typeof value === 'string' && (NOTICE_STATES as readonly string[]).includes(value)

export const VERDICTS = ['OK', 'CHECK', 'NOT_AS_ORDERED'] as const
export type Verdict = (typeof VERDICTS)[number]

/** A check's reason: its code and figures (the page words it; the API's own sentence is dropped). */
export const reasonSchema = z.object({ code: z.string(), verdict: z.enum(VERDICTS), params: z.record(z.string(), z.union([z.string(), z.number()])) })
export type Reason = z.infer<typeof reasonSchema>

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const noticeRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  state: z.enum(NOTICE_STATES),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }),
  shipDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  ddtNumber: z.string().nullable(),
  supplierRef: z.string().nullable(),
  parcels: z.number().nullable(),
  sentAt: z.string().nullable(),
  lines: z.number(),
  hides: z.number(),
  differing: z.number(),
  version: z.number(),
})
export type NoticeRow = z.infer<typeof noticeRowSchema>

export const noticesSchema = z.object({ asOf: z.string(), mayWrite: z.boolean(), counts: z.record(z.string(), z.number()), items: z.array(noticeRowSchema), more: z.boolean(), live })
export type NoticesRead = z.infer<typeof noticesSchema>

export const fetchNotices = (api: ApiClient, query: { state?: NoticeState | null; q?: string | null }, signal?: AbortSignal): Promise<NoticesRead> =>
  api.get('/portal/ship-notices', { query: { state: query.state ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined }, schema: noticesSchema, signal })

// ── the lines it may ship ────────────────────────────────────────────────────────────────────────────────────────────
export const lineChoiceSchema = z.object({
  purchaseOrderLineId: z.string(),
  seq: z.number(),
  item: z.object({ code: z.string(), name: z.string(), leather: z.boolean() }),
  supplierArticleCode: z.string().nullable(),
  colour: z.string().nullable(),
  uom: z.string(),
  expected: z.string(),
  received: z.string(),
  inTransit: z.string(),
  open: z.string(),
  needDate: z.string(),
  confirmedDate: z.string().nullable(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  tolerancePct: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  requiresCrViTest: z.boolean(),
})
export type LineChoice = z.infer<typeof lineChoiceSchema>

export const shippableSchema = z.object({
  mayWrite: z.boolean(),
  orders: z.array(z.object({ id: z.string(), number: z.string(), documentNumber: z.string(), status: z.string(), lines: z.array(lineChoiceSchema) })),
})
export type ShippableRead = z.infer<typeof shippableSchema>
export type ShippableOrder = ShippableRead['orders'][number]

export const fetchShippable = (api: ApiClient, purchaseOrderId: string | null, signal?: AbortSignal): Promise<ShippableRead> =>
  api.get('/portal/ship-notices/shippable', { query: { purchaseOrderId: purchaseOrderId ?? undefined }, schema: shippableSchema, signal })

// ── one notice ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const hideSchema = z.object({
  id: z.string(),
  seq: z.number(),
  hideNumber: z.string(),
  area: z.string(),
  areaUom: z.string(),
  grade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  note: z.string().nullable(),
  verdict: z.enum(VERDICTS),
  reasons: z.array(reasonSchema),
})
export type NoticeHide = z.infer<typeof hideSchema>

const figures = z.object({ hides: z.number(), area: z.string().nullable(), expected: z.string(), before: z.string(), upTo: z.string(), openAfter: z.string() })

export const noticeLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  purchaseOrderLineId: z.string(),
  orderSeq: z.number().nullable(),
  item: z.object({ code: z.string(), name: z.string(), leather: z.boolean() }).nullable(),
  supplierArticleCode: z.string().nullable(),
  colour: z.string().nullable(),
  quantity: z.string(),
  uom: z.string(),
  supplierLot: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  note: z.string().nullable(),
  receivedQuantity: z.string().nullable(),
  verdict: z.enum(VERDICTS),
  reasons: z.array(reasonSchema),
  figures: figures.nullable(),
  hides: z.array(hideSchema),
})
export type NoticeLine = z.infer<typeof noticeLineSchema>

export const noticeSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  state: z.enum(NOTICE_STATES),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }),
  siteId: z.string(),
  supplierRef: z.string().nullable(),
  ddtNumber: z.string().nullable(),
  ddtDate: z.string().nullable(),
  shipDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  parcels: z.number().nullable(),
  note: z.string().nullable(),
  sentAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  verdict: z.enum(VERDICTS),
  counts: z.object({ ok: z.number(), check: z.number(), notAsOrdered: z.number() }),
  differing: z.array(z.string()),
  lines: z.array(noticeLineSchema),
})
export type Notice = z.infer<typeof noticeSchema>

export const noticePageSchema = z.object({
  notice: noticeSchema,
  site: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  mayWrite: z.boolean(),
  canEdit: z.boolean(),
  canSend: z.boolean(),
  canCancel: z.boolean(),
  /** Read as a count only: what holds the send (the page says its own reasons from the notice). */
  sendHeld: z.array(z.string()),
  /** Read as a count only: documents the send asks for without holding it. */
  warnings: z.array(z.string()),
  addable: z.array(lineChoiceSchema),
  live,
})
export type NoticePage = z.infer<typeof noticePageSchema>

export const fetchNotice = (api: ApiClient, id: string, signal?: AbortSignal): Promise<NoticePage> => api.get(`/portal/ship-notices/${encodeURIComponent(id)}`, { schema: noticePageSchema, signal })

// ── writes ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface LineBody {
  readonly purchaseOrderLineId: string
  readonly quantity: string
  readonly supplierLot: string | null
  readonly dyeBatch: string | null
}

export interface TermsBody {
  readonly supplierRef: string | null
  readonly ddtNumber: string | null
  readonly ddtDate: string | null
  readonly shipDate: string | null
  readonly expectedDate: string | null
  readonly carrier: string | null
  readonly trackingNumber: string | null
  readonly parcels: number | null
  readonly note: string | null
}

const path = (id: string, rest = '') => `/portal/ship-notices/${encodeURIComponent(id)}${rest}`

/** A DRAFT from one of our confirmed orders (step 1): its lines (and any terms already typed). */
export const createNotice = (api: ApiClient, body: { purchaseOrderId: string; lines: readonly LineBody[] } & Partial<TermsBody>, idempotencyKey: string = newIdempotencyKey()): Promise<NoticePage> =>
  api.post('/portal/ship-notices', { body, schema: noticePageSchema, idempotencyKey })

/** Its lines and / or terms, until received (a SENT notice: the office is told). */
export const updateNotice = (api: ApiClient, id: string, body: { version: number; lines?: readonly LineBody[] } & Partial<TermsBody>, idempotencyKey: string = newIdempotencyKey()): Promise<NoticePage> =>
  api.request('PATCH', path(id), { body, schema: noticePageSchema, idempotencyKey })

/** The packing list replaced (an empty list removes it: the hides are measured at the dock). */
export const setPackingList = (api: ApiClient, id: string, body: { version: number; rows: readonly unknown[] }, idempotencyKey: string = newIdempotencyKey()): Promise<NoticePage> =>
  api.request('PUT', path(id, '/packing-list'), { body, schema: noticePageSchema, idempotencyKey })

const lineVerdictSchema = z.object({ lineId: z.string(), seq: z.number(), verdict: z.enum(VERDICTS), reasons: z.array(reasonSchema), hides: z.number(), area: z.string().nullable(), expected: z.string(), before: z.string(), upTo: z.string(), openAfter: z.string() })
export type LineVerdict = z.infer<typeof lineVerdictSchema>

export const sheetRowSchema = z.object({
  rowNumber: z.number(),
  hideNumber: z.string().nullable(),
  line: z.number().nullable(),
  area: z.string().nullable(),
  unit: z.string().nullable(),
  grade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  /** Each problem's column only: the page says it in its own words. */
  errors: z.array(z.object({ column: z.string().nullable() })),
  verdict: z.enum(VERDICTS).nullable(),
  reasons: z.array(reasonSchema),
})
export type SheetRow = z.infer<typeof sheetRowSchema>

export const sheetSchema = z.object({
  fileName: z.string(),
  format: z.enum(['csv', 'xlsx']),
  sheet: z.string().nullable(),
  numberFormat: z.string(),
  columns: z.array(z.string()),
  ignored: z.array(z.string()),
  rows: z.array(sheetRowSchema),
  unreadable: z.number(),
  verdict: z.enum(VERDICTS).nullable(),
  lines: z.array(lineVerdictSchema),
  applied: z.boolean(),
  page: noticePageSchema.nullable(),
})
export type SheetRead = z.infer<typeof sheetSchema>

export interface SheetBody {
  readonly version: number
  readonly fileName: string
  /** The file, base64 (read in the request, never stored). */
  readonly content: string
  readonly numberFormat: 'it' | 'en'
  readonly apply: boolean
}

/** The tannery's sheet read and judged row by row (`apply: false`), or kept when every row reads (`apply: true`). */
export const readSheet = (api: ApiClient, id: string, body: SheetBody, idempotencyKey: string = newIdempotencyKey()): Promise<SheetRead> =>
  api.post(path(id, '/packing-list/sheet'), { body, schema: sheetSchema, idempotencyKey })

export const sendNotice = (api: ApiClient, id: string, body: { version: number; note: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<NoticePage> =>
  api.post(path(id, '/send'), { body, schema: noticePageSchema, idempotencyKey })

export const cancelSchema = z.object({ removed: z.boolean(), page: noticePageSchema.nullable() })
export type CancelRead = z.infer<typeof cancelSchema>

/** A sent notice CANCELLED with the reason; a draft removed. */
export const cancelNotice = (api: ApiClient, id: string, body: { version: number; reason: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<CancelRead> =>
  api.post(path(id, '/cancel'), { body, schema: cancelSchema, idempotencyKey })

/** The packing list template (a downloaded file, made-up example rows), through the web's `/api` in a new tab. */
export const templateHref = (format: 'xlsx' | 'csv', locale: 'it' | 'en'): string => `/api/portal/ship-notices/template?format=${format}&numberFormat=${locale}`

/** A sheet as the API takes it inline (base64 of its bytes). */
export const SHEET_MAX_BYTES = 700 * 1024
export async function fileContent(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
