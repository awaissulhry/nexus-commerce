import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of the Finance screens (SCR-080 invoices, SCR-081 the invoice record, SCR-082 payments, SCR-083 finance
 * settings), with the answer's shape checked (zod; unknown fields are dropped, so a new API field never breaks a page).
 * The shapes mirror apps/factory-api modules/invoicing (the list, the record, the checks, the issue, SDI, invoices from
 * shipped goods, credit notes, the settings read) and modules/payments (payments, allocations, open items, deposit
 * received). Money fields are optional: the API drops what the person's grains do not reach (absent, never zero). The
 * API's English words (messages, SDI titles, deadline words) are never drawn: the screens say their own from the codes.
 */

export const INVOICE_DOC_TYPES = ['TD01', 'TD02', 'TD04', 'TD24'] as const
export type DocType = (typeof INVOICE_DOC_TYPES)[number]
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
// CHARGE: W2a's accessory charge (factory-db InvoiceLineKind, wave 7/7) with its kind (B-W2a-54; B-W2a-80 draws them).
export const LINE_KINDS = ['GOODS', 'SERVICE', 'DEPOSIT_DEDUCTION', 'CHARGE'] as const
/** What a charge line bills (factory-domain invoicing/charges CHARGE_KINDS). */
export const CHARGE_KINDS = ['FREIGHT', 'PACKAGING', 'SAMPLES', 'FEE', 'OTHER'] as const
export type ChargeKind = (typeof CHARGE_KINDS)[number]
export const SDI_STATE_CODES = ['DRAFT', 'NOT_SENT', 'SENDING', 'AT_SDI', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'ERROR'] as const
export type SdiStateCode = (typeof SDI_STATE_CODES)[number]
export const SDI_NEXT_ACTIONS = ['ISSUE', 'SEND', 'WAIT', 'FIX_AND_RESEND', 'SEND_AGAIN', 'CHECK_COPY', 'NONE'] as const
export type SdiNextAction = (typeof SDI_NEXT_ACTIONS)[number]
export const SDI_SEND_STATUSES = ['SENDING', 'SENT', 'FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'] as const
export const SDI_NOTIFICATION_TYPES = ['RC', 'MC', 'NS', 'NE', 'DT', 'AT'] as const
export const SDI_FIXES = ['party', 'company', 'lines', 'text', 'none'] as const
export type SdiFix = (typeof SDI_FIXES)[number]
export const CREDIT_REASONS = ['RETURN', 'PRICE_REDUCTION', 'DEFECT', 'BILLING_ERROR', 'DEPOSIT_REFUND', 'OTHER'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]
export const PAYMENT_STATUSES = ['RECEIVED', 'VOIDED'] as const
export const PAYMENT_METHODS = ['BANK_TRANSFER'] as const
export const ALLOCATION_TARGETS = ['DEPOSIT_REQUEST', 'INVOICE'] as const
export type AllocationTarget = (typeof ALLOCATION_TARGETS)[number]
export const DEADLINE_STATES = ['OPEN', 'DUE_SOON', 'LATE'] as const
export const SERIES_KINDS = ['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE'] as const
export const SDI_SETUP_STATES = ['NONE', 'ACTIVE', 'PAUSED', 'SEVERAL'] as const
export const INTEGRATION_MODES = ['LIVE', 'SANDBOX', 'FAKE'] as const

const instant = z.string()
const docType = z.enum(INVOICE_DOC_TYPES)
const status = z.enum(INVOICE_STATUSES)
const key = () => newIdempotencyKey()
const invoicePath = (id: string) => `/invoicing/invoices/${encodeURIComponent(id)}`

// ---- the list -----------------------------------------------------------------------------------------------------------------

export const invoiceRowSchema = z.object({
  id: z.string(),
  docType,
  status,
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  companyId: z.string(),
  buyerPartyId: z.string(),
  partyName: z.string(),
  currency: z.string(),
  netTotal: z.number().optional(),
  vatTotal: z.number().optional(),
  grossTotal: z.number().optional(),
  depositRequestId: z.string().nullable(),
  creditOfId: z.string().nullable().default(null),
  salesOrderId: z.string().nullable().default(null),
  filesPending: z.boolean(),
  paidAmount: z.number().optional(),
  creditedAmount: z.number().optional(),
  openAmount: z.number().optional(),
  dueDate: z.string().nullable().default(null),
  version: z.number(),
  createdAt: instant,
})
export type InvoiceRow = z.infer<typeof invoiceRowSchema>

const pageSchema = z.object({ invoices: z.array(invoiceRowSchema), nextCursor: z.string().nullable() })
export type InvoicePage = z.infer<typeof pageSchema>

/** The list's filters as the API reads them (the page's address holds the same names). */
export interface InvoiceQuery {
  docType?: DocType | null
  status?: InvoiceStatus | null
  partyId?: string | null
  cursor?: string | null
  limit?: number
}

export function listInvoices(api: ApiClient, query: InvoiceQuery, signal?: AbortSignal): Promise<InvoicePage> {
  return api.get('/invoicing/invoices', {
    query: { docType: query.docType ?? undefined, status: query.status ?? undefined, partyId: query.partyId ?? undefined, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 },
    schema: pageSchema,
    signal,
  })
}

// ---- the record ---------------------------------------------------------------------------------------------------------------

export const invoiceLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(LINE_KINDS),
  description: z.string(),
  itemCode: z.string().nullable(),
  quantity: z.string(),
  uom: z.string().nullable(),
  unitPrice: z.string().optional(),
  discountPct: z.string().nullable(),
  netAmount: z.number().optional(),
  grossAmount: z.number().nullable().optional(),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatLegalRef: z.string().nullable(),
  salesOrderLineId: z.string().nullable(),
  size: z.string().nullable(),
  ddtId: z.string().nullable(),
  depositInvoiceId: z.string().nullable(),
  /** B-W2a-54: a CHARGE line's kind; the schedule step a TD02 line bills. B-W2a-61: a credit note's line of a return. */
  chargeKind: z.enum(CHARGE_KINDS).nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  returnLineId: z.string().nullable().optional(),
})
export type InvoiceLine = z.infer<typeof invoiceLineSchema>

/** B-W2a-54: a legal invoicing deadline (DPR 633/1972 art. 21 c.4) counted down; its words are the API's (never drawn). */
const invoiceDeadlineSchema = z.object({ docType: z.enum(['TD01', 'TD24']), dueBy: z.string(), daysLeft: z.number(), state: z.enum(['OPEN', 'DUE_SOON', 'LATE']) })

const vatEntrySchema = z.object({ rate: z.string().nullable(), nature: z.string().nullable(), legalRef: z.string().nullable(), taxable: z.number(), vat: z.number(), rounding: z.number() })
const installmentSchema = z.object({ method: z.string(), amount: z.number().optional(), dueDate: z.string().nullable().optional(), iban: z.string().nullable().optional() })

export const invoiceSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  buyerPartyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  docType,
  status,
  number: z.string().nullable(),
  year: z.number().nullable(),
  issueDate: z.string().nullable(),
  issuedAt: instant.nullable(),
  currency: z.string(),
  priceBasis: z.enum(['NET', 'GROSS']),
  billTo: z.record(z.string(), z.unknown()),
  netTotal: z.number().optional(),
  vatTotal: z.number().optional(),
  grossTotal: z.number().optional(),
  vatSummary: z.array(vatEntrySchema).optional(),
  stampDutyAmount: z.number().nullable().optional(),
  paymentTerms: z.object({ condition: z.string().optional(), installments: z.array(installmentSchema).optional() }).passthrough().nullable().optional(),
  causale: z.string().nullable(),
  documentRefs: z.array(z.unknown()).nullable(),
  salesOrderId: z.string().nullable(),
  depositRequestId: z.string().nullable(),
  creditOfId: z.string().nullable(),
  xmlFileId: z.string().nullable(),
  pdfFileId: z.string().nullable(),
  filesPending: z.boolean(),
  internalNote: z.string().nullable(),
  paidAmount: z.number().optional(),
  creditedAmount: z.number().optional(),
  openAmount: z.number().optional(),
  refundDueAmount: z.number().optional(),
  /** B-W2a-54: a DRAFT TD01/TD24 of shipped goods — the last day to issue it, counted down; else null. */
  deadline: invoiceDeadlineSchema.nullable().optional(),
  lines: z.array(invoiceLineSchema),
  createdAt: instant,
  updatedAt: instant,
})
export type Invoice = z.infer<typeof invoiceSchema>

const one = z.object({ invoice: invoiceSchema })

export async function getInvoice(api: ApiClient, id: string, signal?: AbortSignal): Promise<Invoice> {
  return (await api.get(invoicePath(id), { schema: one, signal })).invoice
}

export const checksSchema = z.object({
  ready: z.boolean(),
  problems: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
  numberPreview: z.string().nullable(),
  issueDate: z.string(),
})
export type Checks = z.infer<typeof checksSchema>

/** The checks before issue now, and the number the series would give (a preview: the number is taken at issue). */
export function getChecks(api: ApiClient, id: string, signal?: AbortSignal): Promise<Checks> {
  return api.get(`${invoicePath(id)}/checks`, { schema: checksSchema, signal })
}

const relatedSchema = z.object({
  ddts: z.array(z.object({ id: z.string(), number: z.string(), date: z.string(), shipmentId: z.string(), shipmentNumber: z.string() })),
  depositInvoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), status, depositRequestId: z.string().nullable() })),
  creditOf: z.object({ id: z.string(), docType, number: z.string().nullable(), issueDate: z.string().nullable(), status }).nullable(),
  creditNotes: z.array(z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), status, grossTotal: z.number().optional() })),
  payments: z.array(
    z.object({
      allocationId: z.string(),
      paymentId: z.string(),
      externalRef: z.string(),
      receivedOn: z.string(),
      paymentStatus: z.string(),
      amount: z.number().optional(),
      reversalOfId: z.string().nullable(),
      reversed: z.boolean(),
      note: z.string().nullable(),
      createdAt: instant,
    }),
  ),
  orders: z.array(z.object({ id: z.string(), number: z.string() })),
  depositRequests: z.array(
    z.object({
      id: z.string(),
      orderId: z.string().nullable(),
      kind: z.string(),
      depositPct: z.string().nullable(),
      currency: z.string(),
      amount: z.number().optional(),
      paidAmount: z.number().optional(),
      dueDate: z.string(),
      fiscalDocument: z.string(),
      status: z.string(),
      paidAt: instant.nullable(),
      depositInvoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), status, issueDate: z.string().nullable() })),
    }),
  ),
})
export type Related = z.infer<typeof relatedSchema>

/** The DDTs, deductions, credit notes, payments and the orders' deposits of an invoice (invoices.view). */
export async function getRelated(api: ApiClient, id: string, signal?: AbortSignal): Promise<Related> {
  return (await api.get(`${invoicePath(id)}/related`, { schema: z.object({ related: relatedSchema }), signal })).related
}

const issuedSchema = z.object({ invoice: invoiceSchema, filesPending: z.boolean(), filesProblem: z.string().nullable() })
export type Issued = z.infer<typeof issuedSchema>

/** Issues a draft (invoices.issue and a fresh step-up): the number, the date, the XML and the PDF. */
export function issueInvoice(api: ApiClient, id: string, version: number, idempotencyKey: string): Promise<Issued> {
  return api.post(`${invoicePath(id)}/issue`, { body: { version }, schema: issuedSchema, idempotencyKey })
}

/** Makes the XML and the PDF of an issued invoice whose files are still pending. */
export async function makeFiles(api: ApiClient, id: string): Promise<Invoice> {
  return (await api.post(`${invoicePath(id)}/files`, { schema: one, idempotencyKey: key() })).invoice
}

/** Deletes a draft (it never had a number). */
export function deleteDraft(api: ApiClient, id: string, version: number): Promise<unknown> {
  return api.request('DELETE', invoicePath(id), { query: { version }, schema: z.object({ deleted: z.literal(true), id: z.string() }), idempotencyKey: key() })
}

/** A line as the API takes it back (a draft's lines replaced, or a rejected invoice's correction). */
export interface LineInput {
  kind?: 'GOODS' | 'SERVICE' | 'CHARGE'
  /** B-W2a-54: what a CHARGE line bills (required on one, refused on any other). */
  chargeKind?: ChargeKind | null
  description: string
  itemCode?: string | null
  quantity: string
  uom?: string | null
  unitPrice: string
  discountPct?: string | null
  vatRatePct?: string
  vatNature?: string | null
  vatLegalRef?: string | null
  salesOrderLineId?: string | null
  size?: string | null
  ddtId?: string | null
}

/** Replaces a draft's goods lines (its deposit deductions stay); the totals are computed again. */
export async function replaceLines(api: ApiClient, id: string, version: number, lines: LineInput[]): Promise<Invoice> {
  return (await api.request('PUT', `${invoicePath(id)}/lines`, { body: { version, lines }, schema: one, idempotencyKey: key() })).invoice
}

/** The text of a draft: the causale, the payment's due date. */
export async function updateDraft(api: ApiClient, id: string, body: { version: number; causale?: string | null; payment?: { method?: string; dueDate?: string | null; iban?: string | null } | null }): Promise<Invoice> {
  return (await api.request('PATCH', invoicePath(id), { body, schema: one, idempotencyKey: key() })).invoice
}

/** Removes a deposit deduction from a draft (the only edit of one). */
export async function removeDeduction(api: ApiClient, id: string, lineId: string, version: number): Promise<Invoice> {
  return (await api.request('DELETE', `${invoicePath(id)}/deductions/${encodeURIComponent(lineId)}`, { query: { version }, schema: one, idempotencyKey: key() })).invoice
}

// ---- SDI ----------------------------------------------------------------------------------------------------------------------

const problemSchema = z.object({ code: z.string(), path: z.string(), message: z.string() })

export const sdiSchema = z.object({
  invoiceId: z.string(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  invoiceStatus: status,
  version: z.number(),
  state: z.object({ code: z.enum(SDI_STATE_CODES), next: z.object({ action: z.enum(SDI_NEXT_ACTIONS) }) }),
  canSend: z.boolean(),
  deadline: z.object({ deadline: z.string(), workingDaysLeft: z.number(), overdue: z.boolean() }).nullable(),
  resend: z.object({ ready: z.boolean(), problems: z.array(problemSchema) }).nullable(),
  sends: z.array(
    z.object({
      id: z.string(),
      attempt: z.number(),
      fileName: z.string(),
      status: z.enum(SDI_SEND_STATUSES),
      sdiIdentifier: z.string().nullable(),
      sentAt: instant.nullable(),
      outcomeAt: instant.nullable(),
      failure: z.object({ code: z.string(), uncertain: z.boolean() }).nullable(),
      createdAt: instant,
      notifications: z.array(
        z.object({
          id: z.string(),
          type: z.enum(SDI_NOTIFICATION_TYPES),
          receivedAt: instant,
          source: z.enum(['webhook', 'poll']),
          errors: z.array(z.object({ code: z.string(), description: z.string(), fix: z.enum(SDI_FIXES), known: z.boolean() })),
        }),
      ),
    }),
  ),
  archive: z.object({ archiveRef: z.string(), archivedAt: z.string() }).nullable(),
  courtesyCopies: z.object({ queued: z.array(z.object({ emailId: z.string(), status: z.string(), queuedAt: instant })), missing: z.string().nullable() }),
})
export type Sdi = z.infer<typeof sdiSchema>
export type SdiSend = Sdi['sends'][number]

export async function getSdi(api: ApiClient, id: string, signal?: AbortSignal): Promise<Sdi> {
  return (await api.get(`${invoicePath(id)}/sdi`, { schema: z.object({ sdi: sdiSchema }), signal })).sdi
}

/** Sends an issued (or rejected, or failed) invoice to SDI (invoices.issue and a fresh step-up). */
export async function sendToSdi(api: ApiClient, id: string, version: number, idempotencyKey: string): Promise<Sdi> {
  return (await api.post(`${invoicePath(id)}/sdi/send`, { body: { version }, schema: z.object({ sdi: sdiSchema }), idempotencyKey })).sdi
}

const correctionSchema = z.object({ invoice: invoiceSchema, resend: z.object({ ready: z.boolean(), problems: z.array(problemSchema) }) })
export type Correction = z.infer<typeof correctionSchema>

/** Corrects a REJECTED invoice (same number and date): lines and text; the seller and buyer are read again. */
export function correctInvoice(api: ApiClient, id: string, body: { version: number; lines?: LineInput[]; causale?: string | null }, idempotencyKey: string): Promise<Correction> {
  return api.request('PUT', `${invoicePath(id)}/sdi/correction`, { body, schema: correctionSchema, idempotencyKey })
}

// ---- shipped, not invoiced; invoices from DDTs; credit notes --------------------------------------------------------------------

const shipType = z.enum(['TD01', 'TD24'])
const deadlineSchema = z.object({ docType: shipType, dueBy: z.string(), daysLeft: z.number(), state: z.enum(DEADLINE_STATES) })
export type Deadline = z.infer<typeof deadlineSchema>

export const queueDdtSchema = z.object({
  ddtId: z.string(),
  number: z.string(),
  date: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  shipmentId: z.string(),
  shipmentNumber: z.string(),
  orders: z.array(z.object({ id: z.string(), number: z.string() })),
  lines: z.array(
    z.object({
      salesOrderLineId: z.string(),
      orderNumber: z.string().nullable(),
      description: z.string().nullable(),
      size: z.string(),
      shipped: z.string(),
      invoiced: z.string(),
      inDraft: z.string(),
      notInvoiced: z.string(),
      unitPrice: z.string().nullable().optional(),
      netAmount: z.number().nullable().optional(),
      drafts: z.array(z.string()),
    }),
  ),
  valueAmount: z.number().optional(),
  depositPaidAmount: z.number().optional(),
  drafts: z.array(z.string()),
  immediate: deadlineSchema,
  /** B-W2a-54 (FIN-065): its deadline by the customer's preset (the day the timers count down to). */
  deadline: deadlineSchema.optional(),
  /** B-W2a-54 (FIN-060): its shipment's freight (amount null: not decided yet; absent without the price grain). */
  freight: z.object({ amount: z.number().nullable().optional(), currency: z.string(), billed: z.boolean() }).optional(),
})
export type QueueDdt = z.infer<typeof queueDdtSchema>

export const queueSchema = z.object({
  asOf: z.string(),
  customers: z.array(
    z.object({
      partyId: z.string(),
      companyId: z.string(),
      code: z.string(),
      legalName: z.string(),
      /** B-W2a-54: how the customer is invoiced and the type its goods get by default. */
      invoiceTiming: z.enum(['PER_SHIPMENT', 'MONTHLY']).optional(),
      preset: shipType.optional(),
      valueAmount: z.number().optional(),
      oldestDate: z.string(),
      months: z.array(z.object({ month: z.string(), ddtIds: z.array(z.string()), suggested: shipType.nullable(), allowed: z.array(shipType), deadline: deadlineSchema.nullable() })),
      ddts: z.array(queueDdtSchema),
    }),
  ),
})
export type Queue = z.infer<typeof queueSchema>
export type QueueCustomer = Queue['customers'][number]

/** Every DDT shipped and not yet invoiced, per customer, with the legal deadlines (invoices.view). */
export function shippedNotInvoiced(api: ApiClient, signal?: AbortSignal): Promise<Queue> {
  return api.get('/invoicing/shipped-not-invoiced', { schema: queueSchema, signal })
}

const fromDdtsSchema = z.object({
  invoice: invoiceSchema,
  choice: z.object({ docType: shipType.nullable(), suggested: shipType.nullable(), allowed: z.array(shipType) }),
  deductions: z.array(z.object({ depositInvoiceId: z.string(), number: z.string().nullable() })),
})
export type FromDdts = z.infer<typeof fromDdtsSchema>

/** A TD01 or TD24 draft from these DDTs (one customer), at the orders' prices, every issued TD02 of the orders deducted. */
export function invoiceFromDdts(api: ApiClient, body: { ddtIds: string[]; docType?: 'TD01' | 'TD24' }, idempotencyKey: string): Promise<FromDdts> {
  return api.post('/invoicing/invoices/from-ddts', { body, schema: fromDdtsSchema, idempotencyKey })
}

export type CreditAsk =
  | { full: true }
  | { lines: Array<{ lineId: string; quantity?: string; unitPrice: string }> }
  | { amount: number; amountBasis: 'NET' | 'GROSS'; vatRatePct?: string; vatNature?: string | null; vatLegalRef?: string | null; description?: string | null }

const creditSchema = z.object({ invoice: invoiceSchema, creditableAmount: z.number().optional(), refundDueAmount: z.number().optional() })
export type CreditAnswer = z.infer<typeof creditSchema>

/** A credit note (TD04) draft of an issued invoice: the whole of it, some lines, or an amount; never above what is creditable. */
export function createCreditNote(api: ApiClient, id: string, body: { reason: CreditReason; reasonText?: string | null } & CreditAsk, idempotencyKey: string): Promise<CreditAnswer> {
  return api.post(`${invoicePath(id)}/credit-note`, { body, schema: creditSchema, idempotencyKey })
}

// ---- payments -------------------------------------------------------------------------------------------------------------------

const placedSchema = z.array(z.object({ target: z.enum(ALLOCATION_TARGETS), targetId: z.string(), amount: z.number().optional(), number: z.string().nullable(), docType: z.string().nullable(), orderNumber: z.string().nullable() }))
export type Placed = z.infer<typeof placedSchema>[number]

export const paymentRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  method: z.enum(PAYMENT_METHODS),
  amount: z.number().optional(),
  allocated: z.number().optional(),
  unallocated: z.number().optional(),
  currency: z.string(),
  receivedOn: z.string(),
  externalRef: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  placedOn: placedSchema.default([]),
  /** B-W2a-61: what its live refunds (due or paid) take of it. */
  refunded: z.number().optional(),
  createdAt: instant,
})
export type PaymentRow = z.infer<typeof paymentRowSchema>

const paymentsPageSchema = z.object({ payments: z.array(paymentRowSchema), nextCursor: z.string().nullable() })
export type PaymentsPage = z.infer<typeof paymentsPageSchema>

export interface PaymentQuery {
  status?: 'RECEIVED' | 'VOIDED' | null
  partyId?: string | null
  from?: string | null
  to?: string | null
  cursor?: string | null
  limit?: number
}

export function listPayments(api: ApiClient, query: PaymentQuery, signal?: AbortSignal): Promise<PaymentsPage> {
  return api.get('/payments', {
    query: { status: query.status ?? undefined, partyId: query.partyId ?? undefined, from: query.from ?? undefined, to: query.to ?? undefined, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 },
    schema: paymentsPageSchema,
    signal,
  })
}

export const paymentSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  method: z.enum(PAYMENT_METHODS),
  amount: z.number().optional(),
  currency: z.string(),
  receivedOn: z.string(),
  externalRef: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  voidedAt: instant.nullable(),
  voidReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  allocated: z.number().optional(),
  unallocated: z.number().optional(),
  allocations: z.array(
    z.object({
      id: z.string(),
      target: z.enum(ALLOCATION_TARGETS),
      targetId: z.string(),
      amount: z.number().optional(),
      reversalOfId: z.string().nullable(),
      reversed: z.boolean(),
      note: z.string().nullable(),
      createdAt: instant,
      createdById: z.string().nullable(),
      label: z.object({ number: z.string().nullable(), docType: z.string().nullable(), orderNumber: z.string().nullable() }).nullable().default(null),
    }),
  ),
  placedOn: placedSchema.default([]),
  /** B-W2a-61: what its live refunds take of it (a credit balance given back), and those refunds. */
  refunded: z.number().optional(),
  refunds: z.array(z.object({ id: z.string(), status: z.enum(['DUE', 'PAID', 'CANCELLED', 'VOIDED']), amount: z.number().optional(), dueDate: z.string().nullable(), paidOn: z.string().nullable() })).optional(),
  createdAt: instant,
  createdById: z.string().nullable(),
  people: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
})
export type Payment = z.infer<typeof paymentSchema>
export type Allocation = Payment['allocations'][number]

const paymentOne = z.object({ payment: paymentSchema })
const paymentPath = (id: string) => `/payments/${encodeURIComponent(id)}`

export async function getPayment(api: ApiClient, id: string, signal?: AbortSignal): Promise<Payment> {
  return (await api.get(paymentPath(id), { schema: paymentOne, signal })).payment
}

export interface AllocationAsk {
  depositRequestId?: string
  invoiceId?: string
  /** Minor units; absent: as much as fits. */
  amount?: number
}

/** Records a bank transfer received (its reference unique in the company) and places it, in one write (payments.record). */
export async function recordPayment(
  api: ApiClient,
  body: { companyId: string; partyId: string; amount: number; receivedOn: string; externalRef: string; internalNote?: string | null; allocations: AllocationAsk[] },
  idempotencyKey: string,
): Promise<Payment> {
  return (await api.post('/payments', { body, schema: paymentOne, idempotencyKey })).payment
}

const depositReceivedSchema = z.object({
  payment: paymentSchema,
  depositRequest: z.object({ id: z.string(), status: z.string() }),
  depositInvoice: z.object({ required: z.boolean(), invoice: invoiceSchema.nullable(), filesPending: z.boolean() }),
})
export type DepositReceived = z.infer<typeof depositReceivedSchema>

/**
 * A payment that pays one deposit request: recorded, placed (never above what the request still asks), the request PAID
 * when covered, and the TD02 issued when the rule asks one and `issueDepositInvoice` is on (invoices.issue + step-up).
 */
export function depositReceived(api: ApiClient, body: { depositRequestId: string; amount: number; receivedOn: string; externalRef: string; internalNote?: string | null; issueDepositInvoice: boolean }, idempotencyKey: string): Promise<DepositReceived> {
  return api.post('/payments/deposit-received', { body, schema: depositReceivedSchema, idempotencyKey })
}

/** Places more of a payment (the version read guards it). */
export async function allocatePayment(api: ApiClient, id: string, version: number, allocations: AllocationAsk[]): Promise<Payment> {
  return (await api.post(`${paymentPath(id)}/allocations`, { body: { version, allocations }, schema: paymentOne, idempotencyKey: key() })).payment
}

/** Takes an allocation back (a reversal row, the reason in the note). */
export async function reverseAllocation(api: ApiClient, id: string, allocationId: string, note: string): Promise<Payment> {
  return (await api.post(`${paymentPath(id)}/allocations/${encodeURIComponent(allocationId)}/reverse`, { body: { note }, schema: paymentOne, idempotencyKey: key() })).payment
}

/** Voids a payment typed by mistake, once nothing is placed (payments.void). */
export async function voidPayment(api: ApiClient, id: string, version: number, reason: string): Promise<Payment> {
  return (await api.post(`${paymentPath(id)}/void`, { body: { version, reason }, schema: paymentOne, idempotencyKey: key() })).payment
}

export const openItemSchema = z.object({
  target: z.enum(ALLOCATION_TARGETS),
  id: z.string(),
  number: z.string().nullable(),
  docType: z.string().nullable(),
  fiscalDocument: z.enum(['TD02', 'NONE']).nullable().default(null),
  /** B-W2a-61: a deposit request's schedule step (B-W2a-F2: BEFORE_SHIPPING = the balance before shipping). */
  stepKind: z.enum(['DEPOSIT', 'BEFORE_SHIPPING']).nullable().optional(),
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  date: z.string(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  amount: z.number().optional(),
  openAmount: z.number().optional(),
  /** B-W2a-61: with a payment or an amount asked, what "Suggest" places on it (oldest first). */
  suggestedAmount: z.number().optional(),
  /** B-W2a-61: an invoice of an order whose deposit was paid on a request that issues no TD02: what that deposit holds. */
  noInvoiceDepositAmount: z.number().nullable().optional(),
})
export type OpenItem = z.infer<typeof openItemSchema>

/** A customer's open deposit requests and invoices in a company, oldest first, with what each still asks. */
export async function openItems(api: ApiClient, companyId: string, partyId: string, signal?: AbortSignal): Promise<OpenItem[]> {
  return (await api.get('/payments/open-items', { query: { companyId, partyId }, schema: z.object({ items: z.array(openItemSchema) }), signal })).items
}

const partyRowSchema = z.object({ id: z.string(), companyId: z.string().nullable(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), status: z.string(), currency: z.string(), vatNumber: z.string().nullable() })
export type CustomerRow = z.infer<typeof partyRowSchema>

/** Customers by name, code or VAT number (parties.view), for "Record a payment". */
export async function findCustomers(api: ApiClient, q: string, companyId: string | null, signal?: AbortSignal): Promise<CustomerRow[]> {
  return (await api.get('/parties', { query: { q: q.trim() || undefined, role: 'CUSTOMER', companyId: companyId ?? undefined, limit: 20 }, schema: z.object({ parties: z.array(partyRowSchema) }), signal })).parties
}

// ---- finance settings ------------------------------------------------------------------------------------------------------------

const addressSchema = z.object({ line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() })

export const settingsSchema = z.object({
  asOf: z.string(),
  companies: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      legalName: z.string(),
      identity: z
        .object({
          vatNumber: z.string().nullable(),
          fiscalCode: z.string().nullable(),
          regimeFiscale: z.string().nullable(),
          reaOffice: z.string().nullable(),
          reaNumber: z.string().nullable(),
          shareCapital: z.string().nullable(),
          soleShareholder: z.boolean(),
          inLiquidation: z.boolean(),
          address: addressSchema.nullable(),
        })
        .nullable(),
      seller: z.object({ ready: z.boolean(), problems: z.array(z.object({ path: z.string() })) }),
      sdi: z.object({ state: z.enum(SDI_SETUP_STATES), accounts: z.array(z.object({ id: z.string(), label: z.string(), mode: z.enum(INTEGRATION_MODES), status: z.string() })) }),
      archive: z.object({ archivedSends: z.number(), lastArchivedAt: z.string().nullable() }),
      series: z.array(z.object({ kind: z.enum(SERIES_KINDS), next: z.string().nullable() })),
    }),
  ),
})
export type FinanceSettings = z.infer<typeof settingsSchema>
export type CompanySettings = FinanceSettings['companies'][number]

export async function getFinanceSettings(api: ApiClient, signal?: AbortSignal): Promise<FinanceSettings> {
  return (await api.get('/invoicing/settings', { schema: z.object({ settings: settingsSchema }), signal })).settings
}

export const bankSchema = z.object({ companyId: z.string(), bank: z.object({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(), version: z.number(), updatedAt: instant })
export type BankDetails = z.infer<typeof bankSchema>

/** The company's bank account the invoices and the deposit page print (companies.bank.view). */
export function getBankDetails(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<BankDetails> {
  return api.get(`/companies/${encodeURIComponent(companyId)}/bank-details`, { schema: bankSchema, signal })
}

/** Saves it (companies.bank.manage and a fresh step-up); every field empty removes the account. */
export function saveBankDetails(api: ApiClient, companyId: string, body: { version: number; accountHolder: string | null; iban: string | null; bic: string | null; bankName: string | null }, idempotencyKey: string): Promise<BankDetails> {
  return api.request('PUT', `/companies/${encodeURIComponent(companyId)}/bank-details`, { body, schema: bankSchema, idempotencyKey })
}
