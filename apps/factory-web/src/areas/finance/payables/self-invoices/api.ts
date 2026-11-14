import { z } from 'zod'
import { DEADLINE_STATES, SELF_INVOICE_KINDS, SELF_INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Self-invoices for purchases from abroad (B-W2b-401's API; FIN-095; design finance.payables sec:selfinv): the company's
 * self-invoices soonest deadline first (no money: the design's), the supplier invoices from abroad that still need one,
 * making one (its TD17/TD18/TD19 draft in euro) and cancelling a pending one. The API's English `words` are dropped:
 * the screen says its own from the kind, the deadline's state and the days left.
 */

export { DEADLINE_STATES, SELF_INVOICE_KINDS, SELF_INVOICE_STATUSES }
export type SelfInvoiceKind = (typeof SELF_INVOICE_KINDS)[number]
export type SelfInvoiceStatus = (typeof SELF_INVOICE_STATUSES)[number]
export type DeadlineState = (typeof DEADLINE_STATES)[number]
export const VAT_RATES = ['22', '10', '5', '4'] as const
export type VatRate = (typeof VAT_RATES)[number]

const deadlineStateSchema = z.object({ state: z.enum(DEADLINE_STATES), daysLeft: z.number() })

export const selfInvoiceSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  partyId: z.string(),
  supplier: z.object({ code: z.string(), legalName: z.string() }),
  supplierInvoice: z.object({ id: z.string(), number: z.string(), issueDate: z.string(), receivedOn: z.string() }),
  kind: z.enum(SELF_INVOICE_KINDS),
  deadline: z.string(),
  deadlineState: deadlineStateSchema,
  status: z.enum(SELF_INVOICE_STATUSES),
  invoice: z.object({ id: z.string(), docType: z.string(), status: z.string(), number: z.string().nullable(), issueDate: z.string().nullable() }).nullable(),
  cancelledAt: z.string().nullable(),
  can: z.object({ draft: z.boolean(), cancel: z.boolean(), issue: z.boolean() }),
})
export type SelfInvoice = z.infer<typeof selfInvoiceSchema>

const listSchema = z.object({ companyId: z.string(), selfInvoices: z.array(selfInvoiceSchema), selfInvoicesOn: z.boolean() })
export type SelfInvoices = z.infer<typeof listSchema>

/** The company's self-invoices, soonest deadline first (invoices.view); `status` narrows them. */
export function listSelfInvoices(api: ApiClient, companyId: string, status: SelfInvoiceStatus | null, signal?: AbortSignal): Promise<SelfInvoices> {
  return api.get('/invoicing/self-invoices', { query: { companyId, status: status ?? undefined }, schema: listSchema, signal })
}

export const candidateSchema = z.object({
  supplierInvoiceId: z.string(),
  partyId: z.string(),
  supplier: z.object({ code: z.string(), legalName: z.string(), country: z.string() }),
  number: z.string(),
  issueDate: z.string(),
  receivedOn: z.string(),
  currency: z.string(),
  suggestion: z.object({ kind: z.enum(SELF_INVOICE_KINDS).nullable() }),
  deadline: z.string(),
  deadlineState: deadlineStateSchema,
})
export type SelfInvoiceCandidate = z.infer<typeof candidateSchema>

/** The company's supplier invoices from abroad with no self-invoice yet (invoices.view + payables.view). */
export async function selfInvoiceCandidates(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<SelfInvoiceCandidate[]> {
  return (await api.get('/invoicing/self-invoices/candidates', { query: { companyId }, schema: z.object({ candidates: z.array(candidateSchema) }), signal })).candidates
}

const one = z.object({ selfInvoice: selfInvoiceSchema })

/** ONE command: the self-invoice and its draft (or the draft of a pending one without it) (invoices.manage + payables.view + money.cost). */
export async function createSelfInvoice(api: ApiClient, body: { supplierInvoiceId: string; kind: SelfInvoiceKind; vatRatePct?: VatRate }, idempotencyKey: string): Promise<SelfInvoice> {
  return (await api.post('/invoicing/self-invoices', { body, schema: one, idempotencyKey })).selfInvoice
}

/** A pending self-invoice cancelled with the reason; its draft deleted in the same command (invoices.manage). */
export async function cancelSelfInvoice(api: ApiClient, selfInvoice: Pick<SelfInvoice, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<SelfInvoice> {
  return (await api.post(`/invoicing/self-invoices/${encodeURIComponent(selfInvoice.id)}/cancel`, { body: { version: selfInvoice.version, reason }, schema: one, idempotencyKey })).selfInvoice
}

/** A live event that changes the list: a self-invoice, a supplier invoice arriving, the accountant's switch. */
export const selfInvoicesTouched = (change: { type: string }): boolean => change.type === 'self_invoice.changed' || change.type.startsWith('supplier_invoice.') || change.type === 'e_invoicing.settings_changed' || change.type === 'invoice.issued'
