import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { DUAL_STEPS } from '../proposal/api'

/**
 * Dual approval of a supplier invoice (B-W2b-425 on B-W2b-403's API; design finance.payables rec:Supplier invoice › Approval
 * "'You entered this invoice, so someone else approves it'; dual approval above 10,000 (W2b)"). The amount is a cost, absent
 * without money.cost; the answer's words are never drawn.
 */

export const DUAL_HELD = ['NOT_OPEN', 'NO_PERMISSION', 'SECOND_APPROVER'] as const
export type DualHeld = (typeof DUAL_HELD)[number]

export const dualSchema = z.object({
  invoiceId: z.string(),
  needed: z.boolean(),
  threshold: z.object({ amount: z.number().optional(), currency: z.string(), decided: z.boolean() }),
  first: z.object({ by: z.object({ id: z.string(), name: z.string().nullable() }), at: z.string(), standing: z.boolean() }).nullable(),
  step: z.enum(DUAL_STEPS),
  held: z.enum(DUAL_HELD).nullable(),
})
export type InvoiceDual = z.infer<typeof dualSchema>

/** GET /payables/invoices/:id/dual-approval (payables.view): needed, the amount, the first yes and whether it still stands. */
export function invoiceDual(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<InvoiceDual> {
  return api.get(`/payables/invoices/${encodeURIComponent(invoiceId)}/dual-approval`, { schema: dualSchema, signal })
}
