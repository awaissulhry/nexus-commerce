import type { Prisma } from '@nexus/factory-db'
import type { CreditedInvoice, CreditedLine } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import type { DepositInvoiceFacts } from '@nexus/factory-domain/invoicing/from-shipment/deductions'
import type { InvoicedQuantity, OrderLinePrice, ShippedQuantity } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { treatmentOf } from '@nexus/factory-domain/invoicing/invoices'
import type { VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { readInvoice, readLines, type Reader } from '../store'

/**
 * What invoices of shipped goods, deductions and credit notes read (B-W1-51): DDTs and the garments their shipments
 * carried (shipping's Ddt, DdtCancellation, Shipment, ShipmentLine), what invoice lines bill of them, the order's prices
 * (sales' SalesOrderLine and SalesOrderLineSize; the orders module of B-W1-25 is not built: its table is read as the
 * accepted version made it), the deposit invoices of orders with what is credited and deducted of them, and the invoice a
 * credit note credits. Every read names its columns; row-level security decides what a reader finds.
 */

const day = (value: Date): string => value.toISOString().slice(0, 10)

export interface DdtRow {
  readonly id: string
  readonly number: string
  readonly date: string
  readonly companyId: string
  readonly partyId: string
  readonly shipmentId: string
  readonly shipmentNumber: string
  readonly shipmentStatus: string
  readonly salesOrderId: string
  readonly cancelled: boolean
}

export async function readDdts(db: Reader, where: Prisma.DdtWhereInput, take = 500): Promise<DdtRow[]> {
  const rows = await db.ddt.findMany({
    // Goods shipped with DDTs: a shipment's DDTs (a DDT for another reason, W2a wave 6/7, carries no sale; B-W2a-54).
    where: { AND: [where, { shipmentId: { not: null } }] },
    take,
    orderBy: [{ documentDate: 'asc' }, { number: 'asc' }],
    select: { id: true, number: true, documentDate: true, companyId: true, partyId: true, shipmentId: true, cancellations: { select: { id: true }, take: 1 }, shipment: { select: { number: true, status: true, salesOrderId: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    date: day(row.documentDate),
    companyId: row.companyId,
    partyId: row.partyId,
    shipmentId: row.shipmentId!,
    shipmentNumber: row.shipment!.number,
    shipmentStatus: row.shipment!.status,
    salesOrderId: row.shipment!.salesOrderId,
    cancelled: row.cancellations.length > 0,
  }))
}

/** The garments each DDT's shipment carried, per order line and size. */
export async function shippedOf(db: Reader, ddts: readonly Pick<DdtRow, 'id' | 'shipmentId'>[]): Promise<ShippedQuantity[]> {
  if (ddts.length === 0) return []
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: { in: [...new Set(ddts.map((ddt) => ddt.shipmentId))] } }, select: { shipmentId: true, salesOrderLineId: true, size: true, quantity: true } })
  return ddts.flatMap((ddt) => lines.filter((line) => line.shipmentId === ddt.shipmentId).map((line) => ({ ddtId: ddt.id, salesOrderLineId: line.salesOrderLineId, size: line.size, quantity: line.quantity })))
}

/** What TD01/TD24 lines bill of these DDTs (drafts too, marked), but invoice `except`. */
export async function invoicedOf(db: Reader, ddtIds: readonly string[], except: string | null = null): Promise<InvoicedQuantity[]> {
  if (ddtIds.length === 0) return []
  const rows = await db.invoiceLine.findMany({
    where: { ddtId: { in: [...ddtIds] }, kind: 'GOODS', salesOrderLineId: { not: null }, size: { not: null }, invoice: { docType: { in: ['TD01', 'TD24'] }, ...(except ? { id: { not: except } } : {}) } },
    select: { invoiceId: true, ddtId: true, salesOrderLineId: true, size: true, quantity: true, invoice: { select: { number: true, status: true } } },
  })
  return rows.map((row) => ({ invoiceId: row.invoiceId, number: row.invoice.number, draft: row.invoice.status === 'DRAFT', ddtId: row.ddtId!, salesOrderLineId: row.salesOrderLineId!, size: row.size!, quantity: row.quantity.toFixed(4) }))
}

/** The order lines' prices, codes and VAT rate, as the order holds them. */
export async function orderPrices(db: Reader, lineIds: readonly string[]): Promise<Map<string, OrderLinePrice & { readonly customerRef: string | null; readonly currency: string }>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.salesOrderLine.findMany({
    where: { id: { in: [...new Set(lineIds)] } },
    select: {
      id: true,
      orderId: true,
      description: true,
      unitPrice: true,
      vatRatePct: true,
      order: { select: { number: true, customerRef: true, currency: true } },
      style: { select: { code: true, name: true } },
      colourway: { select: { code: true, name: true } },
      sizes: { select: { size: true, unitPrice: true } },
    },
  })
  return new Map(
    rows.map((row) => [
      row.id,
      {
        salesOrderLineId: row.id,
        orderId: row.orderId,
        orderNumber: row.order.number,
        customerRef: row.order.customerRef,
        currency: row.order.currency,
        description: row.description?.trim() || `${row.style.name} ${row.colourway.name}`,
        itemCode: `${row.style.code}-${row.colourway.code}`,
        unitPrice: row.unitPrice.toFixed(6),
        sizePrices: Object.fromEntries(row.sizes.map((size) => [size.size, size.unitPrice === null ? null : size.unitPrice.toFixed(6)])),
        vatRatePct: row.vatRatePct.isZero() ? null : row.vatRatePct.toFixed(2),
      },
    ]),
  )
}

/** The treatments of a stored VAT summary (Invoice.vatSummary). */
export function summaryEntries(value: unknown): { treatment: VatTreatment; taxable: number; vat: number }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const entry = raw as { rate?: string | null; nature?: string | null; legalRef?: string | null; taxable?: number; vat?: number }
    const treatment = treatmentOf({ vatRatePct: entry.rate ?? '0', vatNature: entry.nature ?? null, vatLegalRef: entry.legalRef ?? null })
    return treatment && typeof entry.taxable === 'number' && typeof entry.vat === 'number' ? [{ treatment, taxable: entry.taxable, vat: entry.vat }] : []
  })
}

/**
 * Deposit invoices (TD02, not drafts) with what is credited (issued TD04s) and deducted of them: by the orders they
 * belong to (`orderIds`: their request's order or the invoice's), or by id. `deductions`: 'issued' counts what issued
 * invoices deduct (the issue's check), 'all' drafts too (planning a new draft); invoice `except` is never counted.
 */
export async function depositInvoicesOf(db: Reader, which: { readonly orderIds?: readonly string[]; readonly ids?: readonly string[] }, options: { readonly deductions: 'issued' | 'all'; readonly except: string | null }): Promise<DepositInvoiceFacts[]> {
  const or: Prisma.InvoiceWhereInput[] = []
  if (which.orderIds && which.orderIds.length > 0) or.push({ salesOrderId: { in: [...which.orderIds] } }, { depositRequest: { orderId: { in: [...which.orderIds] } } })
  if (which.ids && which.ids.length > 0) or.push({ id: { in: [...which.ids] } })
  if (or.length === 0) return []
  const rows = await db.invoice.findMany({
    where: { OR: or, ...(which.ids && which.ids.length > 0 ? {} : { docType: 'TD02', status: { not: 'DRAFT' } }) },
    select: { id: true, companyId: true, docType: true, status: true, number: true, issueDate: true, netTotal: true, grossTotal: true, vatSummary: true },
  })
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const credits = await db.invoice.findMany({ where: { creditOfId: { in: ids }, docType: 'TD04', status: { not: 'DRAFT' }, ...(options.except ? { id: { not: options.except } } : {}) }, select: { creditOfId: true, netTotal: true, grossTotal: true } })
  const deductions = await db.invoiceLine.findMany({
    where: { depositInvoiceId: { in: ids }, invoice: { ...(options.deductions === 'issued' ? { status: { not: 'DRAFT' } } : {}), ...(options.except ? { id: { not: options.except } } : {}) } },
    select: { depositInvoiceId: true, netAmount: true, invoice: { select: { number: true } } },
  })
  return rows.map((row) => {
    const mine = deductions.filter((line) => line.depositInvoiceId === row.id)
    const credited = credits.filter((credit) => credit.creditOfId === row.id)
    return {
      id: row.id,
      companyId: row.companyId,
      docType: row.docType,
      status: row.status,
      number: row.number,
      issueDate: row.issueDate ? day(row.issueDate) : null,
      netTotal: row.netTotal,
      grossTotal: row.grossTotal,
      entries: summaryEntries(row.vatSummary),
      creditedNet: credited.reduce((sum, credit) => sum + credit.netTotal, 0),
      creditedGross: credited.reduce((sum, credit) => sum + credit.grossTotal, 0),
      deductedNet: mine.reduce((sum, line) => sum - line.netAmount, 0),
      deductedBy: [...new Set(mine.map((line) => line.invoice.number ?? 'a draft'))],
    }
  })
}

/** The invoice a credit note credits, with what is credited (issued TD04s but `exceptCredit`), deducted and paid. */
export async function creditedInvoiceOf(db: Reader, invoiceId: string, exceptCredit: string | null): Promise<(CreditedInvoice & { readonly companyId: string; readonly buyerPartyId: string; readonly salesOrderId: string | null }) | null> {
  const invoice = await readInvoice(db, invoiceId)
  if (!invoice) return null
  const lines = await readLines(db, invoice.id)
  const credits = await db.invoice.findMany({ where: { creditOfId: invoice.id, docType: 'TD04', status: { not: 'DRAFT' }, ...(exceptCredit ? { id: { not: exceptCredit } } : {}) }, select: { netTotal: true, grossTotal: true } })
  const deducted = invoice.docType === 'TD02' ? await db.invoiceLine.aggregate({ where: { depositInvoiceId: invoice.id, invoice: { status: { not: 'DRAFT' } } }, _sum: { netAmount: true } }) : null
  const paid = invoice.docType === 'TD02' ? invoice.grossTotal : ((await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))._sum.amount ?? 0)
  const creditedLines: CreditedLine[] = lines.flatMap((line) => {
    const vat = treatmentOf({ vatRatePct: line.vatRatePct.toFixed(2), vatNature: line.vatNature, vatLegalRef: line.vatLegalRef })
    return vat ? [{ id: line.id, seq: line.seq, kind: line.kind, description: line.description, itemCode: line.itemCode, quantity: line.quantity.toFixed(4), uom: line.uom, unitPrice: line.unitPrice.toFixed(6), discountPct: line.discountPct === null ? null : line.discountPct.toFixed(4), vat, salesOrderLineId: line.salesOrderLineId, size: line.size }] : []
  })
  return {
    id: invoice.id,
    companyId: invoice.companyId,
    buyerPartyId: invoice.buyerPartyId,
    salesOrderId: invoice.salesOrderId,
    docType: invoice.docType,
    status: invoice.status,
    number: invoice.number,
    issueDate: invoice.issueDate ? day(invoice.issueDate) : null,
    currency: invoice.currency,
    priceBasis: invoice.priceBasis,
    netTotal: invoice.netTotal,
    grossTotal: invoice.grossTotal,
    summary: summaryEntries(invoice.vatSummary),
    lines: creditedLines,
    creditedNet: credits.reduce((sum, credit) => sum + credit.netTotal, 0),
    creditedGross: credits.reduce((sum, credit) => sum + credit.grossTotal, 0),
    deductedNet: deducted ? -(deducted._sum.netAmount ?? 0) : 0,
    paid,
  }
}
