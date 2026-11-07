import { z } from 'zod'
import { PPE_CATEGORIES, PPE_ISSUE_REASONS, PPE_ITEM_STATUSES, PPE_RECEIPT_METHODS, RECEIPT_STATES, type PpeCategory, type PpeIssueReason } from '@nexus/factory-domain/safety/ppe/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { completeUpload, downloadLink, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Plant › Health & safety › PPE for workers (SCR-211; B-W2b-147 on the API of B-W2b-134, apps/factory-api
 * modules/safety/ppe): the tiles, the four lenses (who lacks what, every issue and its receipt, the role kits, the catalogue),
 * one receipt and its PDF, a person's PPE card, and the writes (a paper receipt, a void, keeping a PIN receipt's PDF, the
 * catalogue's items). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). Reading
 * is safety.view; the catalogue's writes safety.ppe.manage; a paper receipt, a void and a kept PDF safety.ppe.issue — each
 * with its own Idempotency-Key, an item at the version read. The only money is an item's unit cost (the cost grain: the API
 * leaves the key out without it, and refuses it in a request). The API's English is never shown: the screens say their own
 * words from the codes.
 */

const seg = (value: string) => encodeURIComponent(value)
const codeName = z.object({ code: z.string(), name: z.string() })
const names = z.record(z.string(), z.string()).nullable()
const lawSchema = z.object({ issue: z.string(), receipt: z.string(), catalogue: z.string(), categoryIII: z.string() })
export type PpeLaw = z.infer<typeof lawSchema>
const person = z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable() })

// ---- the catalogue ----------------------------------------------------------------------------------------------------------

export const itemSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  category: z.enum(PPE_CATEGORIES),
  standard: z.string().nullable(),
  sizes: z.array(z.string()),
  lifeMonths: z.number().nullable(),
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  /** Minor units; absent without the cost grain. */
  unitCost: z.number().nullable().optional(),
  status: z.enum(PPE_ITEM_STATUSES),
  note: z.string().nullable(),
  inKits: z.number(),
  issued: z.number(),
  version: z.number(),
  updatedAt: z.string(),
  canManage: z.boolean(),
})
export type PpeItem = z.infer<typeof itemSchema>

const itemsAnswer = z.object({ items: z.array(itemSchema), complete: z.boolean(), canAdd: z.boolean(), law: lawSchema })
export type ItemsAnswer = z.infer<typeof itemsAnswer>

const itemRecordAnswer = z.object({ item: itemSchema, kits: z.array(z.object({ roleSheetId: z.string(), code: z.string(), name: z.string(), site: codeName, quantity: z.number(), whenToWear: z.string() })), law: lawSchema })
export type ItemRecord = z.infer<typeof itemRecordAnswer>

// ---- gaps, kits, counts, the person -----------------------------------------------------------------------------------------

export const gapLineSchema = z.object({
  ppeItemId: z.string(),
  item: z.object({ code: z.string(), name: z.string(), nameI18n: names, category: z.string(), sizes: z.array(z.string()), status: z.string() }),
  quantity: z.number(),
  held: z.number(),
  missing: z.number(),
  replace: z.number(),
  whenToWear: z.string(),
})
export type GapLine = z.infer<typeof gapLineSchema>

const roleRef = z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable()

export const gapRowSchema = z.object({
  employee: person,
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  role: roleRef,
  lines: z.array(gapLineSchema),
  missing: z.number(),
  replace: z.number(),
  lastIssueAt: z.string().nullable(),
  canIssue: z.boolean(),
})
export type GapRow = z.infer<typeof gapRowSchema>

const gapsAnswer = z.object({ people: z.array(gapRowSchema), complete: z.boolean(), withoutRole: z.number(), today: z.string(), law: lawSchema })
export type GapsAnswer = z.infer<typeof gapsAnswer>

const countsAnswer = z.object({ peopleMissingKit: z.number(), receiptsNotSigned: z.number(), replacementsDue: z.number(), itemsBelowMinimum: z.null(), complete: z.boolean(), today: z.string() })
export type CountsAnswer = z.infer<typeof countsAnswer>

const kitsAnswer = z.object({
  roles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string(), siteId: z.string(), site: codeName, people: z.number() })),
  items: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, category: z.string(), status: z.string() })),
  cells: z.array(z.object({ roleSheetId: z.string(), ppeItemId: z.string(), quantity: z.number(), whenToWear: z.string() })),
  complete: z.boolean(),
})
export type KitsAnswer = z.infer<typeof kitsAnswer>
export type KitRole = KitsAnswer['roles'][number]

// ---- issues and receipts ----------------------------------------------------------------------------------------------------

const issuedBy = z.object({ kind: z.enum(['USER', 'WORKER', 'NONE']), name: z.string().nullable(), hidden: z.boolean() })
const deviceRef = z.object({ id: z.string(), name: z.string() }).nullable()

export const issueLineSchema = z.object({
  id: z.string(),
  receiptId: z.string(),
  issuedAt: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  employee: person,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, category: z.string() }),
  size: z.string().nullable(),
  quantity: z.number(),
  reason: z.enum(PPE_ISSUE_REASONS),
  method: z.enum(PPE_RECEIPT_METHODS),
  issuedBy,
  receipt: z.object({ id: z.string(), state: z.enum(RECEIPT_STATES), scanFileId: z.string().nullable(), documentFileId: z.string().nullable() }),
  device: deviceRef,
  voided: z.object({ voidId: z.string(), at: z.string(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  canVoid: z.boolean(),
})
export type IssueLine = z.infer<typeof issueLineSchema>

const keptDocument = z.object({ id: z.string(), version: z.number(), language: z.string(), fileId: z.string(), createdAt: z.string() })
export type KeptDocument = z.infer<typeof keptDocument>

export const receiptSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  employee: person,
  issuedAt: z.string(),
  method: z.enum(PPE_RECEIPT_METHODS),
  state: z.enum(RECEIPT_STATES),
  issuedBy,
  signature: z.object({ workerId: z.string(), worker: z.string().nullable(), device: deviceRef, sha256: z.string() }).nullable(),
  scan: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  document: keptDocument.nullable(),
  lines: z.array(issueLineSchema),
  units: z.number(),
  canIssue: z.boolean(),
})
export type Receipt = z.infer<typeof receiptSchema>

const issuesAnswer = z.object({ issues: z.array(issueLineSchema), complete: z.boolean(), law: lawSchema })
export type IssuesAnswer = z.infer<typeof issuesAnswer>

const receiptAnswer = z.object({ receipt: receiptSchema, statement: z.string().nullable(), verified: z.boolean(), law: lawSchema })
export type ReceiptAnswer = z.infer<typeof receiptAnswer>

const cardAnswer = z.object({
  employee: z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable(), status: z.string(), companyId: z.string(), siteId: z.string(), site: codeName }),
  role: roleRef,
  kit: z.array(gapLineSchema),
  receipts: z.array(receiptSchema),
  returned: z.object({ caseId: z.string(), status: z.string(), doneAt: z.string().nullable(), issueId: z.string().nullable() }).nullable(),
  canIssue: z.boolean(),
  today: z.string(),
  law: lawSchema,
})
export type PersonCard = z.infer<typeof cardAnswer>

// ---- reads ------------------------------------------------------------------------------------------------------------------

const place = (siteId: string | null) => (siteId ? { siteId } : {})

/** GET /safety/ppe/counts (safety.view): the tiles. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/ppe/counts', { query: place(siteId), schema: countsAnswer, signal })

export interface GapsQuery {
  readonly siteId: string | null
  readonly view: 'missing' | 'all'
  readonly roleSheetId?: string | null | undefined
  readonly q?: string | null | undefined
}

/** GET /safety/ppe/gaps (safety.view): each person against their role's kit (`all`: everyone, every kit line). */
export const readGaps = (api: ApiClient, query: GapsQuery, signal?: AbortSignal) =>
  api.get('/safety/ppe/gaps', { query: { ...place(query.siteId), view: query.view, ...(query.roleSheetId ? { roleSheetId: query.roleSheetId } : {}), ...(query.q ? { q: query.q } : {}) }, schema: gapsAnswer, signal })

/** GET /safety/ppe/kits (safety.view): roles × items, read here (edited in the role sheet). */
export const readKits = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/ppe/kits', { query: place(siteId), schema: kitsAnswer, signal })

export interface IssuesQuery {
  readonly siteId: string | null
  readonly view: 'all' | 'notSigned' | 'voided'
  readonly employeeId?: string | null | undefined
  readonly ppeItemId?: string | null | undefined
  readonly from?: string | null | undefined
  readonly to?: string | null | undefined
}

/** GET /safety/ppe/issues (safety.view): one row per line handed over, newest first (500 at most). */
export const readIssues = (api: ApiClient, query: IssuesQuery, signal?: AbortSignal) =>
  api.get('/safety/ppe/issues', {
    query: {
      ...place(query.siteId),
      view: query.view,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.ppeItemId ? { ppeItemId: query.ppeItemId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    },
    schema: issuesAnswer,
    signal,
  })

/** GET /safety/ppe/items (safety.view): the company's catalogue. */
export const readItems = (api: ApiClient, query: { readonly status: 'ACTIVE' | 'ARCHIVED' | 'all'; readonly q?: string | null | undefined }, signal?: AbortSignal) =>
  api.get('/safety/ppe/items', { query: { status: query.status, ...(query.q ? { q: query.q } : {}) }, schema: itemsAnswer, signal })

/** GET /safety/ppe/items/:id (safety.view): one item and the ACTIVE role kits that name it. */
export const readItem = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/ppe/items/${seg(id)}`, { schema: itemRecordAnswer, signal })

/** GET /safety/ppe/receipts/:id (safety.view): any row id → its receipt; a PIN receipt `verified` with the statement it signed. */
export const readReceipt = (api: ApiClient, receiptId: string, signal?: AbortSignal) => api.get(`/safety/ppe/receipts/${seg(receiptId)}`, { schema: receiptAnswer, signal })

/** GET /safety/ppe/receipts/:id/pdf?language= (safety.view): the receipt's PDF made in memory, stored nowhere (a preview banner). */
export const receiptPdf = (api: ApiClient, receiptId: string, language: 'it' | 'en', signal?: AbortSignal) => api.bytes(`/safety/ppe/receipts/${seg(receiptId)}/pdf`, { query: { language }, signal })

/** GET /safety/ppe/people/:employeeId (safety.view): the person's PPE card. */
export const readCard = (api: ApiClient, employeeId: string, signal?: AbortSignal) => api.get(`/safety/ppe/people/${seg(employeeId)}`, { schema: cardAnswer, signal })

export interface Supplier {
  readonly id: string
  readonly code: string
  readonly name: string
}

/**
 * The suppliers a PPE item may name. The PPE API has no choices route: the chemical register's (GET /safety/chemicals/choices
 * ?siteId, safety.chemicals.manage — the safety officer's) offers the active suppliers of the company and the group, which the
 * PPE API takes (it refuses a supplier it does not, SUPPLIER_NOT_FOUND, said at the field).
 */
export const readSuppliers = async (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Supplier[]> =>
  (await api.get('/safety/chemicals/choices', { query: { siteId }, schema: z.object({ suppliers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })) }), signal })).suppliers

/** GET /files/:id/download (files.read): a stored file's 60-second address (the paper scan, a kept PDF). */
export const fileAddress = async (api: ApiClient, fileId: string): Promise<string> => (await downloadLink(api, fileId)).download.url

// ---- writes -----------------------------------------------------------------------------------------------------------------

export interface ItemBody {
  name: string
  nameI18n: Record<string, string> | null
  category: PpeCategory
  standard: string | null
  sizes: string[]
  lifeMonths: number | null
  supplierPartyId: string | null
  /** Sent only with the cost grain (the API refuses it otherwise). */
  unitCost?: number | null
  note: string | null
}

const itemAnswer = z.object({ item: itemSchema })

/** POST /safety/ppe/items (safety.ppe.manage). */
export const addItem = async (api: ApiClient, body: ItemBody & { companyId: string; code: string }, idempotencyKey: string) => (await api.post('/safety/ppe/items', { body, schema: itemAnswer, idempotencyKey })).item

/** PATCH /safety/ppe/items/:id (safety.ppe.manage), at the version read; the code and the company never change. */
export const editItem = (api: ApiClient, id: string, body: ItemBody & { version: number }, idempotencyKey: string) =>
  api.request('PATCH', `/safety/ppe/items/${seg(id)}`, { body, schema: z.object({ item: itemSchema, changed: z.boolean() }), idempotencyKey })

/** POST /safety/ppe/items/:id/archive | restore (safety.ppe.manage). */
export const setItemStatus = async (api: ApiClient, id: string, to: 'archive' | 'restore', version: number, idempotencyKey: string) =>
  (await api.post(`/safety/ppe/items/${seg(id)}/${to}`, { body: { version }, schema: itemAnswer, idempotencyKey })).item

/** POST /safety/ppe/items/common (safety.ppe.manage): "Start from common items" — the ones the company has none of yet. */
export const addCommonItems = (api: ApiClient, companyId: string, idempotencyKey: string) =>
  api.post('/safety/ppe/items/common', { body: { companyId }, schema: z.object({ items: z.array(itemSchema), added: z.number(), skipped: z.array(z.string()) }), idempotencyKey })

export interface IssueLineBody {
  ppeItemId: string
  size: string | null
  quantity: number
  reason: PpeIssueReason
}

const issuedAnswer = z.object({ receipt: receiptSchema, scan: z.object({ recordType: z.literal('PpeIssue'), recordId: z.string(), companyId: z.string() }) })
export type IssuedAnswer = z.infer<typeof issuedAnswer>

/** POST /safety/ppe/issues (safety.ppe.issue): a paper receipt — one command, the lines handed to one person. */
export const issueOnPaper = (api: ApiClient, body: { employeeId: string; lines: IssueLineBody[]; issuedAt?: string }, idempotencyKey: string) => api.post('/safety/ppe/issues', { body, schema: issuedAnswer, idempotencyKey })

/** POST /safety/ppe/issues/:issueId/void (safety.ppe.issue): a VOID row with the reason; the receipt stays, marked void. */
export const voidIssue = async (api: ApiClient, issueId: string, reason: string, idempotencyKey: string) =>
  (await api.post(`/safety/ppe/issues/${seg(issueId)}/void`, { body: { reason }, schema: z.object({ receipt: receiptSchema }), idempotencyKey })).receipt

/** POST /safety/ppe/receipts/:id/pdf (safety.ppe.issue): keep a PIN receipt's PDF (the same contents give the same version back). */
export const keepReceipt = (api: ApiClient, receiptId: string, language: 'it' | 'en', idempotencyKey: string) =>
  api.post(`/safety/ppe/receipts/${seg(receiptId)}/pdf`, { body: { language }, schema: z.object({ document: keptDocument, made: z.boolean() }), idempotencyKey })

/**
 * The signed paper's scan onto its receipt, through the generic files routes (files.upload): announced as a DOCUMENT of the
 * PpeIssue the receipt answer names (office only), its bytes sent to the store, confirmed. AVAILABLE makes the receipt
 * SIGNED_PAPER; a QUARANTINED file does not (the answer's status says which).
 */
export async function uploadScan(api: ApiClient, scan: { recordId: string; companyId: string }, file: File): Promise<{ status: string }> {
  const bytes = await file.arrayBuffer()
  const announced = await requestUpload(api, {
    companyId: scan.companyId,
    record: { type: 'PpeIssue', id: scan.recordId },
    kind: 'DOCUMENT',
    name: file.name || 'ricevuta-dpi.pdf',
    contentType: file.type || 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(announced.upload, bytes)
  return (await completeUpload(api, announced.file.id)).file
}

export { newIdempotencyKey }
