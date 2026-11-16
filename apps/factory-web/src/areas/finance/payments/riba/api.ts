import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Ri.Ba. collections on screen (B-W2b-425 on B-W2b-402's API; design finance.payments ⋯ "Ri.Ba. batch": invoices due in the
 * window, total, the CBI file; the new tab "Ri.Ba. file download"; the tile "Ri.Ba. unpaid"). Every answer is checked with
 * zod (unknown fields dropped); every amount is a price, absent without money.price (never zero). The answers' English
 * words are never drawn: the screen speaks by the codes. The lists mirror factory-domain receivables/riba (the tests hold
 * them equal).
 */

export const RIBA_BATCH_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const
export type RibaBatchStatus = (typeof RIBA_BATCH_STATUSES)[number]
export const RIBA_ITEM_STATUSES = ['ISSUED', 'PAID', 'UNPAID'] as const
export type RibaItemStatus = (typeof RIBA_ITEM_STATUSES)[number]
export const RIBA_SETTLEMENTS = ['PAID', 'UNPAID'] as const
export type RibaSettlement = (typeof RIBA_SETTLEMENTS)[number]
/** The API's refusal codes (`riba/<CODE>`, `items/<i>/<CODE>`, `body/items/<i>/<CODE>`, a candidate's `held.code`). */
export const RIBA_REFUSALS = [
  'SWITCHED_OFF',
  'NOT_DRAFT',
  'NOT_ISSUED',
  'NO_ITEMS',
  'NOT_RIBA',
  'NOT_OPEN',
  'OUTSIDE_WINDOW',
  'IN_ANOTHER_BATCH',
  'NO_ACCOUNT',
  'ACCOUNT_OFF',
  'ACCOUNT_NOT_ITALIAN',
  'CURRENCY',
  'DEBTOR_NOT_ITALIAN',
  'NO_DEBTOR_BANK',
  'FILE_DATA',
  'SETTLED',
  'BEFORE_DUE',
  'FUTURE_DAY',
  'FEE_ON_PAID',
  'FEE_NEEDED',
  'NOT_IN_BATCH',
] as const
export type RibaRefusal = (typeof RIBA_REFUSALS)[number]
/** The most instalments one batch or one settlement takes; the longest window (the database's). */
export const MAX_RIBA_ITEMS = 500
export const MAX_RIBA_WINDOW_DAYS = 366
export const MAX_RIBA_REASON = 500

const price = <T extends z.ZodTypeAny>(schema: T) => schema.optional()
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const debtorBank = z.object({ abi: z.string(), cab: z.string(), name: z.string().nullable(), source: z.enum(['GIVEN', 'INVOICE', 'BANK_LINE']) })
const settled = z.object({ paid: z.number(), unpaid: z.number(), waiting: z.number() })

export const candidateSchema = z.object({
  invoice: z.object({ id: z.string(), number: z.string(), issueDate: z.string() }),
  customer: ref,
  instalment: z.number(),
  dueDate: z.string(),
  instalmentAmount: price(z.number()),
  amount: price(z.number()),
  currency: z.string(),
  debtorBank: debtorBank.nullable(),
  held: z.object({ code: z.enum(RIBA_REFUSALS) }).nullable(),
})
export type RibaCandidate = z.infer<typeof candidateSchema>

const candidatesSchema = z.object({ companyId: z.string(), dueFrom: z.string(), dueTo: z.string(), candidates: z.array(candidateSchema), total: price(z.number()), count: z.number() })
export type RibaCandidates = z.infer<typeof candidatesSchema>

export const itemSchema = z.object({
  id: z.string(),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable() }),
  customer: ref,
  instalment: z.number(),
  dueDate: z.string(),
  amount: price(z.number()),
  status: z.enum(RIBA_ITEM_STATUSES),
  settledOn: z.string().nullable(),
  unpaidFee: price(z.number().nullable()),
  paymentId: z.string().nullable(),
  invoiceOpen: price(z.number()),
  debtorBank: debtorBank.nullable(),
  version: z.number(),
})
export type RibaItem = z.infer<typeof itemSchema>

export const batchSchema = z.object({
  id: z.string(),
  company: ref,
  bankAccount: z.object({ id: z.string(), iban: z.string(), bankName: z.string().nullable(), active: z.boolean() }),
  dueFrom: z.string(),
  dueTo: z.string(),
  status: z.enum(RIBA_BATCH_STATUSES),
  note: z.string().nullable(),
  items: z.array(itemSchema),
  count: z.number(),
  total: price(z.number()),
  currency: z.string(),
  file: z.object({ id: z.string(), name: z.string(), sizeBytes: z.number() }).nullable(),
  issuedAt: z.string().nullable(),
  issuedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  settled,
  switchOn: z.boolean(),
  can: z.object({ pick: z.boolean(), issue: z.boolean(), cancel: z.boolean(), settle: z.boolean() }),
  createdAt: z.string(),
  version: z.number(),
})
export type RibaBatch = z.infer<typeof batchSchema>
const oneBatch = z.object({ batch: batchSchema })

export const batchRowSchema = z.object({
  id: z.string(),
  company: ref,
  dueFrom: z.string(),
  dueTo: z.string(),
  status: z.enum(RIBA_BATCH_STATUSES),
  count: z.number(),
  total: price(z.number()),
  fileId: z.string().nullable(),
  issuedAt: z.string().nullable(),
  settled,
  createdAt: z.string(),
})
export type RibaBatchRow = z.infer<typeof batchRowSchema>

export const unpaidSchema = z.object({
  tiles: z.array(z.object({ currency: z.string(), count: z.number(), open: price(z.number()), fees: price(z.number()) })),
  items: z.array(
    z.object({
      itemId: z.string(),
      batchId: z.string(),
      company: ref,
      customer: ref,
      invoice: z.object({ id: z.string(), number: z.string().nullable() }),
      instalment: z.number(),
      dueDate: z.string(),
      settledOn: z.string(),
      amount: price(z.number()),
      unpaidFee: price(z.number()),
      invoiceOpen: price(z.number()),
      currency: z.string(),
      daysSince: z.number(),
    }),
  ),
})
export type RibaUnpaid = z.infer<typeof unpaidSchema>
export type RibaUnpaidItem = RibaUnpaid['items'][number]

/** The company's collections switches (the Owner's): Ri.Ba. on (the file is made only then), the customer's payment notice. */
export const collectionsSchema = z.object({
  companyId: z.string().nullable(),
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  settingsId: z.string().nullable(),
  version: z.number().nullable(),
  ribaOn: z.boolean(),
  paymentNoticeToCustomerOn: z.boolean(),
  // B-W2b-GB02 (G088): the automatic carry of a deposit without a deposit invoice (an older API answers none: off).
  depositAutoCarryOn: z.boolean().optional(),
  mayChange: z.boolean(),
})
export type CollectionsSettings = z.infer<typeof collectionsSchema>

const enc = encodeURIComponent

/** GET /receivables/riba/candidates (receivables.view): the open Ri.Ba. instalments due in the window. */
export function ribaCandidates(api: ApiClient, query: { companyId: string; dueFrom: string; dueTo: string; batchId?: string }, signal?: AbortSignal): Promise<RibaCandidates> {
  return api.get('/receivables/riba/candidates', { query, schema: candidatesSchema, signal })
}

/** GET /receivables/riba/batches (receivables.view): newest first. */
export async function ribaBatches(api: ApiClient, query: { companyId: string; status?: RibaBatchStatus; limit?: number }, signal?: AbortSignal): Promise<RibaBatchRow[]> {
  return (await api.get('/receivables/riba/batches', { query: { companyId: query.companyId, status: query.status, limit: query.limit ?? 20 }, schema: z.object({ batches: z.array(batchRowSchema) }), signal })).batches
}

/** GET /receivables/riba/batches/:id (receivables.view). */
export async function ribaBatch(api: ApiClient, batchId: string, signal?: AbortSignal): Promise<RibaBatch> {
  return (await api.get(`/receivables/riba/batches/${enc(batchId)}`, { schema: oneBatch, signal })).batch
}

export interface RibaPick {
  invoiceId: string
  instalment: number
}

/** POST /receivables/riba/batches (receivables.riba.manage): a DRAFT of the window with the instalments picked. */
export async function createRibaBatch(api: ApiClient, body: { companyId: string; dueFrom: string; dueTo: string; items: RibaPick[]; note?: string | null }, idempotencyKey: string): Promise<RibaBatch> {
  return (await api.post('/receivables/riba/batches', { body, schema: oneBatch, idempotencyKey })).batch
}

/** PUT /receivables/riba/batches/:id/items (receivables.riba.manage): picked again while DRAFT. */
export async function pickRibaItems(api: ApiClient, batch: Pick<RibaBatch, 'id' | 'version'>, items: RibaPick[], idempotencyKey: string): Promise<RibaBatch> {
  return (await api.request('PUT', `/receivables/riba/batches/${enc(batch.id)}/items`, { body: { version: batch.version, items }, schema: oneBatch, idempotencyKey })).batch
}

export interface DebtorBankInput {
  partyId: string
  abi: string
  cab: string
  name?: string | null
}

/** POST /receivables/riba/batches/:id/issue (receivables.riba.manage): the CBI file made and kept on the batch (ISSUED). */
export async function issueRibaBatch(api: ApiClient, batch: Pick<RibaBatch, 'id' | 'version'>, body: { siaCode: string; banks: DebtorBankInput[] }, idempotencyKey: string): Promise<RibaBatch> {
  return (await api.post(`/receivables/riba/batches/${enc(batch.id)}/issue`, { body: { version: batch.version, siaCode: body.siaCode, ...(body.banks.length > 0 ? { banks: body.banks } : {}) }, schema: oneBatch, idempotencyKey })).batch
}

/** POST /receivables/riba/batches/:id/cancel (receivables.riba.manage): a DRAFT abandoned with why. */
export async function cancelRibaBatch(api: ApiClient, batch: Pick<RibaBatch, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<RibaBatch> {
  return (await api.post(`/receivables/riba/batches/${enc(batch.id)}/cancel`, { body: { version: batch.version, reason }, schema: oneBatch, idempotencyKey })).batch
}

export interface SettleInput {
  itemId: string
  status: RibaSettlement
  settledOn: string
  unpaidFee?: number | null
}

/** POST /receivables/riba/batches/:id/settle (receivables.riba.manage; PAID also payments.record): the bank's report, all or none. */
export async function settleRibaBatch(api: ApiClient, batch: Pick<RibaBatch, 'id' | 'version'>, items: SettleInput[], idempotencyKey: string): Promise<RibaBatch> {
  return (await api.post(`/receivables/riba/batches/${enc(batch.id)}/settle`, { body: { version: batch.version, items }, schema: oneBatch, idempotencyKey })).batch
}

/** GET /receivables/riba/unpaid (receivables.view): the tile per currency and the instalments that came back. */
export function ribaUnpaid(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<RibaUnpaid> {
  return api.get('/receivables/riba/unpaid', { query: { companyId }, schema: unpaidSchema, signal })
}

/** GET /receivables/collections/settings (receivables.view): the Owner's switches in force for the company. */
export function collectionsSettings(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<CollectionsSettings> {
  return api.get('/receivables/collections/settings', { query: { companyId }, schema: collectionsSchema, signal })
}

/** PUT /receivables/collections/settings (receivables.collections.switch; a fresh code to turn one ON): the company's row. */
export function setCollections(api: ApiClient, body: { companyId: string; version?: number; ribaOn?: boolean; paymentNoticeToCustomerOn?: boolean; /* B-W2b-GB02 (G088) */ depositAutoCarryOn?: boolean }, idempotencyKey: string): Promise<CollectionsSettings> {
  return api.request('PUT', '/receivables/collections/settings', { body, schema: collectionsSchema, idempotencyKey })
}
