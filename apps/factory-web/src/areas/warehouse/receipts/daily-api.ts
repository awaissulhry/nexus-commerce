import { z } from 'zod'
import { DIFFERENCES, GOODS_RECEIPT_STATUSES } from '@nexus/factory-domain/inventory/receipts/rules'
import { DISCREPANCY_KINDS, DISCREPANCY_STATUSES, type DiscrepancyKind, type SettleStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { IMPORT_STATUSES } from '@nexus/factory-domain/imports/job'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { putToStore, sha256Hex, storeUrl } from '../../../record-panels/store'

/**
 * Every call of the receipt's W2a parts (B-W2a-63 on B-W2a-31's API): the supplier's delivery note photo, the
 * discrepancies with their photos, the report to the supplier (its check, the PDF, the send), a tannery hide list's
 * totals, a claim from discrepancies (B-W2a-44's POST /purchasing/claims), and "Request from supplier" (a mail on the
 * receipt's thread through email out). Shapes mirror apps/factory-api modules/inventory/receipts/contract.ts and
 * platform/email-out/contract.ts, checked with zod (unknown fields dropped). The API's English (problems, messages,
 * the standard mail text it proposes) is never drawn as our words: the screens classify it by path and say their own.
 */

const uom = z.enum(UOMS)
const enc = encodeURIComponent
const receiptUrl = (id: string) => `/inventory/receipts/${enc(id)}`

// ---- discrepancies --------------------------------------------------------------------------------------------------------------

export const photoSchema = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string(), createdAt: z.string() })
export type StoredPhoto = z.infer<typeof photoSchema>

export const discrepancySchema = z.object({
  id: z.string(),
  receiptId: z.string(),
  seq: z.number(),
  status: z.enum(DISCREPANCY_STATUSES),
  kind: z.enum(DISCREPANCY_KINDS),
  reasonCode: z.string().nullable(),
  reason: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }).nullable(),
  receiptLine: z
    .object({
      id: z.string(),
      seq: z.number(),
      purchaseOrderLineId: z.string().nullable(),
      item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom }),
      colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
    })
    .nullable(),
  quantity: z.string().nullable(),
  uom: uom.nullable(),
  note: z.string().nullable(),
  sentAt: z.string().nullable(),
  sentById: z.string().nullable(),
  closedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  photos: z.array(photoSchema),
  claims: z.array(z.object({ id: z.string(), number: z.string(), status: z.string() })),
  version: z.number(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
})
export type Discrepancy = z.infer<typeof discrepancySchema>

const listSchema = z.object({ receiptId: z.string(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES), open: z.boolean(), discrepancies: z.array(discrepancySchema) })
export type DiscrepancyList = z.infer<typeof listSchema>

export function listDiscrepancies(api: ApiClient, receiptId: string, signal?: AbortSignal): Promise<DiscrepancyList> {
  return api.get(`${receiptUrl(receiptId)}/discrepancies`, { schema: listSchema, signal })
}

export interface DiscrepancyBody {
  kind?: DiscrepancyKind
  reasonCode?: string | null
  receiptLineId?: string | null
  quantity?: string | null
  uom?: string | null
  note?: string | null
}

const one = z.object({ discrepancy: discrepancySchema })

export function recordDiscrepancy(api: ApiClient, receiptId: string, body: DiscrepancyBody, idempotencyKey: string): Promise<Discrepancy> {
  return api.post(`${receiptUrl(receiptId)}/discrepancies`, { body, schema: one, idempotencyKey }).then((answer) => answer.discrepancy)
}

export function changeDiscrepancy(api: ApiClient, receiptId: string, id: string, body: DiscrepancyBody & { version: number }, idempotencyKey: string): Promise<Discrepancy> {
  return api.request('PATCH', `${receiptUrl(receiptId)}/discrepancies/${enc(id)}`, { body, schema: one, idempotencyKey }).then((answer) => answer.discrepancy)
}

export function removeDiscrepancy(api: ApiClient, receiptId: string, id: string, version: number, idempotencyKey: string): Promise<unknown> {
  return api.request('DELETE', `${receiptUrl(receiptId)}/discrepancies/${enc(id)}`, { query: { version }, schema: z.object({ removed: z.object({ id: z.string(), seq: z.number() }) }), idempotencyKey })
}

export function settleDiscrepancy(api: ApiClient, receiptId: string, id: string, body: { version: number; to: SettleStatus; note?: string | null }, idempotencyKey: string): Promise<Discrepancy> {
  return api.post(`${receiptUrl(receiptId)}/discrepancies/${enc(id)}/status`, { body, schema: one, idempotencyKey }).then((answer) => answer.discrepancy)
}

// ---- photos (the DDT's and a discrepancy's): announce → the bytes to the store → complete -------------------------------------

const uploadAnswer = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

async function uploadPhoto(api: ApiClient, path: string, photo: Blob, name: string): Promise<string> {
  const bytes = await photo.arrayBuffer()
  const announced = await api.post(path, { body: { originalName: name, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }, schema: uploadAnswer, idempotencyKey: newIdempotencyKey() })
  await putToStore(announced.upload, bytes)
  await api.post(`${path}/${enc(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string() }) }), idempotencyKey: newIdempotencyKey() })
  return announced.file.id
}

/** The supplier's delivery note photo (SCM-115): a PHOTO of the receipt (office: files.upload + inventory.receive). */
export const uploadDdtPhoto = (api: ApiClient, receiptId: string, photo: Blob, name: string) => uploadPhoto(api, `${receiptUrl(receiptId)}/ddt-photos`, photo, name)

/** A photo of a discrepancy (inventory.discrepancies.manage + files.upload; not once it is closed). */
export const uploadDiscrepancyPhoto = (api: ApiClient, receiptId: string, discrepancyId: string, photo: Blob, name: string) => uploadPhoto(api, `${receiptUrl(receiptId)}/discrepancies/${enc(discrepancyId)}/photos`, photo, name)

/** A stored photo's address for an <img> (the presigned GET lives 60 seconds; a local store goes through this app's /api). */
export async function photoAddress(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<string> {
  const answer = await api.get(`/files/${enc(fileId)}/download`, { schema: z.object({ download: presignedSchema }), signal })
  return storeUrl(answer.download.url)
}

// ---- the report to the supplier -----------------------------------------------------------------------------------------------

const recipientSchema = z.object({ contactId: z.string(), name: z.string(), email: z.string(), roles: z.array(z.string()), language: z.string().nullable(), suggested: z.boolean() })
export type Recipient = z.infer<typeof recipientSchema>

const checkSchema = z.object({
  ready: z.boolean(),
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
  discrepancyIds: z.array(z.string()),
  sendsIds: z.array(z.string()),
  recipients: z.array(recipientSchema),
  language: z.enum(['it', 'en']),
  subject: z.string(),
  message: z.string(),
})
export type ReportCheck = z.infer<typeof checkSchema>

const idsQuery = (ids: readonly string[] | null) => (ids && ids.length > 0 ? ids.join(',') : undefined)

export function reportCheck(api: ApiClient, receiptId: string, ids: readonly string[] | null, signal?: AbortSignal): Promise<ReportCheck> {
  return api.get(`${receiptUrl(receiptId)}/discrepancy-report/check`, { query: { ids: idsQuery(ids) }, schema: checkSchema, signal })
}

/** The report's PDF as it will leave (marked as a preview, stored nowhere), for the send dialog's viewer. */
export function reportPreviewBytes(api: ApiClient, receiptId: string, ids: readonly string[] | null, language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${receiptUrl(receiptId)}/discrepancy-report`, { query: { ids: idsQuery(ids), language }, signal })
}

/** The same PDF in a new tab (design tab rc-tab-disc "Discrepancy report PDF"): the browser's own GET through /api. */
export function reportHref(receiptId: string, ids: readonly string[] | null, language?: 'it' | 'en'): string {
  const query = new URLSearchParams()
  const list = idsQuery(ids)
  if (list) query.set('ids', list)
  if (language) query.set('language', language)
  const qs = query.toString()
  return `/api${receiptUrl(receiptId)}/discrepancy-report${qs ? `?${qs}` : ''}`
}

export interface ReportBody {
  discrepancyIds?: string[]
  contactIds: string[]
  cc?: string[]
  subject?: string | null
  message?: string | null
  language?: 'it' | 'en'
}

const sentSchema = z.object({
  report: z.object({ documentFileId: z.string(), fileName: z.string(), emailId: z.string(), threadId: z.string(), to: z.array(z.string()), cc: z.array(z.string()), language: z.enum(['it', 'en']), sentAt: z.string(), discrepancyIds: z.array(z.string()), sentIds: z.array(z.string()) }),
  discrepancies: z.array(discrepancySchema),
})
export type ReportSent = z.infer<typeof sentSchema>

export function sendReport(api: ApiClient, receiptId: string, body: ReportBody, idempotencyKey: string): Promise<ReportSent> {
  return api.post(`${receiptUrl(receiptId)}/discrepancy-report`, { body, schema: sentSchema, idempotencyKey })
}

/** Where a mail of the receipt's thread is (the report's "result per recipient": one mail, its delivery state). */
const emailSchema = z.object({ id: z.string(), status: z.string(), to: z.array(z.string()), cc: z.array(z.string()), subject: z.string(), queuedAt: z.string(), sentAt: z.string().nullable(), deliveredAt: z.string().nullable(), bouncedAt: z.string().nullable(), failedAt: z.string().nullable() })
export type ThreadEmail = z.infer<typeof emailSchema>

export async function receiptEmails(api: ApiClient, receiptId: string, signal?: AbortSignal): Promise<ThreadEmail[]> {
  return (await api.get(`/threads/GoodsReceipt/${enc(receiptId)}/emails`, { query: { limit: 50 }, schema: z.object({ emails: z.array(emailSchema) }), signal })).emails
}

// ---- a claim from discrepancies (B-W2a-44) ------------------------------------------------------------------------------------

export interface ClaimFromBody {
  reasonCode: string
  reasonNote?: string | null
  remedy?: 'CREDIT' | 'REPLACEMENT' | null
  discrepancyIds: string[]
}

const claimSchema = z.object({ claim: z.object({ id: z.string(), number: z.string(), status: z.string() }) })

/** A claim for credit or replacement (kind CLAIM, a DRAFT) from discrepancies of this receipt: one line each. */
export function claimFromDiscrepancies(api: ApiClient, body: ClaimFromBody, idempotencyKey: string): Promise<{ id: string; number: string; status: string }> {
  return api
    .post('/purchasing/claims', { body: { kind: 'CLAIM', reasonCode: body.reasonCode, reasonNote: body.reasonNote ?? null, remedy: body.remedy ?? 'CREDIT', from: { discrepancyIds: body.discrepancyIds } }, schema: claimSchema, idempotencyKey })
    .then((answer) => answer.claim)
}

// ---- "Request from supplier": the supplier's contacts and a mail on the receipt's thread -------------------------------------

const contactSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable(), status: z.string() })
export type SupplierContact = z.infer<typeof contactSchema>

/** The supplier's active contacts with an e-mail (parties.view), quality people first, then the order desk. */
export async function supplierContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<SupplierContact[]> {
  const answer = await api.get(`/parties/${enc(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactSchema) }) }), signal })
  const rank = (contact: SupplierContact) => (contact.roles.includes('QUALITY') ? 0 : contact.roles.includes('ORDERS') ? 1 : 2)
  return answer.party.contacts.filter((contact) => contact.status === 'ACTIVE' && !!contact.email).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** A mail to the supplier on the receipt's thread (email.send; the worker delivers it, FAKE SES off Railway). */
export function sendRequestMail(api: ApiClient, receiptId: string, body: { to: string[]; subject: string; body: string; locale: 'it' | 'en' }, idempotencyKey: string): Promise<{ emailId: string }> {
  return api
    .post(`/threads/GoodsReceipt/${enc(receiptId)}/emails`, { body, schema: z.object({ messageId: z.string(), email: z.object({ id: z.string() }) }), idempotencyKey })
    .then((answer) => ({ emailId: answer.email.id }))
}

// ---- a tannery hide list's totals (SCM-248) --------------------------------------------------------------------------------------

const hideListSchema = z.object({
  importId: z.string(),
  status: z.enum(IMPORT_STATUSES),
  counts: z.object({ rows: z.number(), toReceive: z.number(), receivedBefore: z.number(), errors: z.number() }),
  order: z.object({ id: z.string(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES), siteId: z.string() }).nullable(),
  lines: z.array(
    z.object({
      purchaseOrderLineId: z.string(),
      seq: z.number(),
      itemCode: z.string(),
      baseUom: uom,
      hides: z.number(),
      lots: z.number(),
      baseArea: z.string(),
      expected: z.string(),
      receivedBefore: z.string(),
      after: z.string(),
      difference: z.string(),
      tolerancePct: z.string(),
      upTo: z.string(),
      kind: z.enum(DIFFERENCES),
      needsReason: z.boolean(),
    }),
  ),
  receipt: z.object({ id: z.string(), number: z.string(), status: z.enum(GOODS_RECEIPT_STATUSES) }).nullable(),
})
export type HideListSummary = z.infer<typeof hideListSchema>

export function hideListSummary(api: ApiClient, importId: string, signal?: AbortSignal): Promise<HideListSummary> {
  return api.get(`/inventory/receipts/hide-lists/${enc(importId)}`, { schema: hideListSchema, signal })
}

export type { Presigned }
