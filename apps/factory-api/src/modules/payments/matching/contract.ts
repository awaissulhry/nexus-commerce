import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { MAX_MATCH_ITEMS } from '@nexus/factory-domain/payments/matching/match'
import { MAX_WRITE_OFF_NOTE, WRITE_OFF_REASONS } from '@nexus/factory-domain/payments/write-offs/write-offs'

/**
 * The matching routes' contracts (B-W2b-393; FIN-132, FIN-117, FIN-119; design finance.bank sec:match, finance.payments
 * tile "Not placed on an invoice"). Amounts marked money.price.
 */

const writeOff = input({ reason: z.enum(WRITE_OFF_REASONS), note: z.string().max(MAX_WRITE_OFF_NOTE).nullish() })
const accepted = output({ matchId: id(), bankLineId: id(), paymentId: id().nullable(), recorded: z.boolean() })

export const acceptMatchContract = defineContract({
  params: input({ matchId: z.string() }),
  body: input({ version: z.number().int().min(1), writeOff: writeOff.optional(), periodLockOverride: periodLockOverride.optional() }),
  response: { 200: accepted },
})

export const chooseMatchContract = defineContract({
  params: input({ lineId: z.string() }),
  body: input({
    partyId: id(),
    /** The customer's items the line pays, oldest first; an amount per item splits the line (absent: what fits). */
    items: z.array(input({ invoiceId: id().optional(), depositRequestId: id().optional(), amount: money.price(amountMinor()) })).max(MAX_MATCH_ITEMS).optional(),
    /** A payment already typed by hand that this line is (the same amount). */
    paymentId: id().optional(),
    /** Money out: the supplier invoice it paid. */
    supplierInvoiceId: id().optional(),
    writeOff: writeOff.optional(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: accepted },
})

export const acceptManyContract = defineContract({
  body: input({ companyId: id(), matches: z.array(input({ matchId: id(), version: z.number().int().min(1) })).min(1).max(50), writeOff: writeOff.optional() }),
  response: { 200: output({ companyId: id(), accepted: z.array(accepted) }) },
})

export const reverseMatchContract = defineContract({
  params: input({ matchId: z.string() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500), periodLockOverride: periodLockOverride.optional() }),
  response: { 200: output({ matchId: id(), bankLineId: id(), paymentId: id().nullable(), voided: z.boolean() }) },
})

export const refreshSuggestionsContract = defineContract({
  body: input({ companyId: id() }),
  response: { 200: output({ companyId: id(), changed: z.number().int() }) },
})

export const unappliedContract = defineContract({
  querystring: input({ companyId: id(), partyId: id().optional(), cursor: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      companyId: id(),
      tolerance: money.price(z.number().int().nullable()),
      totals: notMoney(output({ count: z.number().int(), amounts: notMoney(z.array(output({ currency: z.string(), amount: money.price(z.number().int()) }))) })),
      payments: z.array(
        output({
          id: id(),
          partyId: id(),
          party: output({ id: id(), code: z.string(), legalName: z.string() }),
          receivedOn: z.string(),
          externalRef: z.string(),
          currency: z.string(),
          amount: money.price(z.number().int()),
          unplacedAmount: money.price(z.number().int()),
          waitingDays: z.number().int(),
          openItems: z.number().int(),
          writeOffWithinTolerance: z.boolean(),
          bankLine: output({ id: id(), bookedOn: z.string() }).nullable(),
        }),
      ),
      nextCursor: z.number().int().nullable(),
    }),
  },
})
