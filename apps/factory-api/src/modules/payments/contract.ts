import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { ALLOCATION_TARGETS, MAX_ALLOCATIONS_PER_REQUEST, PAYMENT_METHODS, PAYMENT_STATUSES } from '@nexus/factory-domain/payments/payments'
import { REFUND_SOURCES, REFUND_STATUSES, REFUND_VIEWS } from '@nexus/factory-domain/payments/refunds'
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

/** What a target is called: an invoice's number and type (and its order), a deposit request's order number. */
const targetLabel = output({ number: z.string().nullable(), docType: z.string().nullable(), orderNumber: z.string().nullable() })

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
  label: targetLabel.nullable(),
})

/** Per target, what the payment pays on it now (its allocations less their reversals, above 0). */
const placedOnView = z.array(output({ target, targetId: id(), amount: money.price(z.number().int()), number: z.string().nullable(), docType: z.string().nullable(), orderNumber: z.string().nullable() }))

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
  /** What pays nothing: the customer's credit balance on this payment (amount − allocations − B-W2a-61's live refunds). */
  unallocated: money.price(z.number().int()),
  /** B-W2a-61: what its live refunds (DUE or PAID) take of it, and those refunds. */
  refunded: money.price(z.number().int()),
  refunds: z.array(output({ id: id(), status: z.enum(REFUND_STATUSES), amount: money.price(z.number().int()), dueDate: z.string().nullable(), paidOn: z.string().nullable() })),
  allocations: z.array(allocationView),
  placedOn: placedOnView,
  createdAt: instant(),
  createdById: id().nullable(),
  /** Who recorded it and placed it (names inside the one record). */
  people: z.array(output({ id: id(), name: z.string() })),
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
          refunded: money.price(z.number().int()),
          currency: z.string(),
          receivedOn: z.string(),
          externalRef: z.string(),
          status,
          placedOn: placedOnView,
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
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: one },
})

export const allocateContract = defineContract({ params: paymentParams, body: input({ version, allocations: z.array(allocationInput).min(1).max(MAX_ALLOCATIONS_PER_REQUEST) }), response: { 200: one } })

export const reverseContract = defineContract({ params: input({ paymentId: id(), allocationId: id() }), body: input({ note: z.string().trim().min(1).max(500) }), response: { 200: one } })

export const voidContract = defineContract({
  params: paymentParams,
  body: input({
    version,
    reason: z.string().trim().min(1).max(500),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 200: one },
})

export const depositReceivedContract = defineContract({
  body: input({
    depositRequestId: id(),
    amount: money.price(amountMinor()),
    receivedOn: businessDate(),
    externalRef: reference,
    internalNote: z.string().trim().max(2000).nullish(),
    /** Default true: issue the TD02 now when the rule requires one (needs invoices.issue and a fresh step-up). */
    issueDepositInvoice: z.boolean().optional(),
    periodLockOverride: periodLockOverride.optional(),
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

/**
 * Office: mail the deposit page's link to the quote's contact (an OPEN request). The link's token is never in an answer.
 * B-W2b-16: a request made on an order (no quote) goes to `contactId`, else the INVOICES contact, else the ORDERS one.
 */
export const sendDepositLinkContract = defineContract({
  params: input({ depositRequestId: id() }),
  body: input({ message: z.string().trim().max(2000).optional(), contactId: id().optional() }),
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
      /** B-W2b-16: null for a request made on an order without a quote (the order names it). */
      quote: output({ document: z.string() }).nullable(),
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

/**
 * A customer's open items, oldest first (A2 SCR-082 "Record a payment", step 2 "where it goes"): its OPEN deposit
 * requests and its issued TD01/TD24 invoices that still ask money, each with what is still open (the cap of an
 * allocation). A TD02 is paid through its deposit request; a TD04 asks nothing.
 */
export const openItemsContract = defineContract({
  querystring: input({
    companyId: id(),
    partyId: id(),
    /** B-W2a-61: the matcher's "Suggest" for this payment's unplaced part, or for an amount typed (minor units). */
    paymentId: id().optional(),
    amount: money.price(z.coerce.number().int().min(0).max(2_147_483_647)),
  }),
  response: {
    200: output({
      items: z.array(
        output({
          target,
          id: id(),
          /** The invoice's number; a deposit request has none (its order's number names it). */
          number: z.string().nullable(),
          docType: z.string().nullable(),
          /** A deposit request: the document its payment brings (TD02, or NONE by its VAT rule). */
          fiscalDocument: z.enum(['TD02', 'NONE']).nullable(),
          /** B-W2a-61: a deposit request's step of the payment schedule (B-W2a-F2: the balance before shipping too). */
          stepKind: z.enum(['DEPOSIT', 'BEFORE_SHIPPING']).nullable(),
          orderId: id().nullable(),
          orderNumber: z.string().nullable(),
          /** The invoice's issue date, the request's creation day. */
          date: z.string(),
          dueDate: z.string().nullable(),
          currency: z.string(),
          amount: money.price(z.number().int()),
          openAmount: money.price(z.number().int()),
          /** B-W2a-61: with paymentId or amount, what "Suggest" places on it (oldest first). */
          suggestedAmount: money.price(z.number().int()),
          /** B-W2a-61: an invoice of an order whose deposit was paid on a request that issues no TD02 (NONE): what it holds. */
          noInvoiceDepositAmount: money.price(z.number().int().nullable()),
        }),
      ),
      /** B-W2a-61: what is left to place, and what stays on the payment after the suggestion (the credit balance). */
      left: output({ amount: money.price(z.number().int()), afterSuggestion: money.price(z.number().int()) }).nullable(),
      /** B-W2a-61: the customer's credit balance per currency (its RECEIVED payments' unplaced parts). */
      creditBalance: z.array(output({ currency: z.string(), amount: money.price(z.number().int()) })),
    }),
  },
})

// ---- B-W2a-61: refunds (FIN-127) and the credit balance (FIN-122) -------------------------------------------------------

const refundStatus = z.enum(REFUND_STATUSES)
const refundBase = {
  id: id(),
  version: z.number().int(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  source: z.enum(REFUND_SOURCES),
  creditNote: output({ id: id(), number: z.string().nullable(), issueDate: z.string().nullable(), creditOfId: id().nullable(), creditOfNumber: z.string().nullable(), creditOfDocType: z.string().nullable() }).nullable(),
  payment: output({ id: id(), receivedOn: z.string(), externalRef: z.string() }).nullable(),
  method: z.enum(PAYMENT_METHODS),
  amount: money.price(z.number().int()),
  currency: z.string(),
  dueDate: z.string().nullable(),
  status: refundStatus,
  paidOn: z.string().nullable(),
  externalRef: z.string().nullable(),
  paidAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant(),
}
const refundRow = output(refundBase)
/** The record: who recorded it and who paid it (names, inside the one record). */
export const refundView = output({ ...refundBase, createdById: id().nullable(), paidById: id().nullable(), people: z.array(output({ id: id(), name: z.string() })) })
const oneRefund = output({ refund: refundView })
const refundParams = input({ refundId: id() })
const requiredVersion = z.number().int().min(1)

export const listRefundsContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional(), view: z.enum(REFUND_VIEWS).optional(), creditNoteId: id().optional(), paymentId: id().optional(), cursor: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ refunds: z.array(refundRow), nextCursor: id().nullable() }) },
})

/** "Refunds to make": the DUE refunds and the credit notes with money left to refund (the tile's counts). */
export const openRefundsContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional() }),
  response: {
    200: output({
      counts: output({ refundsDue: z.number().int(), creditNotesToRefund: z.number().int() }),
      refundsDue: z.array(refundRow),
      creditNotesToRefund: z.array(
        output({
          creditNoteId: id(),
          number: z.string().nullable(),
          issueDate: z.string().nullable(),
          companyId: id(),
          partyId: id(),
          party: output({ code: z.string(), legalName: z.string() }),
          currency: z.string(),
          grossTotal: money.price(z.number().int()),
          creditOfId: id(),
          creditOfNumber: z.string().nullable(),
          creditOfDocType: z.string(),
          orderNumber: z.string().nullable(),
          /** What its live refunds (DUE or PAID) take already, and what is left to refund. */
          refundedAmount: money.price(z.number().int()),
          refundableAmount: money.price(z.number().int()),
        }),
      ),
      asOf: instant(),
    }),
  },
})

export const getRefundContract = defineContract({ params: refundParams, response: { 200: oneRefund } })

export const recordRefundContract = defineContract({
  body: input({
    creditNoteId: id().optional(),
    paymentId: id().optional(),
    /** Absent: all that is refundable. */
    amount: money.price(amountMinor()),
    dueDate: businessDate().nullish(),
    internalNote: z.string().trim().max(2000).nullish(),
    /** Recorded as made already: the transfer's value date and the bank's reference (CRO / TRN). */
    paid: input({ paidOn: businessDate(), externalRef: reference }).optional(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: oneRefund },
})

export const changeRefundContract = defineContract({
  params: refundParams,
  body: input({ version: requiredVersion, amount: money.price(amountMinor()), dueDate: businessDate().nullish(), internalNote: z.string().trim().max(2000).nullish() }),
  response: { 200: oneRefund },
})

export const payRefundContract = defineContract({
  params: refundParams,
  body: input({
    version: requiredVersion,
    paidOn: businessDate(),
    externalRef: reference,
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 200: oneRefund },
})

export const cancelRefundContract = defineContract({ params: refundParams, body: input({ version: requiredVersion, reason: z.string().trim().min(1).max(500) }), response: { 200: oneRefund } })

export const voidRefundContract = defineContract({
  params: refundParams,
  body: input({
    version: requiredVersion,
    reason: z.string().trim().min(1).max(500),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 200: oneRefund },
})

const balances = z.array(output({ currency: z.string(), amount: money.price(z.number().int()) }))

/** A customer's credit balance in a company and the payments that hold it, oldest first. */
export const creditBalanceContract = defineContract({
  querystring: input({ companyId: id(), partyId: id() }),
  response: {
    200: output({
      companyId: id(),
      partyId: id(),
      balances,
      payments: z.array(
        output({
          id: id(),
          receivedOn: z.string(),
          externalRef: z.string(),
          currency: z.string(),
          amount: money.price(z.number().int()),
          allocated: money.price(z.number().int()),
          refunded: money.price(z.number().int()),
          unplacedAmount: money.price(z.number().int()),
        }),
      ),
    }),
  },
})

/** "Carry the credit": an invoice's overpayment after its credit notes goes back to its payments' unplaced part. */
export const releaseOverpaymentContract = defineContract({
  body: input({ invoiceId: id(), note: z.string().trim().min(1).max(500) }),
  response: {
    200: output({
      invoice: output({ id: id(), number: z.string().nullable(), paidAmount: money.price(z.number().int()), worthAmount: money.price(z.number().int()) }),
      releasedAmount: money.price(z.number().int()),
      payments: z.array(output({ paymentId: id(), unplacedAmount: money.price(z.number().int()) })),
      balances,
    }),
  },
})
