import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { ALLOCATION_TARGETS, MAX_ALLOCATIONS_PER_REQUEST, PAYMENT_METHODS, PAYMENT_STATUSES } from '@nexus/factory-domain/payments/payments'
import { invoiceView } from '../invoicing/contract'

/**
 * The payments routes' contracts (B-W1-28; FIN-121, FIN-066; A2 SCR-082 "Payments", "Record a payment"): record a bank
 * transfer (and allocate it), allocate more, reverse an allocation, void; "deposit received" (record + allocate + PAID +
 * the TD02 when the rule requires one). Every amount is marked money.price.
 */

const version = z.number().int().min(1).optional()
const status = z.enum(PAYMENT_STATUSES)
const target = z.enum(ALLOCATION_TARGETS)

const allocationInput = input({ depositRequestId: id().optional(), invoiceId: id().optional(), amount: money.price(amountMinor()) })

const allocationView = output({
  id: id(),
  target,
  targetId: id(),
  amount: money.price(z.number().int()),
  reversalOfId: id().nullable(),
  /** A later row takes it back. */
  reversed: z.boolean(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
})

export const paymentView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  method: z.enum(PAYMENT_METHODS),
  amount: money.price(z.number().int()),
  currency: z.string(),
  receivedOn: z.string(),
  externalRef: z.string(),
  status,
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  allocated: money.price(z.number().int()),
  unallocated: money.price(z.number().int()),
  allocations: z.array(allocationView),
  createdAt: instant(),
  createdById: id().nullable(),
})

const one = output({ payment: paymentView })
const paymentParams = input({ paymentId: id() })
const reference = z.string().trim().min(1).max(200)

export const listPaymentsContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    partyId: id().optional(),
    status: status.optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      payments: z.array(
        output({
          id: id(),
          companyId: id(),
          partyId: id(),
          partyName: z.string(),
          method: z.enum(PAYMENT_METHODS),
          amount: money.price(z.number().int()),
          allocated: money.price(z.number().int()),
          unallocated: money.price(z.number().int()),
          currency: z.string(),
          receivedOn: z.string(),
          externalRef: z.string(),
          status,
          createdAt: instant(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getPaymentContract = defineContract({ params: paymentParams, response: { 200: one } })

export const recordPaymentContract = defineContract({
  body: input({
    companyId: id(),
    partyId: id(),
    amount: money.price(amountMinor()),
    currency: currency().optional(),
    receivedOn: businessDate(),
    externalRef: reference,
    internalNote: z.string().trim().max(2000).nullish(),
    allocations: z.array(allocationInput).max(MAX_ALLOCATIONS_PER_REQUEST).optional(),
  }),
  response: { 201: one },
})

export const allocateContract = defineContract({ params: paymentParams, body: input({ version, allocations: z.array(allocationInput).min(1).max(MAX_ALLOCATIONS_PER_REQUEST) }), response: { 200: one } })

export const reverseContract = defineContract({ params: input({ paymentId: id(), allocationId: id() }), body: input({ note: z.string().trim().min(1).max(500) }), response: { 200: one } })

export const voidContract = defineContract({ params: paymentParams, body: input({ version, reason: z.string().trim().min(1).max(500) }), response: { 200: one } })

export const depositReceivedContract = defineContract({
  body: input({
    depositRequestId: id(),
    amount: money.price(amountMinor()),
    receivedOn: businessDate(),
    externalRef: reference,
    internalNote: z.string().trim().max(2000).nullish(),
    /** Default true: issue the TD02 now when the rule requires one (needs invoices.issue and a fresh step-up). */
    issueDepositInvoice: z.boolean().optional(),
  }),
  response: {
    201: output({
      payment: paymentView,
      depositRequest: output({ id: id(), status: z.string() }),
      depositInvoice: output({
        required: z.boolean(),
        reason: z.string(),
        ruleNow: z.string().nullable(),
        invoice: invoiceView.nullable(),
        filesPending: z.boolean(),
        filesProblem: z.string().nullable(),
      }),
    }),
  },
})


// ---- the deposit page by link (DEPOSIT_INFO) ---------------------------------------------------------------------------

/** Office: mail the deposit page's link to the quote's contact (an OPEN request). The link's token is never in an answer. */
export const sendDepositLinkContract = defineContract({
  params: input({ depositRequestId: id() }),
  body: input({ message: z.string().trim().max(2000).optional() }),
  response: {
    201: output({
      link: output({ id: id(), expiresAt: instant(), to: z.string(), revokedLinkIds: z.array(id()) }),
      emailId: id(),
      /** How the mail went at once (email out's delivery outcome), or `replayed` for a repeat of the request. */
      delivery: z.enum(['sent', 'failed', 'retry', 'settled', 'replayed']),
    }),
  },
})

/** The customer's deposit page: the request, the quote and order it belongs to, and how to pay (price grain). */
export const depositLinkViewContract = defineContract({
  response: {
    200: output({
      deposit: output({
        kind: z.string(),
        depositPct: z.string().nullable(),
        currency: currency(),
        amount: money.price(z.number().int()),
        dueDate: businessDate(),
        status: z.string(),
        paid: z.boolean(),
      }),
      quote: output({ document: z.string() }),
      order: output({ number: z.string() }).nullable(),
      from: output({ legalName: z.string(), tradeName: z.string().nullable() }),
      instructions: output({
        method: z.literal('BANK_TRANSFER'),
        amount: money.price(z.number().int()),
        currency: z.string(),
        dueDate: z.string(),
        reference: z.string(),
        bank: output({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
        text: z.string(),
      }),
      expiresAt: instant(),
    }),
  },
})
