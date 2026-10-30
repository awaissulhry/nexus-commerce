import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { RETURN_CREDIT_SKIPS } from '@nexus/factory-domain/invoicing/credit-note/from-return'
import { INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/invoices'
import { money } from '@nexus/factory-domain/money/marked'
import { REFUND_STATUSES } from '@nexus/factory-domain/payments/refunds'
import { invoiceView } from '../contract'

/**
 * The contracts of a customer return's credit notes (B-W2a-61; FIN-070; design sales.returns "Replacement & credit",
 * finance.invoices "Credit note for …" from the return inspection): money marked with the price grain (dropped for staff
 * without it).
 */

const returnParams = input({ returnId: id() })

/** A line of the RMA left out of a credit note, and why (factory-domain from-return RETURN_CREDIT_SKIPS, in words). */
const notCredited = output({ lineId: id(), seq: z.number().int(), code: z.enum(RETURN_CREDIT_SKIPS), message: z.string() })

export const returnCreditNotesContract = defineContract({
  params: returnParams,
  response: {
    200: output({
      return: output({ id: id(), number: z.string(), status: z.string(), companyId: id(), partyId: id() }),
      /** What the return's decision credits (net), and what its credit notes (drafts included) credit of it. */
      creditDecidedAmount: money.price(z.number().int()),
      creditNotedAmount: money.price(z.number().int()),
      /** Its credit notes, oldest first: the status is the SDI state (DRAFT, ISSUED, SENT, DELIVERED …). */
      creditNotes: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          status: z.enum(INVOICE_STATUSES),
          issueDate: z.string().nullable(),
          currency: z.string(),
          netTotal: money.price(z.number().int()),
          grossTotal: money.price(z.number().int()),
          creditOfId: id().nullable(),
          creditOfNumber: z.string().nullable(),
          lines: z.array(output({ returnLineId: id(), seq: z.number().int(), quantity: z.string(), netAmount: money.price(z.number().int()) })),
          refunds: z.array(output({ id: id(), status: z.enum(REFUND_STATUSES), amount: money.price(z.number().int()) })),
        }),
      ),
      /** What "Make credit note" would draft now: one note per invoice. */
      toCredit: z.array(
        output({
          creditOfId: id(),
          invoiceNumber: z.string(),
          currency: z.string(),
          netTotal: money.price(z.number().int()),
          lines: z.array(output({ returnLineId: id(), seq: z.number().int(), pieces: z.number().int(), description: z.string(), netAmount: money.price(z.number().int()) })),
        }),
      ),
      notCredited: z.array(notCredited),
    }),
  },
})

export const draftReturnCreditNotesContract = defineContract({
  params: returnParams,
  /** Some lines only; absent or empty: every decided line with a credit. */
  body: input({ lineIds: z.array(id()).max(200).optional() }),
  response: { 201: output({ creditNotes: z.array(invoiceView), notCredited: z.array(notCredited) }) },
})
