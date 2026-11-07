import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { INTENT_METHODS, INTENT_STATUSES, INTENT_TARGETS } from '@nexus/factory-domain/payments/online/rules'
import { FAKE_SCENARIOS } from '../../../adapters/payment-fake/fake'

/**
 * Paying online, the contracts (B-W2b-185; FIN-118, FIN-123; design links.pay, portal.customer.documents "To pay" and its
 * pop-up "Pay invoice", the statement new tab). Every amount is marked money.price: a session without the price grain gets
 * none. Never a card number, a mandate, the provider account or an office person's name; the client secret only in the
 * answer that starts (or takes up again) a payment.
 */

const method = z.enum(INTENT_METHODS)
const target = z.enum(INTENT_TARGETS)
const words = output({ it: z.string(), en: z.string() })

export const intentOut = output({
  id: id(),
  target,
  targetId: id(),
  method,
  amount: money.price(z.number().int()),
  currency: z.string(),
  status: z.enum(INTENT_STATUSES),
  /** The provider's id ("pi_…"): the payment's reference. */
  providerRef: z.string().nullable(),
  failureCode: z.string().nullable(),
  /** FAILED: the provider's reason in the person's language. */
  failure: z.string().nullable(),
  finishedAt: instant().nullable(),
  paymentId: id().nullable(),
  createdAt: instant(),
})

const officeIntentOut = intentOut.extend({ linkId: id().nullable(), startedById: id().nullable(), providerAccountId: id(), version: z.number().int() })

/** Card and SEPA: offered (the provider, its mode, Stripe's publishable key) or why not, in words. */
const cardOut = output({
  available: z.boolean(),
  methods: z.array(method),
  provider: z.string().nullable(),
  mode: z.string().nullable(),
  publishableKey: z.string().nullable(),
  reason: z.string().nullable(),
  words: z.string().nullable(),
})

/** Bank transfer: always shown (W1, Q12), with each value to copy. */
const bankOut = output({
  method: z.literal('BANK_TRANSFER'),
  amount: money.price(z.number().int()),
  currency: z.string(),
  dueDate: z.string().nullable(),
  reference: z.string(),
  bank: output({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
  text: z.string(),
})

const whatOut = output({
  target,
  id: id(),
  label: z.string(),
  number: z.string().nullable(),
  orderNumber: z.string().nullable(),
  quoteDocument: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  total: money.price(z.number().int()),
  /** Paid and credited so far. */
  settled: money.price(z.number().int()),
  /** Still to pay. */
  open: money.price(z.number().int()),
})

const startedOut = output({
  intent: intentOut,
  /** What the page loads the provider's own fields with (the client secret: never stored, never shown again). */
  provider: output({ name: z.string(), mode: z.string(), clientSecret: z.string(), publishableKey: z.string().nullable() }).nullable(),
  /** The payment under way of the same payer was taken up again (a reload, a double click). */
  resumed: z.boolean(),
})

// ---- the link (PAYMENT, DEPOSIT_INFO) ----------------------------------------------------------------------------------

export const linkPayPageContract = defineContract({
  response: {
    200: output({
      what: whatOut,
      /** To pay · Paid (nothing open and something paid) · Closed (cancelled, waived, rejected: nothing to pay). */
      status: z.enum(['TO_PAY', 'PAID', 'CLOSED']),
      bank: bankOut.nullable(),
      card: cardOut,
      /** The latest payment started from this link. */
      intent: intentOut.nullable(),
      from: output({ legalName: z.string(), tradeName: z.string().nullable() }),
      language: z.enum(['it', 'en']),
      expiresAt: instant(),
      live: output({ poll: z.literal('GET /payments/link/pay/intents/:intentId') }),
    }),
  },
})

export const linkStartContract = defineContract({ body: input({ method }), response: { 201: startedOut } })
export const linkIntentContract = defineContract({ params: input({ intentId: id() }), response: { 200: output({ intent: intentOut }) } })

// ---- the portal --------------------------------------------------------------------------------------------------------

const openInvoiceOut = output({
  invoiceId: id(),
  number: z.string(),
  docType: z.string(),
  issueDate: businessDate(),
  dueDate: businessDate(),
  dueDateKnown: z.boolean(),
  /** Days past the due date (0: not late); the web says "overdue by N days". */
  daysLate: z.number().int(),
  total: money.price(z.number().int()),
  open: money.price(z.number().int()),
  currency: z.string(),
  /** The invoice's state at SDI (ISSUED, SENT, DELIVERED, NOT_DELIVERABLE, ERROR). */
  sdiStatus: z.string(),
  pdfFileId: id().nullable(),
  xmlFileId: id().nullable(),
  /** The latest online payment of it, when one was started. */
  payment: intentOut.nullable(),
  canPay: z.boolean(),
})

const openDepositOut = output({
  depositRequestId: id(),
  label: words,
  orderNumber: z.string().nullable(),
  quoteDocument: z.string().nullable(),
  dueDate: businessDate(),
  daysLate: z.number().int(),
  total: money.price(z.number().int()),
  open: money.price(z.number().int()),
  currency: z.string(),
  payment: intentOut.nullable(),
  canPay: z.boolean(),
})

export const portalOpenItemsContract = defineContract({
  response: {
    200: output({
      asOf: businessDate(),
      invoices: z.array(openInvoiceOut),
      deposits: z.array(openDepositOut),
      /** What is open and overdue, per currency. */
      byCurrency: z.array(output({ currency: z.string(), open: money.price(z.number().int()), overdue: money.price(z.number().int()) })),
      counts: output({ invoices: z.number().int(), overdue: z.number().int(), deposits: z.number().int() }),
      card: cardOut,
      /** The person may pay (portal.payments.pay); the bank transfer is always there. */
      mayPay: z.boolean(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

const statementQuery = input({ from: businessDate().optional(), to: businessDate().optional(), currency: z.string().length(3).optional(), language: z.enum(['it', 'en']).optional() })

export const portalStatementContract = defineContract({
  querystring: statementQuery,
  response: {
    200: output({
      company: output({ name: z.string() }),
      customer: output({ code: z.string(), name: z.string() }),
      currency: z.string(),
      currencies: z.array(z.string()),
      from: businessDate(),
      to: businessDate(),
      opening: money.price(z.number().int()),
      closing: money.price(z.number().int()),
      totals: money.price(output({ invoiced: z.number().int(), credited: z.number().int(), paid: z.number().int(), refunded: z.number().int() })),
      lines: z.array(
        output({
          kind: z.string(),
          date: businessDate(),
          recordType: z.string(),
          recordId: id(),
          reference: z.string().nullable(),
          docType: z.string().nullable(),
          dueDate: z.string().nullable(),
          label: z.string(),
          debit: money.price(z.number().int()),
          credit: money.price(z.number().int()),
          balance: money.price(z.number().int()),
        }),
      ),
      openItems: z.array(output({ invoiceId: id(), number: z.string(), dueDate: businessDate(), open: money.price(z.number().int()), daysLate: z.number().int() })),
    }),
  },
})

export const portalStatementPdfContract = defineContract({ querystring: statementQuery, response: {} })

export const portalStartContract = defineContract({
  body: z.union([input({ invoiceId: id(), method }), input({ depositRequestId: id(), method })]),
  response: { 201: startedOut },
})

export const portalIntentContract = defineContract({ params: input({ intentId: id() }), response: { 200: output({ intent: intentOut }) } })

// ---- the office --------------------------------------------------------------------------------------------------------

export const sendPayLinkContract = defineContract({
  params: input({ invoiceId: id() }),
  body: input({ contactId: id().optional(), message: z.string().trim().max(2000).optional() }),
  response: {
    201: output({
      link: output({ id: id(), expiresAt: instant(), to: z.string(), revokedLinkIds: z.array(id()) }),
      emailId: id(),
      delivery: z.string(),
    }),
  },
})

export const officeIntentsContract = defineContract({
  querystring: input({ invoiceId: id().optional(), depositRequestId: id().optional() }),
  response: { 200: output({ intents: z.array(officeIntentOut) }) },
})

// ---- the FAKE provider's fields (local and test) ---------------------------------------------------------------------

export const fakeConfirmContract = defineContract({
  body: input({ clientSecret: z.string().min(1).max(400), scenario: z.enum(FAKE_SCENARIOS) }),
  response: {
    200: output({
      /** The provider's state after the scenario (Stripe's words). */
      state: z.string(),
      error: output({ code: z.string(), words: z.string() }).nullable(),
      /** Webhooks the fake provider posted to the inbound route. */
      webhooks: z.array(output({ type: z.string(), status: z.number().int() })),
    }),
  },
})
