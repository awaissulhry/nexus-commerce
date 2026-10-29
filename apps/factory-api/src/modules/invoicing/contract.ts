import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
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
  kind: z.enum(['GOODS', 'SERVICE']).optional(),
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
})

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
          filesPending: z.boolean(),
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
    }),
  },
})

const issued = output({ invoice: invoiceView, filesPending: z.boolean(), filesProblem: z.string().nullable() })

export const issueContract = defineContract({ params: invoiceParams, body: input({ version }), response: { 200: issued } })

export const makeFilesContract = defineContract({ params: invoiceParams, response: { 200: one } })
