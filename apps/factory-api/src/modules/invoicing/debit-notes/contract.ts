import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CREDIT_REASONS } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { DEBIT_REFUSALS, VAT_LIMIT_STATES } from '@nexus/factory-domain/invoicing/debit-notes/debit-notes'
import { INVOICE_STATUSES, MAX_INVOICE_LINES } from '@nexus/factory-domain/invoicing/invoices'
import { money } from '@nexus/factory-domain/money/marked'
import { invoiceView, lineInput, paymentInput } from '../contract'

/**
 * The contracts of the debit note TD05 and the time limit on VAT decreases (B-W2b-401; FIN-071, FIN-073). A debit note's total
 * is money.price; the verdict carries its code and words.
 */

const invoiceParams = input({ invoiceId: id() })
const ruleView = output({ status: z.literal('UNVERIFIED'), words: z.string() })

// ---- the debit note and the VAT time limit (FIN-071, FIN-073) ------------------------------------------------------------

export const createDebitNoteContract = defineContract({
  params: invoiceParams,
  body: input({ lines: z.array(lineInput).min(1).max(MAX_INVOICE_LINES), causale: z.string().trim().max(500).nullish(), payment: paymentInput.nullish() }),
  response: { 201: output({ invoice: invoiceView }) },
})

export const debitNotesContract = defineContract({
  params: invoiceParams,
  response: {
    200: output({
      invoiceId: id(),
      debitable: output({ ok: z.boolean(), code: z.enum(DEBIT_REFUSALS).nullable(), words: z.string().nullable() }),
      debitNotes: z.array(output({ id: id(), status: z.enum(INVOICE_STATUSES), number: z.string().nullable(), issueDate: businessDate().nullable(), currency: z.string(), grossTotal: money.price(z.number().int()) })),
      waits: z.string().nullable(),
      rule: ruleView,
    }),
  },
})

export const vatTimeLimitContract = defineContract({
  params: invoiceParams,
  querystring: input({ reason: z.enum(CREDIT_REASONS) }),
  response: {
    200: output({
      invoiceId: id(),
      reason: z.enum(CREDIT_REASONS),
      operationDate: businessDate(),
      judgedOn: businessDate(),
      verdict: output({ state: z.enum(VAT_LIMIT_STATES), limitDate: businessDate().nullable(), words: z.string() }),
      rule: ruleView,
    }),
  },
})
