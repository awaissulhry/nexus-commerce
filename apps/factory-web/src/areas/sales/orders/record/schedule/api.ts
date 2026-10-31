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

/**
 * B-W2b-16: the owner waives a deposit or a step before shipping (orders.waive + a fresh step-up): the step and its
 * request (nothing paid on it) become WAIVED with the reason. A request no step names is waived by its own id.
 *   POST /sales/orders/:orderId/schedule/:milestoneId/waive {version, reason}
 *   POST /sales/orders/:orderId/deposit-requests/:requestId/waive {version, reason}
 */
export type WaiveTarget = { readonly kind: 'step'; readonly id: string; readonly version: number } | { readonly kind: 'request'; readonly id: string; readonly version: number }

const waived = z.object({ waived: z.object({ milestoneIds: z.array(z.string()), depositRequestId: z.string().nullable() }) }).passthrough()

export async function waive(api: ApiClient, orderId: string, target: WaiveTarget, reason: string, idempotencyKey: string): Promise<void> {
  const path = target.kind === 'step' ? `schedule/${encodeURIComponent(target.id)}` : `deposit-requests/${encodeURIComponent(target.id)}`
  await api.post(`/sales/orders/${encodeURIComponent(orderId)}/${path}/waive`, { body: { version: target.version, reason }, schema: waived, idempotencyKey })
}
