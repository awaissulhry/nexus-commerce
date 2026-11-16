import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-GB02 (G088): carrying a deposit paid without a deposit invoice (fiscal document NONE: an EU business with a VIES
 * proof) onto its order's invoice (B-W2b-21's routes): what a carry would do now (GET …/carry, payments.view: written
 * nowhere; a problem in words when it cannot be carried) and the carry itself (POST …/carry, payments.record). Amounts carry
 * the price grain (absent without it).
 */

const money = z.number().optional()

export const carryPreviewSchema = z.object({
  depositRequestId: z.string(),
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  currency: z.string(),
  problem: z.string().nullable(),
  amount: money,
  steps: z.array(z.object({ allocationId: z.string(), paymentId: z.string(), invoiceId: z.string(), invoiceNumber: z.string().nullable(), amount: money })),
  invoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), openAmount: money, openAfter: money })),
})
export type CarryPreview = z.infer<typeof carryPreviewSchema>

const enc = encodeURIComponent

/** What carrying the deposit onto this invoice would do now (payments.view). */
export async function carryPreview(api: ApiClient, depositRequestId: string, invoiceId: string, signal?: AbortSignal): Promise<CarryPreview> {
  return api.get(`/payments/deposit-requests/${enc(depositRequestId)}/carry`, { query: { invoiceId }, schema: carryPreviewSchema, signal })
}

/** Carries the deposit onto this invoice (payments.record): each payment's part reversed and placed on the invoice. */
export async function carryDeposit(api: ApiClient, depositRequestId: string, invoiceId: string, idempotencyKey: string): Promise<void> {
  await api.post(`/payments/deposit-requests/${enc(depositRequestId)}/carry`, { body: { invoiceId }, schema: z.object({ depositRequestId: z.string() }).passthrough(), idempotencyKey })
}

/** A live event after which the deposits to carry are read again. */
export const carryTouched = (change: { type: string }): boolean => change.type.startsWith('payment.') || change.type === 'invoice.issued'
