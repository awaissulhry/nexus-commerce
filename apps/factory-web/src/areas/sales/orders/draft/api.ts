import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { MarkablePart, OrderDraftPort } from '../../../../lib/order-draft/api-port'
import { draftFileSchema, presignedSchema, recordSchema, type CustomLineFields, type CustomLineKind, type DraftFile, type DraftFileAnnounce, type DraftRecord, type HeaderBody, type PersonFields } from '../../../../lib/order-draft/schema'

/**
 * The office's door to the ONE draft order (THE SIMPLE ORDER START, od-w2.1; 13-backend § 4): the SAME draft commands the portal calls,
 * on `/sales/order-requests/:id/…` — each answers the draft's record (the portal's shape, grain-filtered). The handler checks
 * `orders.manage` (reads: `orders.view`) over the company and THAT draft's customer first (404 out of reach: the brand wall); a body
 * names no party. The start names the customer (`partyId`, one only); the office read (`GET …/:id`) adds the draft's customer, the styles
 * made for it and what this reader may do (Confirm, Make style draft). `…/confirm` = send (if still a draft) + the existing accept.
 */

const path = (id: string) => `/sales/order-requests/${encodeURIComponent(id)}`

export const officeDraftPort = (api: ApiClient): OrderDraftPort => ({
  read: (id, signal) => api.get(`${path(id)}/draft`, { schema: recordSchema, signal }),
  header: (id, body, idempotencyKey) => api.request('PATCH', path(id), { body, schema: recordSchema, idempotencyKey }),
  changeLine: (id, lineId, body, idempotencyKey) => api.request('PUT', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey }),
  removeLine: (id, lineId, version, idempotencyKey) => api.request('DELETE', `${path(id)}/lines/${encodeURIComponent(lineId)}`, { query: { version }, schema: recordSchema, idempotencyKey }),
  addCustomLine: (id, body: { version: number; line: { kind: CustomLineKind } & CustomLineFields }, idempotencyKey) => api.post(`${path(id)}/custom-lines`, { body, schema: recordSchema, idempotencyKey }),
  changeCustomLine: (id, lineId, body, idempotencyKey) => api.request('PUT', `${path(id)}/custom-lines/${encodeURIComponent(lineId)}`, { body, schema: recordSchema, idempotencyKey }),
  addPeople: (id, lineId, body: { version: number; people: PersonFields[] }, idempotencyKey) => api.post(`${path(id)}/lines/${encodeURIComponent(lineId)}/people`, { body, schema: recordSchema, idempotencyKey }),
  changePerson: (id, lineId, personId, body, idempotencyKey) => api.request('PUT', `${path(id)}/lines/${encodeURIComponent(lineId)}/people/${encodeURIComponent(personId)}`, { body, schema: recordSchema, idempotencyKey }),
  removePerson: (id, lineId, personId, version, idempotencyKey) => api.request('DELETE', `${path(id)}/lines/${encodeURIComponent(lineId)}/people/${encodeURIComponent(personId)}`, { query: { version }, schema: recordSchema, idempotencyKey }),
  announceFile: (id, body: DraftFileAnnounce, idempotencyKey) => api.post(`${path(id)}/files`, { body, schema: z.object({ file: draftFileSchema, upload: presignedSchema }), idempotencyKey }),
  completeFile: (id, fileId, idempotencyKey): Promise<DraftFile> => api.post(`${path(id)}/files/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: draftFileSchema }), idempotencyKey }).then((answer) => answer.file),
  removeFile: (id, fileId, version, idempotencyKey) => api.request('DELETE', `${path(id)}/files/${encodeURIComponent(fileId)}`, { query: { version }, schema: recordSchema, idempotencyKey }),
  markFile: (id, fileId, body: { version: number; part: MarkablePart }, idempotencyKey) => api.request('PATCH', `${path(id)}/files/${encodeURIComponent(fileId)}`, { body, schema: recordSchema, idempotencyKey }),
})

/** The office start: ONE customer and what was typed first (the mail's subject and message); nothing else is needed. */
export const createOfficeDraft = (api: ApiClient, body: { companyId: string; partyId: string } & HeaderBody, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post('/sales/order-requests', { body, schema: recordSchema, idempotencyKey })

/** The office read's own facts (the host cards): the draft's customer, the styles made for it, what this reader may do. */
const officeReadSchema = z.object({
  request: z.object({
    id: z.string(),
    party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
    styles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string() })).optional().catch(undefined),
  }),
  may: z.object({ order: z.boolean(), quote: z.boolean(), confirm: z.boolean().optional(), styleDraft: z.boolean().optional() }),
})
export type OfficeRead = z.infer<typeof officeReadSchema>

export const readOfficeRequest = (api: ApiClient, id: string, signal?: AbortSignal): Promise<OfficeRead> => api.get(path(id), { schema: officeReadSchema, signal })

/** One row of the Confirm window's map: a row of the draft into a style line (its style, colourway, pieces by size, price). */
export interface ConfirmInto {
  styleId: string
  colourwayId: string
  sizes?: { size: string; quantity: number }[]
  unitPrice?: string
}

/** today's accept body (`POST …/confirm` = send if still a draft + accept): as ORDER or QUOTE, the rows mapped, the prices typed. */
export interface ConfirmBody {
  version: number
  as: 'ORDER' | 'QUOTE'
  promiseDate?: string | null
  lines?: { lineId: string; unitPrice: string }[]
  map?: { lineId: string; into: ConfirmInto[] }[]
}

const confirmAnswer = z.object({ made: z.object({ as: z.enum(['ORDER', 'QUOTE']), salesOrderId: z.string().nullable(), quoteId: z.string().nullable(), number: z.string() }) })
export type ConfirmAnswer = z.infer<typeof confirmAnswer>

export const confirmDraft = (api: ApiClient, id: string, body: ConfirmBody, idempotencyKey: string = newIdempotencyKey()): Promise<ConfirmAnswer> =>
  api.post(`${path(id)}/confirm`, { body, schema: confirmAnswer, idempotencyKey })

/** Make style draft on the open draft: the Inquiry's body; the brand is the DRAFT's customer (never one the body names). */
export const makeDraftStyle = (api: ApiClient, id: string, body: { version: number; code: string; name?: string; productType: string; sizeScaleId?: string; season?: string; fileIds: string[] }, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`${path(id)}/style-draft`, { body, schema: z.object({ styleId: z.string(), code: z.string(), version: z.number() }), idempotencyKey })
