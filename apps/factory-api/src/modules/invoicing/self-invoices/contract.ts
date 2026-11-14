import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INVOICE_DOC_TYPES, INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/invoices'
import { DEADLINE_STATES, SELF_INVOICE_KINDS, SELF_INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'

/**
 * The contracts of self-invoices for foreign purchases (B-W2b-401; FIN-095): the list, the candidates, one, making one and
 * cancelling one. No money (the design's list has none: the self-invoice's invoice carries the amounts). Codes and the words
 * built from them. A version is the edit-conflict guard.
 */

const version = z.number().int().min(1)
const ruleView = output({ status: z.literal('UNVERIFIED'), words: z.string() })
const rate = z.enum(['22', '10', '5', '4'])

// ---- self-invoices (FIN-095) -------------------------------------------------------------------------------------------------

const deadlineState = output({ state: z.enum(DEADLINE_STATES), daysLeft: z.number().int(), words: z.string() })

const selfInvoiceView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  partyId: id(),
  supplier: output({ code: z.string(), legalName: z.string() }),
  supplierInvoice: output({ id: id(), number: z.string(), issueDate: businessDate(), receivedOn: businessDate() }),
  kind: z.enum(SELF_INVOICE_KINDS),
  kindWords: z.string(),
  deadline: businessDate(),
  deadlineState,
  status: z.enum(SELF_INVOICE_STATUSES),
  invoice: output({ id: id(), docType: z.enum(INVOICE_DOC_TYPES), status: z.enum(INVOICE_STATUSES), number: z.string().nullable(), issueDate: businessDate().nullable() }).nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** What waits while the company's switch is off, in words. */
  waits: z.string().nullable(),
  can: output({ draft: z.boolean(), cancel: z.boolean(), issue: z.boolean() }),
  createdAt: instant(),
  updatedAt: instant(),
})

export const listSelfInvoicesContract = defineContract({
  querystring: input({ companyId: id(), status: z.enum(SELF_INVOICE_STATUSES).optional() }),
  response: { 200: output({ companyId: id(), selfInvoices: z.array(selfInvoiceView), selfInvoicesOn: z.boolean(), waits: z.string().nullable(), rule: ruleView }) },
})

export const selfInvoiceCandidatesContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      companyId: id(),
      candidates: z.array(
        output({
          supplierInvoiceId: id(),
          partyId: id(),
          supplier: output({ code: z.string(), legalName: z.string(), country: z.string() }),
          number: z.string(),
          issueDate: businessDate(),
          receivedOn: businessDate(),
          source: z.string(),
          currency: z.string(),
          suggestion: output({ kind: z.enum(SELF_INVOICE_KINDS).nullable(), why: z.string() }),
          deadline: businessDate(),
          deadlineState,
        }),
      ),
      waits: z.string().nullable(),
      rule: ruleView,
    }),
  },
})

export const getSelfInvoiceContract = defineContract({ params: input({ selfInvoiceId: id() }), response: { 200: output({ selfInvoice: selfInvoiceView }) } })

export const createSelfInvoiceContract = defineContract({
  body: input({ supplierInvoiceId: id(), kind: z.enum(SELF_INVOICE_KINDS), vatRatePct: rate.optional() }),
  response: { 201: output({ selfInvoice: selfInvoiceView }) },
})

export const cancelSelfInvoiceContract = defineContract({
  params: input({ selfInvoiceId: id() }),
  body: input({ version, reason: z.string().trim().min(3).max(500) }),
  response: { 200: output({ selfInvoice: selfInvoiceView }) },
})
