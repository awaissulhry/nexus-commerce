import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { ServerDraftBody } from '../../../lib/request-compose/server-draft' // B-TH-287
// F-CP-154 (B-CP-075, B-CP-076): the kinds of a draft line, how a person is measured, the parts of the checklist.
import { DRAFT_PARTS } from '@nexus/factory-domain/sales/portal-ordering/office'
import { MEASURE_BY } from '@nexus/factory-domain/sales/portal-ordering/people'
import { CUSTOM_LINE_KINDS } from '@nexus/factory-domain/sales/portal-ordering/rules'

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
export const PROBLEM_CODES = [
  'NO_LINES',
  'TOO_MANY_LINES',
  'DATE_PAST',
  'SHIP_TO_ARCHIVED',
  'STYLE_NOT_SOLD',
  'COLOUR_DISCONTINUED',
  'SIZE_NOT_OFFERED',
  'NO_SIZES',
  'PRICE_CHANGED',
  // F-CP-154 (B-CP-075, follow-up 7): a described or made-to-measure line's own problems — without them a draft holding such a line
  // would not parse.
  'NO_TOTAL',
  'SIZES_NOT_TOTAL',
  'NO_PEOPLE',
  'MTM_CLOSED',
  'GARMENT_TYPE_GONE',
] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]
export const NOTICE_CODES = ['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED', 'COLOUR_DISCONTINUED', 'STYLE_NOT_SOLD', 'MADE_TO_MEASURE', 'NO_SIZES_LEFT'] as const
export type NoticeCode = (typeof NOTICE_CODES)[number]
export const APPROVALS = ['WAITING', 'APPROVED', 'REFUSED'] as const

/** The API's limits (factory-domain sales/portal-ordering ORDERING_LIMITS). */
export const LIMITS = Object.freeze({ lines: 200, sizesPerLine: 60, quantity: 99_999, customerRef: 100, note: 4000, lineNote: 1000 })

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const sizeRow = z.object({ size: z.string(), quantity: z.number() })
/**
 * B-TH-304 (pick A, plan §0.5): the customer's own number of an order ("Your order 12"); the portal draws it and never the
 * office's `number` (SO-…), whose series would tell a customer how much the others order. Absent from an older answer: none.
 */
const ownNumber = z.object({ seq: z.number(), words: z.object({ it: z.string(), en: z.string() }) }).nullable().default(null)
export type OwnNumber = z.infer<typeof ownNumber>
const pair = z.object({ it: z.string(), en: z.string() })
export type Pair = z.infer<typeof pair>

export const problemSchema = z.object({
  code: z.enum(PROBLEM_CODES),
  lineId: z.string().nullable(),
  size: z.string().nullable(),
  // F-CP-154 (B-CP-075): the part of the checklist it holds and the person of a roster it is on (absent from an older answer).
  part: z.enum(DRAFT_PARTS).optional(),
  personId: z.string().nullable().optional(),
})
export type Problem = z.infer<typeof problemSchema>
export const noticeSchema = z.object({ code: z.enum(NOTICE_CODES) })
export type Notice = z.infer<typeof noticeSchema>

// F-CP-151 (B-CP-072): one of a draft's files (its own party's: named, with its version for a removal).
const draftFileSchema = z.object({
  id: z.string(),
  /** The line it is on (null: the draft's own). */
  lineId: z.string().nullable(),
  originalName: z.string(),
  kind: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  version: z.number(),
  createdAt: z.string(),
})
export type DraftFile = z.infer<typeof draftFileSchema>

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
  // B-TH-304: `orderNumber` is the office's (never drawn in the portal); `yourNumber` the customer's own ("Your order 12").
  source: z.object({ orderLineId: z.string(), orderId: z.string(), orderNumber: z.string(), yourNumber: ownNumber, customerRef: z.string().nullable(), orderDate: z.string() }).nullable(),
  notices: z.array(noticeSchema),
  problems: z.array(problemSchema),
  /** F-CP-154 (B-CP-076): "Your price" — the customer's own net unit price (price grain only; absent without it). */
  brandUnitPrice: z.string().nullable().optional(),
})
export type DraftLine = z.infer<typeof lineSchema>

// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1 and 4; B-CP-075): a line in the customer's own words and its people ---------
/** How a person of a by-person line is measured: a size, a measurement sheet of this draft, or sent later (no saved measurements in v1). */
export { MEASURE_BY, CUSTOM_LINE_KINDS }
export type MeasureBy = (typeof MEASURE_BY)[number]
export type CustomLineKind = (typeof CUSTOM_LINE_KINDS)[number]

export const personSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  name: z.string(),
  number: z.string().nullable(),
  measureBy: z.enum(MEASURE_BY),
  size: z.string().nullable(),
  /** SHEET: the draft's measurement sheet it names (the customer's own file: named). */
  sheet: z.object({ id: z.string(), originalName: z.string().nullable(), locked: z.boolean() }).nullable(),
  note: z.string().nullable(),
})
export type DraftPerson = z.infer<typeof personSchema>

export const customLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  kind: z.enum(CUSTOM_LINE_KINDS),
  description: z.string().nullable(),
  colourText: z.string().nullable(),
  /** A described line's own-label style, or the style a made-to-measure line is made from (null: none named). */
  style: named.nullable(),
  colourway: named.nullable(),
  /** MADE_TO_MEASURE: the garment type and its words. */
  garmentType: z.object({ code: z.string(), words: pair }).nullable(),
  /** DESCRIBED: the pieces in all (the sizes may follow after Send). */
  quantity: z.number().nullable(),
  sizes: z.array(sizeRow),
  byPerson: z.boolean(),
  pieces: z.number(),
  people: z.array(personSchema),
  /** By person, no one typed, a measurement sheet on the line: "People: in the attached sheet" (review A5). */
  peopleInSheet: z.boolean(),
  note: z.string().nullable(),
  problems: z.array(problemSchema),
  /** "Your price" (price grain only). */
  brandUnitPrice: z.string().nullable().optional(),
})
export type CustomLine = z.infer<typeof customLineSchema>

/** Made to measure for this customer: open (the default), else why not; the garment types it may choose. */
export const madeToMeasureSchema = z.object({ open: z.boolean(), words: pair.nullable(), garmentTypes: z.array(z.object({ code: z.string(), words: pair })) })
export type MadeToMeasure = z.infer<typeof madeToMeasureSchema>
// ---- end F-CP-154

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
  // ---- F-CP-150 (customer page plan C5, D9–D11): what the reader may do beside filling the draft (B-CP-070: a Designer fills,
  // never sends; a draft is discarded by one who may order or by the colleague who started it) — absent from an older answer: as
  // before (the Buyer's page). The parts marked "we send it later" and who changed it last come with B-CP-075 (PA2): read as
  // optional until then (the band says "Saved 10:42" without a name).
  may: z.object({ send: z.boolean(), withdraw: z.boolean(), discard: z.boolean() }).optional(),
  laterParts: z.array(z.string()).optional(),
  lastEditedBy: z.string().nullable().optional(),
  lastEditedAt: z.string().nullable().optional(),
  // ---- end F-CP-150
  // ---- F-CP-151 (B-CP-072): the draft's logos, references and measurement sheets (its own and its lines'), and whether files go
  // up here now — on live, until the virus scanner runs (D14, O7 not approved), they do not: the page says to e-mail them.
  files: z.object({ logos: z.array(draftFileSchema), references: z.array(draftFileSchema), sheets: z.array(draftFileSchema) }).optional(),
  uploads: z.object({ open: z.boolean(), words: z.string().nullable() }).optional(),
  // ---- end F-CP-151
  // ---- F-CP-154 (B-CP-075): the lines in the customer's own words (with `lines`, one draft by seq) and made to measure for it (null
  // once sent; absent from an older answer: none, and made to measure open — the default).
  customLines: z.array(customLineSchema).optional(),
  madeToMeasure: madeToMeasureSchema.nullable().optional(),
  // ---- end F-CP-154
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

// ---- F-CP-150 (D11): who may send a draft, for the held Send's words (a Designer reads "Only colleagues who may order send it:
// Marta Bianchi, …"): the organisation's people (portal.colleagues.view), each row's role and status. Nothing else is used.
export { fetchColleagues } from '../../shared/account/api'
// ---- end F-CP-150

export interface HeaderBody {
  customerRef?: string | null
  shipToAddressId?: string | null
  requestedDate?: string | null
  note?: string | null
  /** F-CP-151: the parts the customer sends later (LOGOS, REFERENCES, PEOPLE) — B-CP-075 keeps them (PA2). */
  laterParts?: string[]
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
  /** F-CP-154 (B-CP-076): "Your price" — only a price holder sends it (the grain filter refuses it from anyone else). */
  brandUnitPrice?: string | null
}

export const addLines = (api: ApiClient, id: string, body: { version: number; lines: NewLine[] }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/lines`, { body, schema: recordSchema, idempotencyKey })

export const changeLine = (api: ApiClient, id: string, lineId: string, body: { version: number; sizes?: SizeAsk[]; colourwayId?: string; note?: string | null; brandUnitPrice?: string | null /* F-CP-154 */ }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PUT', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey })

export const removeLine = (api: ApiClient, id: string, lineId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('DELETE', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { query: { version }, schema: recordSchema, idempotencyKey })

export const takeTodaysPrices = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/prices`, { body: { version }, schema: recordSchema, idempotencyKey })

export const discardDraft = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<{ discarded: true }> =>
  api.request('DELETE', path(id), { query: { version }, schema: z.object({ discarded: z.literal(true) }), idempotencyKey })

// B-TH-220 (with B-TH-041): no answer-time promise on either door: the send's answer no longer reads a confirm-by day.
export const sentSchema = recordSchema.extend({ sent: z.object({ number: z.string() }) })
export type SentRecord = z.infer<typeof sentSchema>
export const sendDraft = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<SentRecord> =>
  api.post(`${path(id)}/send`, { body: { version }, schema: sentSchema, idempotencyKey })

// ---- F-CP-154 (customer page plan C5; B-CP-075, B-CP-076): described and made-to-measure lines, the people of a by-person line --
// Every write is a draft command at the DRAFT's version (one rule for all parts; 409 when a colleague changed it). A custom line
// out is DELETE …/lines/:lineId (removeLine). "Your price" (brandUnitPrice) only from a price holder: a body with it from anyone else
// is refused (403) by the grain filter, so the page never sends the key without the grain. Bodies name no party or company (W-CP-1).
export interface CustomLineFields {
  description?: string | null
  colourText?: string | null
  styleId?: string | null
  colourwayId?: string | null
  garmentType?: string | null
  quantity?: number | null
  byPerson?: boolean
  sizes?: SizeAsk[]
  note?: string | null
  brandUnitPrice?: string | null
}

export const addCustomLine = (api: ApiClient, id: string, body: { version: number; line: { kind: CustomLineKind } & CustomLineFields }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/custom-lines`, { body, schema: recordSchema, idempotencyKey })

export const changeCustomLine = (api: ApiClient, id: string, lineId: string, body: { version: number } & CustomLineFields, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PUT', `${path(id)}/custom-lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey })

export interface PersonFields {
  name: string
  number?: string | null
  measureBy: MeasureBy
  size?: string | null
  /** SHEET: a measurement sheet of this draft (its own or one of its lines'). */
  measurementFileId?: string | null
  note?: string | null
}

const peoplePath = (id: string, lineId: string) => `${path(id)}/lines/${encodeURIComponent(lineId)}/people`

export const addPeople = (api: ApiClient, id: string, lineId: string, body: { version: number; people: PersonFields[] }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(peoplePath(id, lineId), { body, schema: recordSchema, idempotencyKey })

export const changePerson = (api: ApiClient, id: string, lineId: string, personId: string, body: { version: number } & Partial<PersonFields>, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PUT', `${peoplePath(id, lineId)}/${encodeURIComponent(personId)}`, { body, schema: recordSchema, idempotencyKey })

export const removePerson = (api: ApiClient, id: string, lineId: string, personId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('DELETE', `${peoplePath(id, lineId)}/${encodeURIComponent(personId)}`, { query: { version }, schema: recordSchema, idempotencyKey })
// ---- end F-CP-154

// ---- F-CP-151 (customer page plan C5; B-CP-072): a draft's files — POST …/files {part, lineId?, name, type, size, sha256} announces
// one and says where to PUT its bytes, …/files/:fileId/complete confirms it (held for the virus scan where one runs), DELETE
// …/files/:fileId?version= takes it out (the FILE's version; the draft as read comes back). A LOGO is filed as artwork, a
// REFERENCE with no category, a SHEET as a measurement sheet (body data: in the factory only who handles measurements opens it).
// The body names no party or company: the session's (W-CP-1, W-CP-3).
export const DRAFT_FILE_PARTS = ['LOGO', 'REFERENCE', 'SHEET'] as const
export type DraftFilePart = (typeof DRAFT_FILE_PARTS)[number]
const presignedSchema = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

export interface DraftFileAnnounce {
  part: DraftFilePart
  lineId?: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}

export const announceDraftFile = (api: ApiClient, id: string, body: DraftFileAnnounce, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`${path(id)}/files`, { body, schema: z.object({ file: draftFileSchema, upload: presignedSchema }), idempotencyKey })

export const completeDraftFile = (api: ApiClient, id: string, fileId: string, idempotencyKey: string = newIdempotencyKey()): Promise<DraftFile> =>
  api.post(`${path(id)}/files/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: draftFileSchema }), idempotencyKey }).then((answer) => answer.file)

export const removeDraftFile = (api: ApiClient, id: string, fileId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('DELETE', `${path(id)}/files/${encodeURIComponent(fileId)}`, { query: { version }, schema: recordSchema, idempotencyKey })
// ---- end F-CP-151

// ── reorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const pastOrderRowSchema = z.object({ id: z.string(), number: z.string(), yourNumber: ownNumber /* B-TH-304 */, customerRef: z.string().nullable(), orderDate: z.string().nullable(), lines: z.number(), pieces: z.number() })
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
  order: z.object({ id: z.string(), number: z.string(), yourNumber: ownNumber /* B-TH-304 */, customerRef: z.string().nullable(), orderDate: z.string().nullable() }),
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

// ---- B-TH-287 (threads plan TH-9, N6; P-CUS-NEW.message-F02): the New order as an e-mail kept on the server — ONE draft per person
// (apps/factory-api platform/threads/drafts.ts, `GET|PUT|DELETE /portal/drafts/new-request`). The person comes from the session: the
// body names no person, party or company (W08, W37). Sending the request clears it in the send's own command.
export const serverDraftSchema = z.object({
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  audience: z.string().nullable(),
  body: z.string(),
  fields: z.record(z.string(), z.unknown()),
  attachments: z.array(z.object({ id: z.string() }).passthrough()),
  savedAt: z.string(),
  version: z.number().int(),
})
export type ServerDraftRead = z.infer<typeof serverDraftSchema>

const DRAFT_PATH = '/portal/drafts/new-request'

/** The person's New order draft on the server, or null: none. */
export const fetchNewRequestDraft = async (api: ApiClient, signal?: AbortSignal): Promise<ServerDraftRead | null> =>
  (await api.get(DRAFT_PATH, { schema: z.object({ draft: serverDraftSchema.nullable() }), signal })).draft

/** Saves it (the version last read: a newer one saved meanwhile in another tab is replaced, and `replacedNewer` says so). */
export const saveNewRequestDraft = (api: ApiClient, body: ServerDraftBody, idempotencyKey: string = newIdempotencyKey()): Promise<{ draft: ServerDraftRead; replacedNewer: boolean }> =>
  api.request('PUT', DRAFT_PATH, { body, schema: z.object({ draft: serverDraftSchema, replacedNewer: z.boolean() }), idempotencyKey })

/** Discards it (Discard draft; a save that landed after a send). */
export const discardNewRequestDraft = async (api: ApiClient, idempotencyKey: string = newIdempotencyKey()): Promise<void> => {
  await api.request('DELETE', DRAFT_PATH, { schema: z.object({ draft: z.null() }), idempotencyKey })
}
// ---- end B-TH-287
