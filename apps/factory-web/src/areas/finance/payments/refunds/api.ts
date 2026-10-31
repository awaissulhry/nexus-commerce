import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { openItemSchema } from '../../_shared/api'

/**
 * Refunds and the credit balance (B-W2a-80 on the API of B-W2a-61; design finance.payments pop:refund, tile "Refunds to
 * make", rec:Payment "Overpayment → customer credit balance"), each answer checked with zod (money optional: absent
 * without the price grain; the API's English never drawn). A refund is money given back by bank transfer — for a credit
 * note (what it gives back of money already paid) or for a payment's credit balance — recorded DUE (to make by a day) or
 * PAID at once (its value date and the bank's reference); every move after carries the refund's version.
 */

export const REFUND_STATUSES = ['DUE', 'PAID', 'CANCELLED', 'VOIDED'] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]
export const REFUND_SOURCES = ['CREDIT_NOTE', 'PAYMENT'] as const
export const REFUND_VIEWS = ['due', 'paid', 'closed', 'all'] as const
export type RefundView = (typeof REFUND_VIEWS)[number]

export const refundSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  source: z.enum(REFUND_SOURCES),
  creditNote: z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), creditOfId: z.string().nullable(), creditOfNumber: z.string().nullable(), creditOfDocType: z.string().nullable() }).nullable(),
  payment: z.object({ id: z.string(), receivedOn: z.string(), externalRef: z.string() }).nullable(),
  method: z.enum(['BANK_TRANSFER']),
  amount: z.number().optional(),
  currency: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(REFUND_STATUSES),
  paidOn: z.string().nullable(),
  externalRef: z.string().nullable(),
  cancelReason: z.string().nullable(),
  voidReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: z.string(),
})
export type Refund = z.infer<typeof refundSchema>

const refundPage = z.object({ refunds: z.array(refundSchema), nextCursor: z.string().nullable() })
export type RefundPage = z.infer<typeof refundPage>

/** The refunds, newest first (payments.view): due, paid, closed (cancelled or voided) or all. */
export function listRefunds(api: ApiClient, query: { view?: RefundView; creditNoteId?: string; paymentId?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<RefundPage> {
  return api.get('/payments/refunds', { query: { view: query.view, creditNoteId: query.creditNoteId, paymentId: query.paymentId, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 }, schema: refundPage, signal })
}

export const toRefundSchema = z.object({
  creditNoteId: z.string(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  currency: z.string(),
  grossTotal: z.number().optional(),
  creditOfId: z.string(),
  creditOfNumber: z.string().nullable(),
  creditOfDocType: z.string(),
  orderNumber: z.string().nullable(),
  refundedAmount: z.number().optional(),
  refundableAmount: z.number().optional(),
})
export type ToRefund = z.infer<typeof toRefundSchema>

export const openRefundsSchema = z.object({
  counts: z.object({ refundsDue: z.number(), creditNotesToRefund: z.number() }),
  refundsDue: z.array(refundSchema),
  creditNotesToRefund: z.array(toRefundSchema),
  asOf: z.string(),
})
export type OpenRefunds = z.infer<typeof openRefundsSchema>

/** "Refunds to make" (payments.view): the DUE refunds, oldest due first, and the credit notes with money left to refund. */
export function openRefunds(api: ApiClient, signal?: AbortSignal): Promise<OpenRefunds> {
  return api.get('/payments/refunds/open', { schema: openRefundsSchema, signal })
}

const one = z.object({ refund: refundSchema })

export interface RefundAsk {
  creditNoteId?: string
  paymentId?: string
  /** Minor units; absent: all that is refundable. */
  amount?: number
  dueDate?: string | null
  internalNote?: string | null
  /** Made already: the transfer's value date and the bank's reference. */
  paid?: { paidOn: string; externalRef: string }
}

/** Records a refund, DUE or PAID at once, never above what is refundable (payments.refund). */
export async function recordRefund(api: ApiClient, body: RefundAsk, idempotencyKey: string): Promise<Refund> {
  return (await api.post('/payments/refunds', { body, schema: one, idempotencyKey })).refund
}

const refundPath = (id: string) => `/payments/refunds/${encodeURIComponent(id)}`

/** A DUE refund made: its value date (not in the future) and the bank's reference (payments.refund). */
export async function payRefund(api: ApiClient, refund: Pick<Refund, 'id' | 'version'>, body: { paidOn: string; externalRef: string }, idempotencyKey: string): Promise<Refund> {
  return (await api.post(`${refundPath(refund.id)}/paid`, { body: { version: refund.version, ...body }, schema: one, idempotencyKey })).refund
}

/** A DUE refund not made after all: the customer keeps the credit (payments.refund). */
export async function cancelRefund(api: ApiClient, refund: Pick<Refund, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<Refund> {
  return (await api.post(`${refundPath(refund.id)}/cancel`, { body: { version: refund.version, reason }, schema: one, idempotencyKey })).refund
}

/** A PAID refund recorded by mistake: the money is owed again (payments.void). */
export async function voidRefund(api: ApiClient, refund: Pick<Refund, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<Refund> {
  return (await api.post(`${refundPath(refund.id)}/void`, { body: { version: refund.version, reason }, schema: one, idempotencyKey })).refund
}

const openItemsAnswer = z.object({
  items: z.array(openItemSchema),
  left: z.object({ amount: z.number().optional(), afterSuggestion: z.number().optional() }).nullable().optional(),
  creditBalance: z.array(z.object({ currency: z.string(), amount: z.number().optional() })).default([]),
})
export type OpenItemsAnswer = z.infer<typeof openItemsAnswer>

/**
 * A customer's open items with the matcher's suggestion for a payment's unplaced part (or a typed amount), what that leaves
 * on the payment, and the customer's credit balance (payments.view).
 */
export function openItemsFor(api: ApiClient, input: { companyId: string; partyId: string; paymentId?: string; amount?: number }, signal?: AbortSignal): Promise<OpenItemsAnswer> {
  return api.get('/payments/open-items', { query: { companyId: input.companyId, partyId: input.partyId, paymentId: input.paymentId, amount: input.amount }, schema: openItemsAnswer, signal })
}
