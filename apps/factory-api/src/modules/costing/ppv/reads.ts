import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type { PpvAnswer, PpvQuery, PpvRowView } from '@nexus/factory-domain/costing/ppv/contracts'
import { ppvWords, type PpvAt } from '@nexus/factory-domain/costing/ppv/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { unique, type Reader } from '../actual/store'
import { waitsOf } from './settings'

/**
 * The purchase price variances (B-W2b-407; FIN-031; design finance.costing "Purchase price variance": material, supplier,
 * standard, paid, difference), office reads with costing.view over the variance's company and supplier (scopeWhere), newest
 * first, a page at a time; the totals per currency cover every page of the query. Unit costs and differences are money.cost.
 */

const SCOPE = { company: 'companyId', party: 'partyId' } as const
const PAGE = 100

export const VARIANCE_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  at: true,
  receiptLineId: true,
  supplierInvoiceLineId: true,
  itemId: true,
  quantity: true,
  standardUnitCost: true,
  standardCostId: true,
  paidUnitCost: true,
  differenceAmount: true,
  currency: true,
  postedAt: true,
  reversalOfId: true,
  reason: true,
} as const satisfies Prisma.PurchasePriceVarianceSelect
export type VarianceRow = Prisma.PurchasePriceVarianceGetPayload<{ select: typeof VARIANCE_COLUMNS }>

const text = (value: { toFixed(places: number): string }, places: number): string => value.toFixed(places)

/** The rows as the screens show them: the supplier, the material, the document and line, the reversal that took it back. */
export async function ppvViews(db: Reader, rows: readonly VarianceRow[]): Promise<PpvRowView[]> {
  if (rows.length === 0) return []
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique(rows.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(rows.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const receiptLines = new Map((await db.goodsReceiptLine.findMany({ where: { id: { in: unique(rows.map((row) => row.receiptLineId)) } }, select: { id: true, seq: true, receiptId: true } })).map((row) => [row.id, row]))
  const receipts = new Map((await db.goodsReceipt.findMany({ where: { id: { in: unique([...receiptLines.values()].map((row) => row.receiptId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const invoiceLines = new Map((await db.supplierInvoiceLine.findMany({ where: { id: { in: unique(rows.map((row) => row.supplierInvoiceLineId)) } }, select: { id: true, seq: true, invoiceId: true } })).map((row) => [row.id, row]))
  const invoices = new Map((await db.supplierInvoice.findMany({ where: { id: { in: unique([...invoiceLines.values()].map((row) => row.invoiceId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const reversals = new Map(
    (await db.purchasePriceVariance.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { id: true, reversalOfId: true, postedAt: true, reason: true } })).map((row) => [row.reversalOfId!, row]),
  )
  return rows.map((row) => {
    const receiptLine = row.receiptLineId ? receiptLines.get(row.receiptLineId) : undefined
    const invoiceLine = row.supplierInvoiceLineId ? invoiceLines.get(row.supplierInvoiceLineId) : undefined
    const source =
      row.at === 'RECEIPT'
        ? { at: 'RECEIPT' as const, documentId: receiptLine?.receiptId ?? row.receiptLineId!, number: receipts.get(receiptLine?.receiptId ?? '') ?? '', lineId: row.receiptLineId!, seq: receiptLine?.seq ?? 0 }
        : { at: 'INVOICE' as const, documentId: invoiceLine?.invoiceId ?? row.supplierInvoiceLineId!, number: invoices.get(invoiceLine?.invoiceId ?? '') ?? '', lineId: row.supplierInvoiceLineId!, seq: invoiceLine?.seq ?? 0 }
    const item = items.get(row.itemId)
    const reversedBy = reversals.get(row.id)
    const quantity = text(row.quantity, 4)
    const standardUnitCost = text(row.standardUnitCost, 6)
    const paidUnitCost = text(row.paidUnitCost, 6)
    return {
      id: row.id,
      companyId: row.companyId,
      supplier: { id: row.partyId, name: parties.get(row.partyId) ?? '' },
      item: { id: row.itemId, code: item?.code ?? '', name: item?.name ?? '', baseUom: (item?.baseUom ?? 'PCS') as Uom },
      source,
      postedAt: toUtcIso(row.postedAt),
      day: businessDate(row.postedAt),
      quantity,
      standardUnitCost: asMoney('cost', standardUnitCost),
      paidUnitCost: asMoney('cost', paidUnitCost),
      differenceAmount: asMoney('cost', row.differenceAmount),
      currency: row.currency,
      standardId: row.standardCostId,
      reversalOfId: row.reversalOfId,
      reversedBy: reversedBy ? { id: reversedBy.id, postedAt: toUtcIso(reversedBy.postedAt), reason: reversedBy.reason } : null,
      reason: row.reason,
      words: asMoney('cost', ppvWords({ quantity, paidUnitCost, standardUnitCost, currency: row.currency, differenceAmount: row.differenceAmount, reversal: row.reversalOfId !== null })),
    }
  })
}

/** GET /costing/ppv */
export async function ppvList(caller: CommandCaller, query: PpvQuery): Promise<PpvAnswer> {
  const actor = actorOf(contextOf(caller))
  const limit = query.limit ?? PAGE
  return caller.withClient(async (db) => {
    const receiptLineIds = query.receiptId ? (await db.goodsReceiptLine.findMany({ where: { receiptId: query.receiptId }, select: { id: true } })).map((row) => row.id) : null
    const invoiceLineIds = query.supplierInvoiceId ? (await db.supplierInvoiceLine.findMany({ where: { invoiceId: query.supplierInvoiceId }, select: { id: true } })).map((row) => row.id) : null
    const base: Prisma.PurchasePriceVarianceWhereInput[] = [
      scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.PurchasePriceVarianceWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.itemId ? { itemId: query.itemId } : {},
      query.at ? { at: query.at as PpvAt } : {},
      query.from ? { postedAt: { gte: businessDayStart(query.from) } } : {},
      query.to ? { postedAt: { lt: businessDayRange(query.to).end } } : {},
      receiptLineIds ? { receiptLineId: { in: receiptLineIds } } : {},
      invoiceLineIds ? { supplierInvoiceLineId: { in: invoiceLineIds } } : {},
    ]
    const rows = await db.purchasePriceVariance.findMany({ where: { AND: [...base, query.cursor ? { id: { lt: query.cursor } } : {}] }, select: VARIANCE_COLUMNS, orderBy: { id: 'desc' }, take: limit + 1 })
    const page = rows.slice(0, limit)
    const sums = await db.purchasePriceVariance.groupBy({ by: ['currency'], where: { AND: base }, _sum: { differenceAmount: true }, _count: { _all: true }, orderBy: { currency: 'asc' } })
    return {
      rows: await ppvViews(db, page),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      totals: sums.map((row) => ({ currency: row.currency, differenceAmount: asMoney('cost', row._sum.differenceAmount ?? 0), rows: row._count._all })),
      waits: await waitsOf(db, query.companyId),
      empty: 'No purchase price variance in this period: none is taken yet for the receipts or invoices asked for.',
    }
  })
}
