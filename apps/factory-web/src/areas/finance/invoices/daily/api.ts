import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { invoiceSchema, type Invoice } from '../../_shared/api'

/**
 * The invoice screens' every-day calls (B-W2a-80 on the API of B-W2a-54 and B-W2a-61), each answer checked with zod (unknown
 * fields dropped; money optional = absent without the price grain; the API's English words never drawn):
 *   GET  /invoicing/deferred                         the deferred invoices due by the 15th (the tile's counts, the groups)
 *   POST /invoicing/invoices/deferred                ONE TD24 draft of a customer's month of DDTs
 *   GET  /invoicing/returns/:returnId/credit-notes   a customer return's credit notes and what a draft would credit now
 *   POST /invoicing/returns/:returnId/credit-notes   the TD04 drafts of the return (one per invoice that billed it)
 *   POST /payments/release-overpayment               "carry the credit": an over-paid invoice's excess back to its payments
 */

const deadline = z.object({ docType: z.enum(['TD01', 'TD24']), dueBy: z.string(), daysLeft: z.number(), state: z.enum(['OPEN', 'DUE_SOON', 'LATE']) })

export const deferredSchema = z.object({
  asOf: z.string(),
  counts: z.object({ groups: z.number(), open: z.number(), dueSoon: z.number(), late: z.number() }),
  groups: z.array(
    z.object({
      companyId: z.string(),
      partyId: z.string(),
      code: z.string(),
      legalName: z.string(),
      invoiceTiming: z.enum(['PER_SHIPMENT', 'MONTHLY']),
      month: z.string(),
      ddts: z.array(z.object({ ddtId: z.string(), number: z.string(), date: z.string(), shipmentNumber: z.string() })),
      valueAmount: z.number().optional(),
      freightAmount: z.number().optional(),
      drafts: z.array(z.string()),
      deadline: deadline.nullable(),
    }),
  ),
})
export type Deferred = z.infer<typeof deferredSchema>
export type DeferredGroup = Deferred['groups'][number]

/** The deferred invoices due: per customer, company and month, the DDTs a TD24 takes and its deadline (invoices.view). */
export function deferredDue(api: ApiClient, signal?: AbortSignal): Promise<Deferred> {
  return api.get('/invoicing/deferred', { schema: deferredSchema, signal })
}

const createdSchema = z.object({ invoice: invoiceSchema, freight: z.array(z.object({ ddtId: z.string(), number: z.string() })).default([]) })

/** ONE TD24 draft of every DDT of that month the customer still has to be invoiced for, with their freight (invoices.manage). */
export async function createDeferred(api: ApiClient, group: { companyId: string; partyId: string; month: string }, idempotencyKey: string): Promise<Invoice> {
  // Only the three fields: the API's body is strict (a group read from GET /invoicing/deferred carries more).
  const body = { companyId: group.companyId, partyId: group.partyId, month: group.month }
  return (await api.post('/invoicing/invoices/deferred', { body, schema: createdSchema, idempotencyKey })).invoice
}

/** Why a return's line is left out of a credit note (factory-domain invoicing/credit-note/from-return RETURN_CREDIT_SKIPS). */
export const RETURN_CREDIT_SKIPS = ['NOT_DECIDED', 'NO_CREDIT', 'NOT_RECEIVED', 'ON_CREDIT_NOTE', 'NOT_INVOICED', 'INVOICE_STATE', 'OTHER_COMPANY', 'CURRENCY', 'OVER_CREDITABLE', 'NOT_ASKED'] as const
export type ReturnCreditSkip = (typeof RETURN_CREDIT_SKIPS)[number]

const status = z.enum(['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'])
const notCredited = z.object({ lineId: z.string(), seq: z.number(), code: z.enum(RETURN_CREDIT_SKIPS) })

export const returnCreditSchema = z.object({
  return: z.object({ id: z.string(), number: z.string(), status: z.string(), companyId: z.string(), partyId: z.string() }),
  creditDecidedAmount: z.number().optional(),
  creditNotedAmount: z.number().optional(),
  creditNotes: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable(),
      status,
      issueDate: z.string().nullable(),
      currency: z.string(),
      netTotal: z.number().optional(),
      grossTotal: z.number().optional(),
      creditOfId: z.string().nullable(),
      creditOfNumber: z.string().nullable(),
      lines: z.array(z.object({ returnLineId: z.string(), seq: z.number(), quantity: z.string(), netAmount: z.number().optional() })),
      refunds: z.array(z.object({ id: z.string(), status: z.enum(['DUE', 'PAID', 'CANCELLED', 'VOIDED']), amount: z.number().optional() })),
    }),
  ),
  toCredit: z.array(
    z.object({
      creditOfId: z.string(),
      invoiceNumber: z.string(),
      currency: z.string(),
      netTotal: z.number().optional(),
      lines: z.array(z.object({ returnLineId: z.string(), seq: z.number(), pieces: z.number(), description: z.string(), netAmount: z.number().optional() })),
    }),
  ),
  notCredited: z.array(notCredited),
})
export type ReturnCredit = z.infer<typeof returnCreditSchema>

const returnPath = (returnId: string) => `/invoicing/returns/${encodeURIComponent(returnId)}/credit-notes`

/** A customer return's credit notes, what a draft would credit now (per invoice) and the lines left out (invoices.view). */
export function returnCredit(api: ApiClient, returnId: string, signal?: AbortSignal): Promise<ReturnCredit> {
  return api.get(returnPath(returnId), { schema: returnCreditSchema, signal })
}

const draftedSchema = z.object({ creditNotes: z.array(invoiceSchema), notCredited: z.array(notCredited) })
export type ReturnCreditDrafted = z.infer<typeof draftedSchema>

/** The TD04 drafts of a return's decided lines (some lines, or every one with a credit), one per invoice (invoices.manage). */
export function draftReturnCredit(api: ApiClient, returnId: string, lineIds: readonly string[] | null, idempotencyKey: string): Promise<ReturnCreditDrafted> {
  return api.post(returnPath(returnId), { body: lineIds && lineIds.length > 0 ? { lineIds } : {}, schema: draftedSchema, idempotencyKey })
}

const releasedSchema = z.object({ releasedAmount: z.number().optional(), payments: z.array(z.object({ paymentId: z.string(), unplacedAmount: z.number().optional() })) })
export type Released = z.infer<typeof releasedSchema>

/**
 * "Carry the credit" (B-W2a-61): an invoice paid beyond what it is worth after its credit notes gives the excess back to its
 * payments' unplaced part — the customer's credit balance (payments.record). Refused while a refund of its notes is live.
 */
export function releaseOverpayment(api: ApiClient, invoiceId: string, note: string, idempotencyKey: string): Promise<Released> {
  return api.post('/payments/release-overpayment', { body: { invoiceId, note }, schema: releasedSchema, idempotencyKey })
}
