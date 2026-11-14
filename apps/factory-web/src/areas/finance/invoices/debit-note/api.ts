import { z } from 'zod'
import { DEBIT_REFUSALS, VAT_LIMIT_STATES } from '@nexus/factory-domain/invoicing/debit-notes/debit-notes'
import type { ApiClient } from '../../../../lib/api/client'
import { invoiceSchema, listInvoices, type CreditReason, type Invoice, type InvoiceRow, type LineInput } from '../../_shared/api'

/**
 * The debit note TD05 and the time limit on VAT decreases (B-W2b-401's API; FIN-071, FIN-073): the invoices a debit note
 * (or, from New ▾, a credit note) may follow, a TD05 draft of an issued TD01/TD24, an invoice's debit notes and whether it
 * takes one, and the verdict on a VAT decrease for the credit note's reason. Totals are the price grain. The API's English
 * `words` are dropped: the screens say their own from the codes and the dates.
 */

export { DEBIT_REFUSALS, VAT_LIMIT_STATES }
export type DebitRefusal = (typeof DEBIT_REFUSALS)[number]
export type VatLimitState = (typeof VAT_LIMIT_STATES)[number]

/** The issued invoices of these types the person sees (each type up to 200; drafts and rejected ones left out). */
export async function issuedOf(api: ApiClient, docTypes: ReadonlyArray<'TD01' | 'TD24' | 'TD02'>, signal?: AbortSignal): Promise<InvoiceRow[]> {
  const pages = await Promise.all(docTypes.map((docType) => listInvoices(api, { docType, limit: 200 }, signal)))
  return pages
    .flatMap((page) => page.invoices)
    .filter((row) => row.status !== 'DRAFT' && row.status !== 'REJECTED')
    .sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? '') || (b.number ?? '').localeCompare(a.number ?? ''))
}

const debitNotesSchema = z.object({
  invoiceId: z.string(),
  debitable: z.object({ ok: z.boolean(), code: z.enum(DEBIT_REFUSALS).nullable() }),
  debitNotes: z.array(z.object({ id: z.string(), status: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), currency: z.string(), grossTotal: z.number().optional() })),
  /** Non-null while the accountant's switch is off (the debit note's issue waits). */
  waits: z.string().nullable(),
})
export type DebitNotes = z.infer<typeof debitNotesSchema>

/** Whether an invoice takes a debit note, and its debit notes (invoices.view). */
export function getDebitNotes(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<DebitNotes> {
  return api.get(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/debit-notes`, { schema: debitNotesSchema, signal })
}

/** A TD05 draft adding to an issued TD01/TD24: same company, customer and currency; VAT by the rules (invoices.manage). */
export async function createDebitNote(api: ApiClient, invoiceId: string, body: { lines: LineInput[]; causale?: string | null }, idempotencyKey: string): Promise<Invoice> {
  return (await api.post(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/debit-note`, { body, schema: z.object({ invoice: invoiceSchema }), idempotencyKey })).invoice
}

const vatLimitSchema = z.object({
  invoiceId: z.string(),
  reason: z.string(),
  operationDate: z.string(),
  judgedOn: z.string(),
  verdict: z.object({ state: z.enum(VAT_LIMIT_STATES), limitDate: z.string().nullable() }),
})
export type VatLimit = z.infer<typeof vatLimitSchema>

/** The time limit on lowering VAT for a credit note of this reason (art. 26 c.3 DPR 633/1972): a warning, never a refusal. */
export function getVatTimeLimit(api: ApiClient, invoiceId: string, reason: CreditReason, signal?: AbortSignal): Promise<VatLimit> {
  return api.get(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/vat-time-limit`, { query: { reason }, schema: vatLimitSchema, signal })
}
