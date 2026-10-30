import { z } from 'zod'
import { amountMinor, businessDate, defineContract, id, input, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { CREDIT_REASONS } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { INVOICE_DOC_TYPES, MAX_CAUSALE, MAX_DESCRIPTION, PRICE_BASES } from '@nexus/factory-domain/invoicing/invoices'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { INVOICE_TIMINGS } from '@nexus/factory-domain/sales/terms/terms'
import { deadlineView, invoiceView, paymentInput } from '../contract'

/**
 * The contracts of B-W1-51's routes (A2 SCR-080 "Shipped, not invoiced", "Invoice shipped goods", SCR-081 "Credit note
 * for …", "Deposits & payments"): money marked with the price grain (dropped for staff without it; a body that sends one
 * is refused).
 */

const shipType = z.enum(['TD01', 'TD24'])
const deadline = deadlineView

export const shippedNotInvoicedContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional() }),
  response: {
    200: output({
      asOf: businessDate(),
      customers: z.array(
        output({
          partyId: id(),
          companyId: id(),
          code: z.string(),
          legalName: z.string(),
          /** B-W2a-54: how the customer is invoiced (Party.invoiceTiming) and the type its goods get by default. */
          invoiceTiming: z.enum(INVOICE_TIMINGS),
          preset: shipType,
          valueAmount: money.price(z.number().int()),
          oldestDate: z.string(),
          /** Per month of DDTs: the type the rule suggests for them together and its deadline. */
          months: z.array(output({ month: z.string(), ddtIds: z.array(id()), suggested: shipType.nullable(), allowed: z.array(shipType), deadline: deadline.nullable(), words: z.string() })),
          ddts: z.array(
            output({
              ddtId: id(),
              number: z.string(),
              date: z.string(),
              companyId: id(),
              partyId: id(),
              shipmentId: id(),
              shipmentNumber: z.string(),
              orders: z.array(output({ id: id(), number: z.string() })),
              lines: z.array(
                output({
                  salesOrderLineId: id(),
                  orderId: id().nullable(),
                  orderNumber: z.string().nullable(),
                  description: z.string().nullable(),
                  size: z.string(),
                  shipped: z.string(),
                  invoiced: z.string(),
                  inDraft: z.string(),
                  notInvoiced: z.string(),
                  unitPrice: money.price(z.string().nullable()),
                  netAmount: money.price(z.number().int().nullable()),
                  drafts: z.array(id()),
                }),
              ),
              valueAmount: money.price(z.number().int()),
              depositPaidAmount: money.price(z.number().int()),
              drafts: z.array(id()),
              /** The DDT's own limit as an immediate invoice (12 days). */
              immediate: deadline,
              /** B-W2a-54 (FIN-065): its deadline by the customer's preset — the day the date timers count down to. */
              deadline,
              /** B-W2a-54 (FIN-060): its shipment's freight (null: not decided), and whether an invoice or a draft bills it. */
              freight: output({ amount: money.price(z.number().int().nullable()), currency: z.string(), billed: z.boolean() }),
            }),
          ),
        }),
      ),
    }),
  },
})

const choice = output({
  docType: shipType.nullable(),
  suggested: shipType.nullable(),
  allowed: z.array(shipType),
  deadline: deadline.nullable(),
  immediate: deadline.nullable(),
  deferred: deadline.nullable(),
  words: z.string(),
})

/** B-W2a-54 (FIN-058): a part of the DDTs' goods: so many garments of a DDT's order line and size. */
const partInput = input({ ddtId: id(), salesOrderLineId: id(), size: z.string().trim().min(1).max(20), quantity: z.number().int().min(1).max(1_000_000) })
const freightLeft = output({ ddtId: id(), number: z.string(), reason: z.string() })

export const fromDdtsContract = defineContract({
  body: input({
    ddtIds: z.array(id()).min(1).max(100),
    /** The office's pick; left out: the customer's preset when the law allows it, else the rule's. */
    docType: shipType.optional(),
    /** B-W2a-54: only these garments (partial invoicing); left out: all that is left of the DDTs. */
    lines: z.array(partInput).min(1).max(500).optional(),
    /** B-W2a-54: the shipments' freight as charge lines (default true). */
    freight: z.boolean().optional(),
    causale: z.string().trim().max(MAX_CAUSALE).nullish(),
    payment: paymentInput.nullish(),
    internalNote: z.string().trim().max(4000).nullish(),
  }),
  response: {
    201: output({
      invoice: invoiceView,
      choice,
      /** The deposit invoices of the orders not deducted here, and why. */
      deductions: z.array(output({ depositInvoiceId: id(), number: z.string().nullable(), reason: z.string() })),
      /** B-W2a-54: the shipments' freight not billed here, and why. */
      freight: z.array(freightLeft),
    }),
  },
})

/** B-W2a-54 (FIN-059): the deferred invoices due — per customer, company and month, the DDTs a TD24 takes. */
export const deferredContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional() }),
  response: {
    200: output({
      asOf: businessDate(),
      /** The tile "Deferred invoices due by the 15th": how many are open, due within 3 days, late. */
      counts: output({ groups: z.number().int(), open: z.number().int(), dueSoon: z.number().int(), late: z.number().int() }),
      groups: z.array(
        output({
          companyId: id(),
          partyId: id(),
          code: z.string(),
          legalName: z.string(),
          invoiceTiming: z.enum(INVOICE_TIMINGS),
          month: z.string(),
          ddts: z.array(output({ ddtId: id(), number: z.string(), date: z.string(), shipmentNumber: z.string() })),
          valueAmount: money.price(z.number().int()),
          /** The shipments' freight still to bill. */
          freightAmount: money.price(z.number().int()),
          drafts: z.array(id()),
          deadline: deadline.nullable(),
          words: z.string(),
        }),
      ),
    }),
  },
})

/** B-W2a-54 (FIN-059): one TD24 draft of a customer's month of DDTs. */
export const createDeferredContract = defineContract({
  body: input({
    companyId: id(),
    partyId: id(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Expected a month, YYYY-MM.' }),
    freight: z.boolean().optional(),
    causale: z.string().trim().max(MAX_CAUSALE).nullish(),
    payment: paymentInput.nullish(),
    internalNote: z.string().trim().max(4000).nullish(),
  }),
  response: {
    201: output({ invoice: invoiceView, choice, deductions: z.array(output({ depositInvoiceId: id(), number: z.string().nullable(), reason: z.string() })), freight: z.array(freightLeft) }),
  },
})

/** B-W2a-54 (FIN-058): the invoice of a step of an order's payment schedule (a deposit step: its TD02). */
export const fromMilestoneContract = defineContract({ body: input({ milestoneId: id() }), response: { 201: output({ invoice: invoiceView }) } })

export const removeDeductionContract = defineContract({
  params: input({ invoiceId: id(), lineId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: { 200: output({ invoice: invoiceView }) },
})

const docType = z.enum(INVOICE_DOC_TYPES)

export const settlementContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      settlement: output({
        orderId: id(),
        number: z.string(),
        settled: z.boolean(),
        /** What is missing, as codes (factory-domain invoicing/from-shipment/settlement SettlementGap). */
        gaps: z.array(z.string()),
        /** The same in words (they may name amounts: price grain). */
        missing: money.price(z.array(output({ code: z.string(), message: z.string() }))),
        fullyShipped: z.boolean(),
        fullyInvoiced: z.boolean(),
        documentsFinal: z.boolean(),
        lines: z.array(
          output({ salesOrderLineId: id(), seq: z.number().int(), description: z.string(), size: z.string().nullable(), ordered: z.number().int(), shipped: z.number().int(), invoiced: z.string(), toShip: z.number().int(), closedShort: z.number().int(), toInvoice: z.string() }),
        ),
        invoices: z.array(
          output({
            id: id(),
            docType,
            number: z.string().nullable(),
            status: z.string(),
            grossTotal: money.price(z.number().int()),
            creditedAmount: money.price(z.number().int()),
            paidAmount: money.price(z.number().int()),
            openAmount: money.price(z.number().int()),
            refundDueAmount: money.price(z.number().int()),
          }),
        ),
        invoicedAmount: money.price(z.number().int()),
        creditedAmount: money.price(z.number().int()),
        paidAmount: money.price(z.number().int()),
        depositsPaidWithoutInvoiceAmount: money.price(z.number().int()),
        balanceDueAmount: money.price(z.number().int()),
        refundDueAmount: money.price(z.number().int()),
      }),
    }),
  },
})

export const creditNoteContract = defineContract({
  params: input({ invoiceId: id() }),
  body: input({
    reason: z.enum(CREDIT_REASONS),
    reasonText: z.string().trim().max(500).nullish(),
    /** The whole invoice (nothing of it credited yet). */
    full: z.boolean().optional(),
    /** Some of its lines: each at most its quantity, at its price or lower. */
    lines: z.array(input({ lineId: id(), quantity: quantity().optional(), unitPrice: money.price(unitPrice()) })).max(500).optional(),
    /** An amount (minor units) at one of its VAT treatments, net or VAT included. */
    amount: money.price(amountMinor()),
    amountBasis: notMoney(z.enum(PRICE_BASES).optional()),
    vatRatePct: z.string().trim().max(6).optional(),
    vatNature: z.string().trim().max(5).nullish(),
    vatLegalRef: z.string().trim().max(100).nullish(),
    description: z.string().trim().max(MAX_DESCRIPTION).nullish(),
    internalNote: z.string().trim().max(4000).nullish(),
  }),
  response: { 201: output({ invoice: invoiceView, creditableAmount: money.price(z.number().int()), refundDueAmount: money.price(z.number().int()) }) },
})
