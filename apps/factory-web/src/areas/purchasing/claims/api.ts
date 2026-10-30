import { z } from 'zod'
import { CLAIM_FOUND_AT, CLAIM_KINDS, CLAIM_OUTCOMES, CLAIM_REMEDIES, CLAIM_STATUSES } from '@nexus/factory-domain/purchasing/claims/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { pickerReasons, type PickerReason } from '../../_shared/reasons/api'
import { listHides, listLots, lotRecord, type HideRow, type LotRecord, type LotRow } from '../../_shared/stock/api'

/**
 * Every call of Purchasing › Returns & claims (SCR-131; B-W2a-44's API, apps/factory-api modules/purchasing/claims), with
 * the answer's shape checked (zod; unknown fields are dropped). The value of the goods, the cost per unit and the credit
 * asked are costs: absent without money.cost (the API drops them), so they are optional here. The API's English (the
 * record's `actions`, a 409's sentence) is never drawn: model.ts says why an act is held from the claim's facts.
 * The Return to supplier dialog reads the warehouse's own lot and hide reads (areas/_shared/stock/api.ts) and the CLAIM
 * reason list (areas/_shared/reasons/api.ts).
 */

export { CLAIM_FOUND_AT, CLAIM_KINDS, CLAIM_OUTCOMES, CLAIM_REMEDIES, CLAIM_STATUSES }
export type ClaimKind = (typeof CLAIM_KINDS)[number]
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]
export type ClaimFoundAt = (typeof CLAIM_FOUND_AT)[number]
export type ClaimRemedy = (typeof CLAIM_REMEDIES)[number]
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number]

/** Who carries the goods of a return DDT (B-W2a-17's source request). */
export const TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransportBy = (typeof TRANSPORT_BY)[number]

const uom = z.enum(UOMS)
export type Uom = z.infer<typeof uom>
const ref = z.object({ id: z.string(), code: z.string() })
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const costAmount = z.number().nullable().optional()

const summary = {
  id: z.string(),
  number: z.string(),
  kind: z.enum(CLAIM_KINDS),
  status: z.enum(CLAIM_STATUSES),
  companyId: z.string(),
  site: ref,
  supplier: named,
  foundAt: z.enum(CLAIM_FOUND_AT),
  reason: z.object({ code: z.string().nullable(), labelEn: z.string().nullable(), labelIt: z.string().nullable(), note: z.string().nullable() }),
  remedy: z.enum(CLAIM_REMEDIES).nullable(),
  lots: z.array(ref),
  materials: z.array(named),
  quantity: z.object({ quantity: z.string(), uom }).nullable(),
  lines: z.number(),
  returned: z.number(),
  currency: z.string(),
  value: costAmount,
  expectedCreditAmount: costAmount,
  ageDays: z.number(),
  sentAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}
const rowSchema = z.object(summary)
export type ClaimRow = z.infer<typeof rowSchema>

const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: ref.nullable(),
  discrepancy: z.object({ id: z.string(), seq: z.number(), kind: z.string(), status: z.string(), receiptId: z.string() }).nullable(),
  receiptLineId: z.string().nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  reason: z.string().nullable(),
  unitCost: z.string().nullable().optional(),
  creditAmount: costAmount,
  move: z.object({ id: z.string(), reason: z.string(), occurredAt: z.string(), quantity: z.string(), uom, fromLocation: ref.nullable() }).nullable(),
  ddt: z.object({ id: z.string(), number: z.string(), cancelled: z.boolean() }).nullable(),
  liveDdt: z.object({ id: z.string(), number: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number(),
})
export type ClaimLine = z.infer<typeof lineSchema>

export const claimSchema = rowSchema.extend({
  goodsReceipt: z.object({ id: z.string(), number: z.string(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: z.string().nullable() }).nullable(),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  supplierAnswer: z.string().nullable(),
  closeNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  sentById: z.string().nullable(),
  createdById: z.string().nullable(),
  lines: z.array(lineSchema),
  ddts: z.array(z.object({ id: z.string(), number: z.string(), documentDate: z.string(), reason: z.string(), startAt: z.string(), cancelled: z.boolean(), lineIds: z.array(z.string()) })),
  credit: z.object({ currency: z.string(), remedy: z.enum(CLAIM_REMEDIES).nullable(), expected: costAmount, value: costAmount, matched: z.null(), difference: z.null() }),
  people: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type Claim = z.infer<typeof claimSchema>
const one = z.object({ claim: claimSchema })

const enc = (value: string) => encodeURIComponent(value)
type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

// ---- the list ------------------------------------------------------------------------------------------------------------------

export interface ClaimQuery {
  status?: ClaimStatus
  /** false: every state (the API's default is the open ones). */
  open?: boolean
  kind?: ClaimKind
  goodsReceiptId?: string
  lotId?: string
  q?: string
  cursor?: string
}

export function listClaims(api: ApiClient, query: ClaimQuery, signal?: AbortSignal): Promise<{ items: ClaimRow[]; nextCursor: string | null }> {
  return api.get('/purchasing/claims', {
    query: clean({ status: query.status, open: query.open === false ? 'false' : undefined, kind: query.kind, goodsReceiptId: query.goodsReceiptId, lotId: query.lotId, q: query.q?.trim(), cursor: query.cursor, limit: 50 }),
    schema: z.object({ items: z.array(rowSchema), nextCursor: z.string().nullable() }),
    signal,
  })
}

const countsSchema = z.object({ open: z.number(), waitingForSupplier: z.number(), creditExpected: z.number(), closedThisMonth: z.number() })
export type ClaimCounts = z.infer<typeof countsSchema>

export function claimCounts(api: ApiClient, signal?: AbortSignal): Promise<ClaimCounts> {
  return api.get('/purchasing/claims/counts', { schema: countsSchema, signal })
}

/** A receipt's number for the list's filter chip (inventory.stock.view; without it the chip says "this receipt"). */
export async function receiptNumber(api: ApiClient, receiptId: string, signal?: AbortSignal): Promise<string> {
  return (await api.get(`/inventory/receipts/${enc(receiptId)}`, { schema: z.object({ receipt: z.object({ number: z.string() }) }), signal })).receipt.number
}

// ---- the record --------------------------------------------------------------------------------------------------------------

export async function getClaim(api: ApiClient, id: string, signal?: AbortSignal): Promise<Claim> {
  return (await api.get(`/purchasing/claims/${enc(id)}`, { schema: one, signal })).claim
}

export interface ClaimPatch {
  version: number
  kind?: ClaimKind
  foundAt?: ClaimFoundAt
  reasonCode?: string
  reasonNote?: string | null
  remedy?: ClaimRemedy | null
  expectedCreditAmount?: number | null
  internalNote?: string | null
}

export async function updateClaim(api: ApiClient, id: string, body: ClaimPatch, idempotencyKey: string): Promise<Claim> {
  return (await api.request('PATCH', `/purchasing/claims/${enc(id)}`, { body, schema: one, idempotencyKey })).claim
}

export async function removeLine(api: ApiClient, id: string, lineId: string, version: number, idempotencyKey: string): Promise<Claim> {
  return (await api.request('DELETE', `/purchasing/claims/${enc(id)}/lines/${enc(lineId)}`, { query: { version }, schema: one, idempotencyKey })).claim
}

const recipientSchema = z.object({ contactId: z.string(), name: z.string(), email: z.string(), roles: z.array(z.string()), language: z.string().nullable(), suggested: z.boolean() })
export type Recipient = z.infer<typeof recipientSchema>
const sendCheckSchema = z.object({
  ready: z.boolean(),
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
  recipients: z.array(recipientSchema),
  language: z.enum(['it', 'en']),
  subject: z.string(),
  message: z.string(),
})
export type SendCheck = z.infer<typeof sendCheckSchema>

export function sendCheck(api: ApiClient, id: string, signal?: AbortSignal): Promise<SendCheck> {
  return api.get(`/purchasing/claims/${enc(id)}/send-check`, { schema: sendCheckSchema, signal })
}

export interface MailBody {
  contactIds: string[]
  cc?: string[]
  subject?: string | null
  message?: string | null
  language?: 'it' | 'en'
}

export interface SendBody {
  version: number
  remedy?: ClaimRemedy
  mail: MailBody | null
}

export async function sendClaim(api: ApiClient, id: string, body: SendBody, idempotencyKey: string): Promise<Claim> {
  return (await api.post(`/purchasing/claims/${enc(id)}/send`, { body, schema: z.object({ claim: claimSchema, emailId: z.string().nullable() }), idempotencyKey })).claim
}

export interface AnswerBody {
  version: number
  outcome: ClaimOutcome
  answer: string
  remedy?: ClaimRemedy
  expectedCreditAmount?: number | null
}

export async function answerClaim(api: ApiClient, id: string, body: AnswerBody, idempotencyKey: string): Promise<Claim> {
  return (await api.post(`/purchasing/claims/${enc(id)}/answer`, { body, schema: one, idempotencyKey })).claim
}

export async function closeClaim(api: ApiClient, id: string, version: number, note: string, idempotencyKey: string): Promise<Claim> {
  return (await api.post(`/purchasing/claims/${enc(id)}/close`, { body: { version, note }, schema: one, idempotencyKey })).claim
}

export async function cancelClaim(api: ApiClient, id: string, version: number, reason: string, idempotencyKey: string): Promise<Claim> {
  return (await api.post(`/purchasing/claims/${enc(id)}/cancel`, { body: { version, reason }, schema: one, idempotencyKey })).claim
}

// ---- goods back to the supplier ------------------------------------------------------------------------------------------------

/** The return DDT (B-W2a-17's source request without the version and lines): who carries the goods, packages, weight. */
export interface ReturnDdtRequest {
  reason: 'RETURN'
  transportBy: TransportBy
  carrier?: { name: string } | null
  appearance?: string | null
  packages: number
  grossWeightKg: string
  remarks?: string | null
}

const returnAnswerSchema = z.object({
  claim: claimSchema,
  moveIds: z.array(z.string()),
  ddt: z.object({ id: z.string(), number: z.string(), file: z.object({ id: z.string() }).nullable(), pdfProblem: z.string().nullable() }),
  claimLinesKeepingOldDdt: z.array(z.string()),
  overReserved: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable(), available: z.string(), reserved: z.string() })),
})
export type ReturnAnswer = z.infer<typeof returnAnswerSchema>

export interface ReturnGoodsBody {
  version: number
  lines?: { lineId: string }[]
  ddt: ReturnDdtRequest
}

export function returnGoods(api: ApiClient, id: string, body: ReturnGoodsBody, idempotencyKey: string): Promise<ReturnAnswer> {
  return api.post(`/purchasing/claims/${enc(id)}/return`, { body, schema: returnAnswerSchema, idempotencyKey })
}

export interface ReturnToSupplierBody {
  reasonCode: string
  reasonNote?: string | null
  remedy: ClaimRemedy
  from?: { lotId: string; hideIds?: string[] }
  lines?: { lotId: string; quantity: string; uom: Uom; fromLocationId: string }[]
  mail: MailBody | null
  ddt: ReturnDdtRequest
}

/** "Return to supplier" in ONE command: the claim made and sent, the goods out, the return DDT (POST /purchasing/claims/returns). */
export function returnToSupplier(api: ApiClient, body: ReturnToSupplierBody, idempotencyKey: string): Promise<ReturnAnswer> {
  return api.post('/purchasing/claims/returns', { body, schema: returnAnswerSchema, idempotencyKey })
}

/** The issued DDT's PDF: a presigned GET (files.read too); the page opens it in a new tab (a downloaded document). */
export async function ddtPdfLink(api: ApiClient, ddtId: string): Promise<Presigned> {
  return (await api.get(`/shipping/ddts/${enc(ddtId)}/pdf`, { schema: z.object({ download: presignedSchema }) })).download
}

// ---- reads for the dialogs -------------------------------------------------------------------------------------------------------

/** The CLAIM reason list (active reasons, tile order). */
export const claimReasons = (api: ApiClient, signal?: AbortSignal): Promise<PickerReason[]> => pickerReasons(api, ['CLAIM'], signal)
export type { PickerReason }

/** Lots in stock matching a search (the warehouse's own read, inventory.stock.view). */
export async function findLots(api: ApiClient, q: string, signal?: AbortSignal): Promise<LotRow[]> {
  return (await listLots(api, { q, inStock: true, limit: 8 }, signal)).lots
}
export type { HideRow, LotRecord, LotRow }

/** A lot's stock per place (and its record, the dialog's header). */
export const lotStock = (api: ApiClient, lotId: string, signal?: AbortSignal): Promise<LotRecord> => lotRecord(api, lotId, signal)

/** A leather lot's hides still in stock, one by one. */
export async function lotHides(api: ApiClient, lotId: string, signal?: AbortSignal): Promise<HideRow[]> {
  return (await listHides(api, { lotId, inStock: true, limit: 200 }, signal)).hides
}

const contactSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable(), status: z.string() })
export type SupplierContact = z.infer<typeof contactSchema>

/** The supplier's active contacts with an e-mail (parties.view), the quality and order desks first. */
export async function supplierContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<SupplierContact[]> {
  const answer = await api.get(`/parties/${enc(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactSchema) }) }), signal })
  const rank = (contact: SupplierContact) => (contact.roles.includes('QUALITY') ? 0 : contact.roles.includes('ORDERS') ? 1 : 2)
  return answer.party.contacts.filter((contact) => contact.status === 'ACTIVE' && !!contact.email).sort((a, b) => rank(a) - rank(b))
}
