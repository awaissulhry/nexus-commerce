import { z } from 'zod'
import { periodLockLineView, periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { CHARGE_KINDS } from '@nexus/factory-domain/invoicing/charges/charges'
import { INVOICE_DOC_TYPES, INVOICE_LINE_KINDS, INVOICE_STATUSES, MAX_CAUSALE, MAX_DESCRIPTION, MAX_INVOICE_LINES, PRICE_BASES } from '@nexus/factory-domain/invoicing/invoices'
import { money, notMoney } from '@nexus/factory-domain/money/marked'

/**
 * The invoicing routes' contracts (B-W1-28; A2 SCR-080 "Invoices", SCR-081 "Invoice record", SCR-083): drafts (generic
 * TD01/TD24, a TD02 from a deposit request), their lines and text, the checks before issue, the issue (step-up), the
 * files of an issued invoice. Every amount and price is marked money.price: the API drops it for staff without the
 * grain and refuses a body that sends one. A version is the edit-conflict guard (COL-078).
 */

const version = z.number().int().min(1).optional()
const docType = z.enum(INVOICE_DOC_TYPES)
const status = z.enum(INVOICE_STATUSES)
const json = z.record(z.string(), z.unknown())
const paymentMethod = z.string().regex(/^MP(0[1-9]|1[0-9]|2[0-3])$/, { message: 'Expected a FatturaPA ModalitaPagamento, MP05 for a bank transfer.' })

export const lineInput = input({
  /** B-W2a-54: CHARGE, an accessory charge (freight, packaging, samples, a fee), with `chargeKind`. */
  kind: z.enum(['GOODS', 'SERVICE', 'CHARGE']).optional(),
  chargeKind: z.enum(CHARGE_KINDS).nullish(),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION),
  itemCode: z.string().trim().max(35).nullish(),
  quantity: quantity(),
  uom: z.string().trim().max(10).nullish(),
  unitPrice: money.price(unitPrice()),
  discountPct: z.string().trim().max(12).nullish(),
  vatRatePct: z.string().trim().max(6).optional(),
  vatNature: z.string().trim().max(5).nullish(),
  vatLegalRef: z.string().trim().max(100).nullish(),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(20).nullish(),
  ddtId: id().nullish(),
})
export const paymentInput = input({ method: paymentMethod.optional(), dueDate: businessDate().nullish(), iban: z.string().trim().max(40).nullish() })
export const refInput = input({ number: z.string().trim().min(1).max(20), date: businessDate().nullish() })

const lineView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(INVOICE_LINE_KINDS),
  description: z.string(),
  itemCode: z.string().nullable(),
  quantity: z.string(),
  uom: z.string().nullable(),
  unitPrice: money.price(z.string()),
  discountPct: z.string().nullable(),
  netAmount: money.price(z.number().int()),
  grossAmount: money.price(z.number().int().nullable()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatLegalRef: z.string().nullable(),
  salesOrderLineId: id().nullable(),
  size: z.string().nullable(),
  ddtId: id().nullable(),
  depositInvoiceId: id().nullable(),
  /** B-W2a-54: CHARGE only, what it bills; the step of the order's payment schedule the line bills (a TD02's deposit). */
  chargeKind: z.enum(CHARGE_KINDS).nullable(),
  milestoneId: id().nullable(),
  /** B-W2a-61: a credit note's line crediting a customer return's line (the RMA's line). */
  returnLineId: id().nullable(),
})

/** A legal invoicing deadline (DPR 633/1972 art. 21 c.4), in words, with the days left (factory-domain from-shipment/deadlines). */
export const deadlineView = output({ docType: z.enum(['TD01', 'TD24']), dueBy: z.string(), daysLeft: z.number().int(), state: z.enum(['OPEN', 'DUE_SOON', 'LATE']), words: z.string() })

const vatSummaryEntry = output({ rate: z.string().nullable(), nature: z.string().nullable(), legalRef: z.string().nullable(), taxable: z.number().int(), vat: z.number().int(), rounding: z.number().int() })

export const invoiceView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  buyerPartyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  docType,
  status,
  numberSeriesId: id().nullable(),
  number: z.string().nullable(),
  year: z.number().int().nullable(),
  issueDate: z.string().nullable(),
  issuedAt: instant().nullable(),
  issuedById: id().nullable(),
  currency: z.string(),
  priceBasis: notMoney(z.enum(PRICE_BASES)),
  seller: json.nullable(),
  billTo: json,
  netTotal: money.price(z.number().int()),
  vatTotal: money.price(z.number().int()),
  grossTotal: money.price(z.number().int()),
  vatSummary: money.price(z.array(vatSummaryEntry)),
  stampDutyAmount: money.price(z.number().int().nullable()),
  paymentTerms: money.price(json.nullable()),
  causale: z.string().nullable(),
  documentRefs: z.array(z.unknown()).nullable(),
  salesOrderId: id().nullable(),
  depositRequestId: id().nullable(),
  creditOfId: id().nullable(),
  xmlFileId: id().nullable(),
  pdfFileId: id().nullable(),
  /** Issued, and its XML or PDF is not stored yet. */
  filesPending: z.boolean(),
  internalNote: z.string().nullable(),
  /** What payments pay on it (TD01, TD24). */
  paidAmount: money.price(z.number().int()),
  /** B-W1-51: the gross of its issued credit notes; what it still asks (gross less credits less paid); a refund due. */
  creditedAmount: money.price(z.number().int()),
  openAmount: money.price(z.number().int()),
  refundDueAmount: money.price(z.number().int()),
  /** B-W2a-54 (FIN-065): a DRAFT TD01/TD24 of shipped goods — the last day to issue it, counted down; else null. */
  deadline: deadlineView.nullable(),
  lines: z.array(lineView),
  createdAt: instant(),
  updatedAt: instant(),
})

const one = output({ invoice: invoiceView })
const invoiceParams = input({ invoiceId: id() })

export const listInvoicesContract = defineContract({
  querystring: input({
    docType: docType.optional(),
    status: status.optional(),
    companyId: id().optional(),
    partyId: id().optional(),
    depositRequestId: id().optional(),
    /** The issue date's period (drafts have none). */
    from: businessDate().optional(),
    to: businessDate().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      invoices: z.array(
        output({
          id: id(),
          docType,
          status,
          number: z.string().nullable(),
          issueDate: z.string().nullable(),
          companyId: id(),
          buyerPartyId: id(),
          partyName: z.string(),
          currency: z.string(),
          netTotal: money.price(z.number().int()),
          vatTotal: money.price(z.number().int()),
          grossTotal: money.price(z.number().int()),
          depositRequestId: id().nullable(),
          /** A credit note's invoice; the sales order it bills (when one). */
          creditOfId: id().nullable(),
          salesOrderId: id().nullable(),
          filesPending: z.boolean(),
          /** What payments pay on it, its issued credit notes, what it still asks (0 for a draft, a TD02, a TD04). */
          paidAmount: money.price(z.number().int()),
          creditedAmount: money.price(z.number().int()),
          openAmount: money.price(z.number().int()),
          /** The payment terms' due date, when the invoice has one. */
          dueDate: z.string().nullable(),
          version: z.number().int(),
          createdAt: instant(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getInvoiceContract = defineContract({ params: invoiceParams, response: { 200: one } })

export const createDraftContract = defineContract({
  body: input({
    companyId: id(),
    buyerPartyId: id(),
    docType: z.enum(['TD01', 'TD24']),
    priceBasis: notMoney(z.enum(PRICE_BASES).optional()),
    salesOrderId: id().nullish(),
    causale: z.string().trim().max(MAX_CAUSALE).nullish(),
    documentRefs: z.array(refInput).max(20).optional(),
    payment: paymentInput.nullish(),
    internalNote: z.string().trim().max(4000).nullish(),
    lines: z.array(lineInput).max(MAX_INVOICE_LINES),
  }),
  response: { 201: one },
})

export const depositDraftContract = defineContract({ body: input({ depositRequestId: id() }), response: { 201: one } })

export const updateDraftContract = defineContract({
  params: invoiceParams,
  body: input({
    version,
    priceBasis: notMoney(z.enum(PRICE_BASES).optional()),
    causale: z.string().trim().max(MAX_CAUSALE).nullish(),
    documentRefs: z.array(refInput).max(20).nullish(),
    payment: paymentInput.nullish(),
    internalNote: z.string().trim().max(4000).nullish(),
  }),
  response: { 200: one },
})

export const replaceLinesContract = defineContract({ params: invoiceParams, body: input({ version, lines: z.array(lineInput).max(MAX_INVOICE_LINES) }), response: { 200: one } })

export const deleteDraftContract = defineContract({
  params: invoiceParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: { 200: output({ deleted: z.literal(true), id: id() }) },
})

export const checksContract = defineContract({
  params: invoiceParams,
  response: {
    200: output({
      ready: z.boolean(),
      problems: z.array(output({ code: z.string(), path: z.string(), message: z.string() })),
      /** The number the series would give now (taken only at issue). */
      numberPreview: z.string().nullable(),
      issueDate: z.string(),
      /** B-W2b-22: the month lock over today (the issue date): HARD is also a PERIOD_LOCKED problem; SOFT asks for periodLockOverride.reason at issue. null: none. */
      periodLock: periodLockLineView.nullable(),
    }),
  },
})

const issued = output({ invoice: invoiceView, filesPending: z.boolean(), filesProblem: z.string().nullable() })

export const issueContract = defineContract({
  params: invoiceParams,
  body: input({
    version,
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 200: issued },
})

export const makeFilesContract = defineContract({ params: invoiceParams, response: { 200: one } })

/**
 * The records an invoice record shows beside its own (A2 SCR-081): the DDTs it cites, the deposit invoices it deducts,
 * the invoice it credits, its credit notes, the payments placed on it, its orders and their deposit requests.
 */
export const relatedContract = defineContract({
  params: invoiceParams,
  response: {
    200: output({
      related: output({
        ddts: z.array(output({ id: id(), number: z.string(), date: z.string(), shipmentId: id(), shipmentNumber: z.string() })),
        depositInvoices: z.array(output({ id: id(), number: z.string().nullable(), issueDate: z.string().nullable(), status, depositRequestId: id().nullable() })),
        creditOf: output({ id: id(), docType, number: z.string().nullable(), issueDate: z.string().nullable(), status }).nullable(),
        creditNotes: z.array(output({ id: id(), number: z.string().nullable(), issueDate: z.string().nullable(), status, grossTotal: money.price(z.number().int()) })),
        payments: z.array(
          output({
            allocationId: id(),
            paymentId: id(),
            externalRef: z.string(),
            receivedOn: z.string(),
            paymentStatus: z.string(),
            amount: money.price(z.number().int()),
            /** A reversal row takes back the allocation it names; `reversed`: a later row took this one back. */
            reversalOfId: id().nullable(),
            reversed: z.boolean(),
            note: z.string().nullable(),
            createdAt: instant(),
          }),
        ),
        orders: z.array(output({ id: id(), number: z.string() })),
        depositRequests: z.array(
          output({
            id: id(),
            orderId: id().nullable(),
            kind: z.string(),
            depositPct: z.string().nullable(),
            currency: z.string(),
            amount: money.price(z.number().int()),
            paidAmount: money.price(z.number().int()),
            dueDate: z.string(),
            fiscalDocument: z.string(),
            status: z.string(),
            paidAt: instant().nullable(),
            depositInvoices: z.array(output({ id: id(), number: z.string().nullable(), status, issueDate: z.string().nullable() })),
          }),
        ),
      }),
    }),
  },
})

/**
 * Finance settings as invoicing reads them (A2 SCR-083; settings.ts): per company the seller data an invoice header
 * takes and what is missing, the SDI connection, the legal archive, the next number of each fiscal series. No money.
 */
export const settingsContract = defineContract({
  response: {
    200: output({
      settings: output({
        asOf: businessDate(),
        companies: z.array(
          output({
            id: id(),
            code: z.string(),
            legalName: z.string(),
            identity: output({
              vatNumber: z.string().nullable(),
              fiscalCode: z.string().nullable(),
              regimeFiscale: z.string().nullable(),
              reaOffice: z.string().nullable(),
              reaNumber: z.string().nullable(),
              shareCapital: z.string().nullable(),
              soleShareholder: z.boolean(),
              inLiquidation: z.boolean(),
              address: output({ line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
            }).nullable(),
            seller: output({ ready: z.boolean(), problems: z.array(output({ path: z.string(), message: z.string() })) }),
            sdi: output({
              state: z.enum(['NONE', 'ACTIVE', 'PAUSED', 'SEVERAL']),
              accounts: z.array(output({ id: id(), label: z.string(), mode: z.enum(['LIVE', 'SANDBOX', 'FAKE']), status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']) })),
            }),
            archive: output({ archivedSends: z.number().int(), lastArchivedAt: instant().nullable() }),
            series: z.array(output({ kind: z.enum(['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']), next: z.string().nullable() })),
          }),
        ),
      }),
    }),
  },
})
