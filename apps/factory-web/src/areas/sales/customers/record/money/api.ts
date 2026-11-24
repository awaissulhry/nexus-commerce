import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import type { ShippedNotInvoiced } from './model'

/**
 * F-CM-103 (customer page › MONEY tab, 13-backend §1.1) — the one call of the tab that no other screen makes in this shape: what of
 * THIS customer shipped and is not invoiced yet (GET /invoicing/shipped-not-invoiced?companyId&partyId: invoices.view; the value with
 * the price grain). Finance's queue reads every customer (finance/_shared/api.ts shippedNotInvoiced); this one names the customer and
 * keeps only what the tab says (zod drops the rest). Every other read of the tab is an existing call (finance/**, orders/api.ts).
 */

const deadline = z.object({ dueBy: z.string() }).nullable().optional()
const shippedSchema = z.object({
  customers: z.array(
    z.object({
      partyId: z.string(),
      valueAmount: z.number().optional(),
      months: z.array(z.object({ deadline })).default([]),
      ddts: z.array(z.object({ ddtId: z.string() })).default([]),
      // B-W2b-GB02 (G148): the shipments that left without a DDT, not invoiced (an older API answers none).
      shipments: z.array(z.object({ id: z.string().optional(), deadline })).optional(),
    }),
  ),
})

/** One customer's shipped goods not invoiced yet (null: nothing), its value (price grain) and the nearest legal deadline. */
export async function shippedOfCustomer(api: ApiClient, input: { readonly companyId: string | null; readonly partyId: string; readonly currency: string | null }, signal?: AbortSignal): Promise<ShippedNotInvoiced | null> {
  const answer = await api.get('/invoicing/shipped-not-invoiced', { query: { companyId: input.companyId ?? undefined, partyId: input.partyId }, schema: shippedSchema, signal })
  // The read names this customer: its one row (a row per company when no company term is sent — their counts are summed, never amounts).
  const rows = answer.customers
  if (rows.length === 0) return null
  const days = rows.flatMap((row) => [...row.months.map((month) => month.deadline?.dueBy ?? null), ...(row.shipments ?? []).map((shipment) => shipment.deadline?.dueBy ?? null)]).filter((day): day is string => !!day)
  const shipments = rows.reduce((total, row) => total + row.ddts.length + (row.shipments?.length ?? 0), 0)
  if (shipments === 0) return null
  const values = rows.map((row) => row.valueAmount)
  return {
    shipments,
    value: rows.length === 1 && typeof values[0] === 'number' ? values[0] : null,
    currency: input.currency,
    invoiceBy: days.sort()[0] ?? null,
  }
}
