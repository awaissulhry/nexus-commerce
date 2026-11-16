import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-424 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv: "Material, supplier, standard,
 * paid, difference"; FIN-031) on B-W2b-407's GET /costing/ppv (costing.view over the company and the supplier): the
 * variances newest first, a page at a time, the totals per currency over every page, and the company's switch in words
 * while its figures wait for the accountant. Unit costs and differences are the cost grain (absent without it: the screen
 * draws no value column then). PPV_AT mirrors factory-domain costing/ppv/rules (ppv.vitest.test.ts holds it equal). The
 * API's English words are never drawn. No person is named.
 */

export const PPV_AT = ['RECEIPT', 'INVOICE'] as const

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const ppvRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  supplier: z.object({ id: z.string(), name: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  source: z.object({ at: z.enum(PPV_AT), documentId: z.string(), number: z.string(), lineId: z.string(), seq: z.number() }),
  postedAt: z.string(),
  day: z.string(),
  quantity: z.string(),
  standardUnitCost: cost(z.string()),
  paidUnitCost: cost(z.string()),
  differenceAmount: cost(z.number()),
  currency: z.string(),
  reversalOfId: z.string().nullable(),
  reversedBy: z.object({ id: z.string(), postedAt: z.string(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
})
export type PpvRow = z.infer<typeof ppvRowSchema>

const ppvAnswerSchema = z.object({
  rows: z.array(ppvRowSchema),
  nextCursor: z.string().nullable(),
  totals: z.array(z.object({ currency: z.string(), differenceAmount: cost(z.number()), rows: z.number() })),
  /** The API's words while the company's figures wait for the accountant (the screen says its own); null while on. */
  waits: z.string().nullable(),
})
export type PpvAnswer = z.infer<typeof ppvAnswerSchema>

export interface PpvQuery {
  readonly companyId: string | null
  /** Europe/Rome days of the posting, both included (the page's period). */
  readonly from: string
  readonly to: string
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/ppv: the period's purchase price variances, newest first. */
export function getPpv(api: ApiClient, query: PpvQuery, signal?: AbortSignal): Promise<PpvAnswer> {
  const params: Record<string, string | number> = { from: query.from, to: query.to, limit: query.limit ?? 50 }
  if (query.companyId) params.companyId = query.companyId
  if (query.cursor) params.cursor = query.cursor
  return api.get('/costing/ppv', { query: params, schema: ppvAnswerSchema, signal })
}

// ---- B-W2b-GB02 (G053; B-W2b-424's gap 1): a variance reversed with its reason, a document's variances posted by hand --------

/** Why a write is refused (`refusal/<CODE>`), mirroring factory-domain costing/ppv/rules PPV_REFUSALS (ppv.vitest.test.ts). */
export const PPV_REFUSALS = ['WAITS_FOR_ACCOUNTANT', 'OTHER_PLACE', 'NOT_READY', 'LOCKED', 'IS_REVERSAL', 'REVERSED_ALREADY'] as const
export type PpvRefusal = (typeof PPV_REFUSALS)[number]
/** Why a document's line took no variance, mirroring factory-domain PPV_SKIPS (the screen words each code). */
export const PPV_SKIPS = ['CUSTOMER_OWNED', 'NOT_GOODS', 'NO_ORDER_LINE', 'NO_STANDARD', 'NO_RATE', 'NO_QUANTITY', 'TAKEN'] as const
export type PpvSkip = (typeof PPV_SKIPS)[number]

const reverseAnswerSchema = z.object({ variance: ppvRowSchema, reversal: ppvRowSchema, replayed: z.boolean() })
export type PpvReverseAnswer = z.infer<typeof reverseAnswerSchema>

/** POST /costing/ppv/:id/reverse {reason} (costing.ledger.manage): a reversal row dated now; one key per attempt. */
export function reversePpv(api: ApiClient, varianceId: string, reason: string, idempotencyKey: string = newIdempotencyKey()): Promise<PpvReverseAnswer> {
  return api.post(`/costing/ppv/${encodeURIComponent(varianceId)}/reverse`, { body: { reason }, schema: reverseAnswerSchema, idempotencyKey })
}

const postAnswerSchema = z.object({
  posted: z.array(ppvRowSchema),
  skipped: z.array(z.object({ lineId: z.string(), seq: z.number(), code: z.enum(PPV_SKIPS) })),
  replayed: z.boolean(),
})
export type PpvPostAnswer = z.infer<typeof postAnswerSchema>

/** POST /costing/ppv/post {receiptId | supplierInvoiceId} (costing.ledger.manage): the document's variances now. */
export function postPpv(api: ApiClient, document: { readonly at: (typeof PPV_AT)[number]; readonly id: string }, idempotencyKey: string = newIdempotencyKey()): Promise<PpvPostAnswer> {
  const body = document.at === 'RECEIPT' ? { receiptId: document.id } : { supplierInvoiceId: document.id }
  return api.post('/costing/ppv/post', { body, schema: postAnswerSchema, idempotencyKey })
}

const documentSchema = z.object({ id: z.string(), number: z.string() })
export type PpvDocument = z.infer<typeof documentSchema>

/**
 * The receipts or supplier invoices whose number contains `number` (the API's own search: GET /inventory/receipts?q,
 * inventory.stock.view; GET /payables/invoices?q, payables.view), for the person to post one by its number.
 */
export async function findDocuments(api: ApiClient, at: (typeof PPV_AT)[number], number: string, companyId: string | null): Promise<PpvDocument[]> {
  if (at === 'RECEIPT') return (await api.get('/inventory/receipts', { query: { q: number, limit: 20 }, schema: z.object({ receipts: z.array(documentSchema) }) })).receipts
  const query: Record<string, string | number> = { q: number, limit: 20 }
  if (companyId) query.companyId = companyId
  return (await api.get('/payables/invoices', { query, schema: z.object({ items: z.array(documentSchema) }) })).items
}
// ---- end B-W2b-GB02
