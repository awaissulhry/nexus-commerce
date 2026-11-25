import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { ServerDraftBody } from '../../../lib/request-compose/server-draft' // B-TH-287
// od-w1.1: the draft order's record is the ONE shape both doors read (src/lib/order-draft/schema.ts); the portal's fetchers stay here.
import type { OrderDraftPort } from '../../../lib/order-draft/api-port'
import { draftFileSchema, named, noticeSchema, ownNumber, pair, presignedSchema, recordSchema, sizeRow, SOURCES, STATUSES, type CustomLineFields, type CustomLineKind, type DraftFile, type DraftFileAnnounce, type DraftRecord, type HeaderBody, type NewLine, type PersonFields, type RequestSource, type SizeAsk } from '../../../lib/order-draft/schema'
export * from '../../../lib/order-draft/schema'

/**
 * New order & reorder in the portal (apps/factory-api modules/sales/portal-ordering, B-W2b-190; SAL-072, SAL-073, SAL-074;
 * design portal.customer.neworder, SCR-185): the customer's draft request kept on the server (`?draft=<id>`), its header,
 * lines with their size runs, a past order copied at today's prices, a sheet read with a dry run, the send. Every write
 * carries the request's `version` (409 when someone changed it) and an Idempotency-Key. Prices are decimal strings that
 * come ONLY with the price grain. The API's English and Italian sentences (`words`, `held`, `notice`, a problem's or a
 * notice's words, the send's words) are dropped: the page says everything from codes and figures in its own words. A
 * sheet row's reasons have no code: they are kept as the pair the domain wrote (`reasons`), shown in the page's language.
 */


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


const path = (id: string) => `/portal/order-requests/${encodeURIComponent(id)}`

export const createDraft = (api: ApiClient, body: { source: RequestSource } & HeaderBody, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post('/portal/order-requests', { body, schema: recordSchema, idempotencyKey })

export const fetchDraft = (api: ApiClient, id: string, signal?: AbortSignal): Promise<DraftRecord> => api.get(path(id), { schema: recordSchema, signal })

export const changeHeader = (api: ApiClient, id: string, body: { version: number } & HeaderBody, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PATCH', path(id), { body, schema: recordSchema, idempotencyKey })


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

export const addCustomLine = (api: ApiClient, id: string, body: { version: number; line: { kind: CustomLineKind } & CustomLineFields }, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/custom-lines`, { body, schema: recordSchema, idempotencyKey })

export const changeCustomLine = (api: ApiClient, id: string, lineId: string, body: { version: number } & CustomLineFields, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('PUT', `${path(id)}/custom-lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey })


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

export const announceDraftFile = (api: ApiClient, id: string, body: DraftFileAnnounce, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`${path(id)}/files`, { body, schema: z.object({ file: draftFileSchema, upload: presignedSchema }), idempotencyKey })

export const completeDraftFile = (api: ApiClient, id: string, fileId: string, idempotencyKey: string = newIdempotencyKey()): Promise<DraftFile> =>
  api.post(`${path(id)}/files/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: draftFileSchema }), idempotencyKey }).then((answer) => answer.file)

export const removeDraftFile = (api: ApiClient, id: string, fileId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.request('DELETE', `${path(id)}/files/${encodeURIComponent(fileId)}`, { query: { version }, schema: recordSchema, idempotencyKey })
// ---- end F-CP-151

// ---- od-w1.1 (THE SIMPLE ORDER START): the portal's door to the ONE draft order's commands (lib/order-draft/api-port.ts) — the same
// draft commands the office calls on its own routes; here on the session's party.
export const portalDraftPort = (api: ApiClient): OrderDraftPort => ({
  read: (id, signal) => fetchDraft(api, id, signal),
  header: (id, body, idempotencyKey) => changeHeader(api, id, body, idempotencyKey),
  changeLine: (id, lineId, body, idempotencyKey) => changeLine(api, id, lineId, body, idempotencyKey),
  removeLine: (id, lineId, version, idempotencyKey) => removeLine(api, id, lineId, version, idempotencyKey),
  addCustomLine: (id, body, idempotencyKey) => addCustomLine(api, id, body, idempotencyKey),
  changeCustomLine: (id, lineId, body, idempotencyKey) => changeCustomLine(api, id, lineId, body, idempotencyKey),
  addPeople: (id, lineId, body, idempotencyKey) => addPeople(api, id, lineId, body, idempotencyKey),
  changePerson: (id, lineId, personId, body, idempotencyKey) => changePerson(api, id, lineId, personId, body, idempotencyKey),
  removePerson: (id, lineId, personId, version, idempotencyKey) => removePerson(api, id, lineId, personId, version, idempotencyKey),
  announceFile: (id, body, idempotencyKey) => announceDraftFile(api, id, body, idempotencyKey),
  completeFile: (id, fileId, idempotencyKey) => completeDraftFile(api, id, fileId, idempotencyKey),
  removeFile: (id, fileId, version, idempotencyKey) => removeDraftFile(api, id, fileId, version, idempotencyKey),
})
// ---- end od-w1.1

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
