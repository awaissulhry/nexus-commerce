import type { Issue } from '@nexus/factory-domain/core/errors'
import type { OrderLinePrice } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import type { CoreLine } from '@nexus/factory-domain/invoicing/invoices'
import type { VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { FEE_WORDS } from '@nexus/factory-domain/sales/price-waterfall/rules'
import type { SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandTx } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { tenantOf } from '../../payments/locks'
import type { Reader } from '../quotes/store'

/**
 * A fee is invoiced once (B-W2b-330; SAL-181, SAL-317). A FEE order line (development, sample, tooling) is never shipped:
 * it goes on the first invoice of its order's shipped goods (invoicing/from-shipment/draft.ts calls `feeLinesFor` after
 * the goods lines), as a SERVICE line naming the order line (no DDT, no size), taxed as the goods it goes with — the
 * fee's own VAT treatment (a service: art. 7-ter DPR 633/1972 for an EU business) waits for the accountant
 * (GATE-ACCOUNTANT), as does crediting it against the bulk order (rules FEE_CREDIT_AGAINST_BULK, off). Once: a fee an
 * issued invoice or another draft bills already is left out (and said); at the issue (invoicing/issue.ts) a fee another
 * issued invoice bills is refused in words. Both take the fee's lock ('factory.sales.fee', one per order line, id order)
 * after the DDTs' locks and before the money locks, so two drafts or two issues at once never bill it twice.
 */

/** One advisory lock per fee line (transaction-scoped), in id order. */
export async function lockFees(tx: CommandTx, context: RequestContext, lineIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(lineIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', ${'factory.sales.fee'}::text, ${tenantOf(context)}::uuid, ${id}::uuid), 0))`
  }
}

export interface FeeHolder {
  readonly salesOrderLineId: string
  readonly invoiceId: string
  readonly number: string | null
  readonly draft: boolean
}

/** The TD01/TD24 lines that bill fee lines (drafts too, marked), but invoice `except`. */
export async function feesBilledOf(db: Reader, feeLineIds: readonly string[], except: string | null = null): Promise<FeeHolder[]> {
  if (feeLineIds.length === 0) return []
  const rows = await db.invoiceLine.findMany({
    where: { salesOrderLineId: { in: [...feeLineIds] }, kind: 'SERVICE', invoice: { docType: { in: ['TD01', 'TD24'] }, ...(except ? { id: { not: except } } : {}) } },
    select: { invoiceId: true, salesOrderLineId: true, invoice: { select: { number: true, status: true } } },
    orderBy: [{ invoiceId: 'asc' }],
  })
  return rows.map((row) => ({ salesOrderLineId: row.salesOrderLineId!, invoiceId: row.invoiceId, number: row.invoice.number, draft: row.invoice.status === 'DRAFT' }))
}

export interface FeeLine {
  readonly core: CoreLine
  readonly salesOrderLineId: string
  readonly size: null
  readonly ddtId: null
}

/**
 * Inside the draft's command, after the DDTs' locks: the fee lines of these orders that nothing bills yet, as SERVICE
 * lines (the order's description, its times, its unit price, the goods' VAT), and the ones left out with why.
 */
export async function feeLinesFor(tx: CommandTx, context: RequestContext, orderIds: readonly string[], vatOf: (line: OrderLinePrice) => VatTreatment | Issue): Promise<{ lines: FeeLine[]; left: { salesOrderLineId: string; reason: string }[]; problems: Issue[] }> {
  if (orderIds.length === 0) return { lines: [], left: [], problems: [] }
  const fees = await tx.salesOrderLine.findMany({
    // B-W2b-396 (VI1:02): a fee credited against the bulk order before any invoice billed it is never invoiced.
    where: { orderId: { in: [...orderIds] }, kind: 'FEE', closedShortQuantity: null, feeCreditedAt: null },
    select: { id: true, orderId: true, seq: true, feeKind: true, quantity: true, unitPrice: true, vatRatePct: true, description: true, order: { select: { number: true } } },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  if (fees.length === 0) return { lines: [], left: [], problems: [] }
  await lockFees(tx, context, fees.map((fee) => fee.id))
  const holders = await feesBilledOf(tx, fees.map((fee) => fee.id))
  const lines: FeeLine[] = []
  const left: { salesOrderLineId: string; reason: string }[] = []
  const problems: Issue[] = []
  for (const fee of fees) {
    const holder = holders.find((row) => row.salesOrderLineId === fee.id)
    if (holder) {
      left.push({ salesOrderLineId: fee.id, reason: `The ${FEE_WORDS[(fee.feeKind ?? 'DEVELOPMENT') as SalesFeeKind].toLowerCase()} of order ${fee.order.number} (line ${fee.seq}) is on ${holder.draft ? 'a draft invoice' : `invoice ${holder.number}`} already: a fee is invoiced once.` })
      continue
    }
    const description = (fee.description?.trim() || `${FEE_WORDS[(fee.feeKind ?? 'DEVELOPMENT') as SalesFeeKind]}, ordine ${fee.order.number}`).slice(0, 1000)
    const unitPrice = fee.unitPrice.toFixed(6)
    const vat = vatOf({ salesOrderLineId: fee.id, orderId: fee.orderId, orderNumber: fee.order.number, description, itemCode: null, unitPrice, sizePrices: {}, vatRatePct: fee.vatRatePct.isZero() ? null : fee.vatRatePct.toFixed(2) })
    if ('path' in vat) {
      problems.push(vat)
      continue
    }
    lines.push({ core: { kind: 'SERVICE', description, itemCode: null, quantity: new Dec(fee.quantity).toFixed(4), uom: null, unitPrice, discountPct: null, vat }, salesOrderLineId: fee.id, size: null, ddtId: null })
  }
  return { lines, left, problems }
}

/**
 * At the issue, inside its command after the DDTs' locks: a fee this invoice bills that another ISSUED invoice bills
 * already, as problems in words (a draft of the same fee made elsewhere is that draft's to delete).
 */
export async function feesBilledTwice(tx: CommandTx, context: RequestContext, invoiceId: string, lines: readonly { readonly kind: string; readonly salesOrderLineId: string | null }[]): Promise<{ code: string; path: string; message: string }[]> {
  const ids = lines.filter((line) => line.kind === 'SERVICE' && line.salesOrderLineId !== null).map((line) => line.salesOrderLineId!)
  if (ids.length === 0) return []
  const fees = await tx.salesOrderLine.findMany({ where: { id: { in: ids }, kind: 'FEE' }, select: { id: true, seq: true, order: { select: { number: true } } } })
  if (fees.length === 0) return []
  await lockFees(tx, context, fees.map((fee) => fee.id))
  const issued = (await feesBilledOf(tx, fees.map((fee) => fee.id), invoiceId)).filter((row) => !row.draft)
  return issued.map((row) => {
    const fee = fees.find((entry) => entry.id === row.salesOrderLineId)!
    return { code: 'FEE_INVOICED', path: 'lines', message: `The fee of order ${fee.order.number} (line ${fee.seq}) is on invoice ${row.number} already: a fee is invoiced once (remove it from this draft).` }
  })
}
