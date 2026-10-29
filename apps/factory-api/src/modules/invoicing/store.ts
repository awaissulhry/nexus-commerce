import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { VatSummaryEntry } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'

/**
 * The invoicing module's reads (factory-db money.prisma Invoice, InvoiceLine): the columns every read names, the views
 * its answers share (money marked with the price grain: the API drops it for staff without money.price), and who may
 * see and act on an invoice: office only, can() on its company AND its buyer (a role limited to some customers reaches
 * only theirs). A reader takes a command's transaction or a scoped client: row-level security decides what it finds.
 */

export type Reader = FactoryClient | CommandTx

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The scope of an invoice (or of what it is about): its company and buyer. */
export interface InvoiceScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: InvoiceScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

/** The caller may see the record (`see`, else 404) and do `permission` on it (else 403). */
export function assertMay(context: OfficeContext, see: Permission, permission: Permission, scope: InvoiceScope | null, what = 'Invoice'): asserts scope is InvoiceScope {
  if (!scope || !mayOn(context, see, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

export const INVOICE_COLUMNS = {
  id: true,
  companyId: true,
  buyerPartyId: true,
  partyId: true,
  docType: true,
  status: true,
  numberSeriesId: true,
  number: true,
  year: true,
  issueDate: true,
  issuedAt: true,
  issuedById: true,
  currency: true,
  priceBasis: true,
  seller: true,
  billTo: true,
  netTotal: true,
  vatTotal: true,
  grossTotal: true,
  vatSummary: true,
  stampDutyAmount: true,
  paymentTerms: true,
  causale: true,
  documentRefs: true,
  salesOrderId: true,
  depositRequestId: true,
  creditOfId: true,
  xmlFileId: true,
  pdfFileId: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.InvoiceSelect
export type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  invoiceId: true,
  seq: true,
  kind: true,
  description: true,
  itemCode: true,
  quantity: true,
  uom: true,
  unitPrice: true,
  discountPct: true,
  netAmount: true,
  grossAmount: true,
  vatRatePct: true,
  vatNature: true,
  vatLegalRef: true,
  salesOrderLineId: true,
  size: true,
  ddtId: true,
  depositInvoiceId: true,
} as const satisfies Prisma.InvoiceLineSelect
export type LineRow = Prisma.InvoiceLineGetPayload<{ select: typeof LINE_COLUMNS }>

/** The invoice's header, or null (missing, or out of the caller's tenant). */
export async function readInvoice(db: Reader, invoiceId: string): Promise<InvoiceRow | null> {
  if (!isUuid(invoiceId)) return null
  return db.invoice.findUnique({ where: { id: invoiceId }, select: INVOICE_COLUMNS })
}

export const readLines = (db: Reader, invoiceId: string): Promise<LineRow[]> => db.invoiceLine.findMany({ where: { invoiceId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })

/** The invoice the office may see (else 404) and act on with `permission` (else 403). */
export async function officeInvoice(caller: CommandCaller, invoiceId: string, permission: Permission = INVOICES_VIEW): Promise<InvoiceRow> {
  const context = officeContextOf(caller)
  const invoice = await caller.withClient((client) => readInvoice(client, invoiceId))
  assertMay(context, INVOICES_VIEW, permission, invoice ? { companyId: invoice.companyId, partyId: invoice.buyerPartyId } : null)
  return invoice!
}

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const decimal = (value: Prisma.Decimal | null, places: number): string | null => (value === null ? null : value.toFixed(places))

export const lineView = (line: LineRow) => ({
  id: line.id,
  seq: line.seq,
  kind: line.kind,
  description: line.description,
  itemCode: line.itemCode,
  quantity: line.quantity.toFixed(4),
  uom: line.uom,
  unitPrice: asMoney('price', line.unitPrice.toFixed(6)),
  discountPct: decimal(line.discountPct, 4),
  netAmount: asMoney('price', line.netAmount),
  grossAmount: asMoney('price', line.grossAmount),
  vatRatePct: line.vatRatePct.toFixed(2),
  vatNature: line.vatNature,
  vatLegalRef: line.vatLegalRef,
  salesOrderLineId: line.salesOrderLineId,
  size: line.size,
  ddtId: line.ddtId,
  depositInvoiceId: line.depositInvoiceId,
})

/** An issued invoice whose XML or PDF is not stored yet (the worker makes them, or POST …/files). */
export const filesPending = (invoice: Pick<InvoiceRow, 'status' | 'xmlFileId' | 'pdfFileId'>): boolean => invoice.status !== 'DRAFT' && (invoice.xmlFileId === null || invoice.pdfFileId === null)

/** The header as JSON (dates as strings), money marked. */
export function headerView(invoice: InvoiceRow) {
  return {
    id: invoice.id,
    version: invoice.version,
    companyId: invoice.companyId,
    buyerPartyId: invoice.buyerPartyId,
    docType: invoice.docType,
    status: invoice.status,
    numberSeriesId: invoice.numberSeriesId,
    number: invoice.number,
    year: invoice.year,
    issueDate: day(invoice.issueDate),
    issuedAt: at(invoice.issuedAt),
    issuedById: invoice.issuedById,
    currency: invoice.currency,
    priceBasis: invoice.priceBasis,
    seller: (invoice.seller ?? null) as Record<string, unknown> | null,
    billTo: invoice.billTo as Record<string, unknown>,
    netTotal: asMoney('price', invoice.netTotal),
    vatTotal: asMoney('price', invoice.vatTotal),
    grossTotal: asMoney('price', invoice.grossTotal),
    vatSummary: asMoney('price', invoice.vatSummary as unknown as VatSummaryEntry[]),
    stampDutyAmount: asMoney('price', invoice.stampDutyAmount),
    paymentTerms: asMoney('price', (invoice.paymentTerms ?? null) as Record<string, unknown> | null),
    causale: invoice.causale,
    documentRefs: (invoice.documentRefs ?? null) as unknown[] | null,
    salesOrderId: invoice.salesOrderId,
    depositRequestId: invoice.depositRequestId,
    creditOfId: invoice.creditOfId,
    xmlFileId: invoice.xmlFileId,
    pdfFileId: invoice.pdfFileId,
    filesPending: filesPending(invoice),
    internalNote: invoice.internalNote,
    createdAt: toUtcIso(invoice.createdAt),
    updatedAt: toUtcIso(invoice.updatedAt),
  }
}

/**
 * What an invoice still asks or owes (B-W1-51; A2 SCR-081 "Payments": the balance): its gross (after the deposits it
 * deducts) less its issued credit notes less what is paid on it. A TD02 is paid through its deposit request: a credit
 * note on it is money to give back. A credit note asks nothing.
 */
export function balanceOf(invoice: Pick<InvoiceRow, 'docType' | 'status' | 'grossTotal'>, paid: number, credited: number): { open: number; refundDue: number } {
  if (invoice.status === 'DRAFT' || invoice.docType === 'TD04') return { open: 0, refundDue: 0 }
  if (invoice.docType === 'TD02') return { open: 0, refundDue: credited }
  const rest = invoice.grossTotal - credited - paid
  return { open: Math.max(0, rest), refundDue: Math.max(0, -rest) }
}

/** The invoice record: header, buyer's name, lines, what is paid and credited on it and its balance. */
export async function invoiceDetail(db: Reader, invoice: InvoiceRow) {
  const lines = await readLines(db, invoice.id)
  const party = await db.party.findUnique({ where: { id: invoice.buyerPartyId }, select: { code: true, legalName: true } })
  const paid = (await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0
  const credited = (await db.invoice.aggregate({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
  const balance = balanceOf(invoice, paid, credited)
  return {
    ...headerView(invoice),
    party: party ?? { code: '', legalName: '' },
    lines: lines.map(lineView),
    paidAmount: asMoney('price', paid),
    creditedAmount: asMoney('price', credited),
    openAmount: asMoney('price', balance.open),
    refundDueAmount: asMoney('price', balance.refundDue),
  }
}

export type InvoiceDetail = Awaited<ReturnType<typeof invoiceDetail>>
