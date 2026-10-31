import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * The schedule card's two verbs (B-W2a-80, closing B-W2a-F2's note for the order studio; DPR 633/1972 art. 6 c.4):
 *   POST /sales/orders/:orderId/schedule/:milestoneId/request {version, dueDate?}   "Open for payment": the request of a
 *        before-shipping step that has none (orders.manage) — then it is paid like the deposit (its TD02 at payment)
 *   POST /invoicing/invoices/from-milestone {milestoneId}                            "Invoice this step": the TD02 draft of
 *        what is paid on a deposit or before-shipping step's request and not invoiced yet (invoices.manage)
 * The answers are read only for what the card needs (the new request's id; the draft's id to open it).
 */

const opened = z.object({ depositRequestId: z.string().nullable().optional() }).passthrough()

export async function openStep(api: ApiClient, orderId: string, step: { id: string; version: number }, dueDate: string | null, idempotencyKey: string): Promise<{ depositRequestId: string | null }> {
  const answer = await api.post(`/sales/orders/${encodeURIComponent(orderId)}/schedule/${encodeURIComponent(step.id)}/request`, { body: { version: step.version, ...(dueDate ? { dueDate } : {}) }, schema: opened, idempotencyKey })
  return { depositRequestId: answer.depositRequestId ?? null }
}

const drafted = z.object({ invoice: z.object({ id: z.string() }).passthrough() })

export async function invoiceStep(api: ApiClient, milestoneId: string, idempotencyKey: string): Promise<{ invoiceId: string }> {
  return { invoiceId: (await api.post('/invoicing/invoices/from-milestone', { body: { milestoneId }, schema: drafted, idempotencyKey })).invoice.id }
}
