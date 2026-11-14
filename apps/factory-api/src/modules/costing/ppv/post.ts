import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import type { PpvSkipView } from '@nexus/factory-domain/costing/ppv/contracts'
import { invoicedBaseQuantity, orderPaidPerBase, paidPerBase, ppvDifference, ppvKeys, PPV_SKIP_WORDS, type PpvAt, type PpvSkip } from '@nexus/factory-domain/costing/ppv/rules'
import { convertUnit } from '@nexus/factory-domain/money/currency/convert'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools } from '../../../core/command'
import { dayRate } from '../../../platform/currency/service'
import { frozenStandards, standardFor, unique, type Reader } from '../actual/store'

/**
 * Taking a purchase price variance (B-W2b-407; FIN-031): ONE planner per document, read only (planReceipt, planInvoice),
 * and ONE writer inside the caller's command (writeVariances), used by the worker's handlers (./handlers.ts) and the
 * catch-up route (POST /costing/ppv/post). A plan has one draft per line that has none live (none yet, or every one
 * reversed: a correction is a reversal and a new key `:<n>`), and the lines it skips with why. Where the company takes
 * its variance (settings) is the caller's check: a plan is made for either place, the database refuses the other.
 */

const VARIANCE_COLUMNS = { id: true, receiptLineId: true, supplierInvoiceLineId: true, reversalOfId: true } as const satisfies Prisma.PurchasePriceVarianceSelect

export interface PpvDraft {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly at: PpvAt
  readonly siteId: string | null
  readonly receiptLineId: string | null
  readonly supplierInvoiceLineId: string | null
  readonly itemId: string
  readonly quantity: string
  readonly standardUnitCost: string
  readonly standardCostId: string
  readonly paidUnitCost: string
  readonly differenceAmount: number
  readonly currency: string
  readonly idempotencyKey: string
}

export interface PpvPlan {
  readonly at: PpvAt
  readonly companyId: string
  readonly documentId: string
  readonly number: string
  /** RECEIPT: the receipt is POSTED; INVOICE: the invoice is approved (APPROVED or PAID) and not a credit note. */
  readonly ready: boolean
  readonly status: string
  readonly day: BusinessDate
  readonly drafts: PpvDraft[]
  readonly skipped: PpvSkipView[]
}

const skip = (lineId: string, seq: number, code: PpvSkip): PpvSkipView => ({ lineId, seq, code, words: PPV_SKIP_WORDS[code] })

/** The variances already taken per source line: how many (for the next key) and whether one is live. */
async function takenOf(db: Reader, where: Prisma.PurchasePriceVarianceWhereInput, lineOf: (row: { receiptLineId: string | null; supplierInvoiceLineId: string | null }) => string | null) {
  const rows = await db.purchasePriceVariance.findMany({ where, select: VARIANCE_COLUMNS })
  const reversed = new Set(rows.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const out = new Map<string, { count: number; live: boolean }>()
  for (const row of rows.filter((entry) => entry.reversalOfId === null)) {
    const line = lineOf(row)
    if (!line) continue
    const seen = out.get(line) ?? { count: 0, live: false }
    out.set(line, { count: seen.count + 1, live: seen.live || !reversed.has(row.id) })
  }
  return out
}

/** A price per base unit in the standard's currency: as it is, or at the day's rate (null: no rate of that day). */
async function inCurrency(db: Reader, paid: string, from: string, to: string, day: BusinessDate): Promise<string | null> {
  if (from === to) return paid
  const rate = await dayRate(db, to, from, day)
  return rate ? convertUnit(paid, from, to, rate) : null
}

/** A goods receipt's variances (RECEIPT): each line's whole base quantity at its order line's price per base unit. */
export async function planReceipt(db: Reader, receiptId: string, ids: () => string = newId): Promise<PpvPlan | null> {
  const receipt = await db.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, companyId: true, siteId: true, number: true, supplierId: true, kind: true, status: true, receivedAt: true } })
  if (!receipt) return null
  const day = businessDate(receipt.receivedAt)
  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId }, select: { id: true, seq: true, itemId: true, baseQuantity: true, purchaseOrderLineId: true }, orderBy: { seq: 'asc' } })
  const plan = { at: 'RECEIPT' as const, companyId: receipt.companyId, documentId: receipt.id, number: receipt.number, ready: receipt.status === 'POSTED', status: receipt.status, day }
  if (receipt.kind === 'CUSTOMER_SUPPLIED') return { ...plan, drafts: [], skipped: lines.map((line) => skip(line.id, line.seq, 'CUSTOMER_OWNED')) }
  const taken = await takenOf(db, { receiptLineId: { in: lines.map((line) => line.id) } }, (row) => row.receiptLineId)
  const orderLines = new Map(
    (await db.purchaseOrderLine.findMany({ where: { id: { in: unique(lines.map((line) => line.purchaseOrderLineId)) } }, select: { id: true, unitPrice: true, quantity: true, baseQuantity: true, purchaseOrderId: true } })).map((row) => [row.id, row]),
  )
  const orders = new Map((await db.purchaseOrder.findMany({ where: { id: { in: unique([...orderLines.values()].map((row) => row.purchaseOrderId)) } }, select: { id: true, currency: true } })).map((row) => [row.id, row.currency]))
  const currency = costingCurrency((await db.company.findUnique({ where: { id: receipt.companyId }, select: { currency: true } }))?.currency ?? null)
  const standards = await frozenStandards(db, [receipt.companyId], unique(lines.map((line) => line.itemId)))
  const drafts: PpvDraft[] = []
  const skipped: PpvSkipView[] = []
  for (const line of lines) {
    const seen = taken.get(line.id)
    if (seen?.live) {
      skipped.push(skip(line.id, line.seq, 'TAKEN'))
      continue
    }
    const orderLine = line.purchaseOrderLineId ? orderLines.get(line.purchaseOrderLineId) : undefined
    if (!orderLine) {
      skipped.push(skip(line.id, line.seq, 'NO_ORDER_LINE'))
      continue
    }
    if (!line.baseQuantity.greaterThan(0)) {
      skipped.push(skip(line.id, line.seq, 'NO_QUANTITY'))
      continue
    }
    const standard = standardFor(standards, receipt.companyId, line.itemId, day, currency)
    if (!standard) {
      skipped.push(skip(line.id, line.seq, 'NO_STANDARD'))
      continue
    }
    const ordered = orderPaidPerBase(orderLine.unitPrice.toString(), orderLine.quantity.toString(), orderLine.baseQuantity.toString())
    const paid = ordered === null ? null : await inCurrency(db, ordered, orders.get(orderLine.purchaseOrderId) ?? currency, standard.currency, day)
    if (paid === null) {
      skipped.push(skip(line.id, line.seq, ordered === null ? 'NO_QUANTITY' : 'NO_RATE'))
      continue
    }
    const quantity = line.baseQuantity.toFixed(4)
    drafts.push({
      id: ids(),
      companyId: receipt.companyId,
      partyId: receipt.supplierId,
      at: 'RECEIPT',
      siteId: receipt.siteId,
      receiptLineId: line.id,
      supplierInvoiceLineId: null,
      itemId: line.itemId,
      quantity,
      standardUnitCost: standard.unitCost,
      standardCostId: standard.id,
      paidUnitCost: paid,
      differenceAmount: ppvDifference(quantity, paid, standard.unitCost, standard.currency),
      currency: standard.currency,
      idempotencyKey: ppvKeys.receiptLine(line.id, (seen?.count ?? 0) + 1),
    })
  }
  return { ...plan, drafts, skipped }
}

/** A supplier invoice's variances (INVOICE): each GOODS line on a purchase order line, at its net amount per base unit. */
export async function planInvoice(db: Reader, supplierInvoiceId: string, ids: () => string = newId): Promise<PpvPlan | null> {
  const invoice = await db.supplierInvoice.findUnique({ where: { id: supplierInvoiceId }, select: { id: true, companyId: true, partyId: true, number: true, kind: true, status: true, issueDate: true, currency: true } })
  if (!invoice) return null
  const day = invoice.issueDate.toISOString().slice(0, 10)
  const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId: invoice.id }, select: { id: true, seq: true, kind: true, quantity: true, netAmount: true, purchaseOrderLineId: true }, orderBy: { seq: 'asc' } })
  const ready = invoice.kind === 'INVOICE' && (invoice.status === 'APPROVED' || invoice.status === 'PAID')
  const plan = { at: 'INVOICE' as const, companyId: invoice.companyId, documentId: invoice.id, number: invoice.number, ready, status: invoice.kind === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : invoice.status, day }
  const taken = await takenOf(db, { supplierInvoiceLineId: { in: lines.map((line) => line.id) } }, (row) => row.supplierInvoiceLineId)
  const orderLines = new Map(
    (await db.purchaseOrderLine.findMany({ where: { id: { in: unique(lines.map((line) => line.purchaseOrderLineId)) } }, select: { id: true, itemId: true, quantity: true, baseQuantity: true } })).map((row) => [row.id, row]),
  )
  const currency = costingCurrency((await db.company.findUnique({ where: { id: invoice.companyId }, select: { currency: true } }))?.currency ?? null)
  const standards = await frozenStandards(db, [invoice.companyId], unique([...orderLines.values()].map((row) => row.itemId)))
  const drafts: PpvDraft[] = []
  const skipped: PpvSkipView[] = []
  for (const line of lines) {
    if (line.kind !== 'GOODS') {
      skipped.push(skip(line.id, line.seq, 'NOT_GOODS'))
      continue
    }
    const seen = taken.get(line.id)
    if (seen?.live) {
      skipped.push(skip(line.id, line.seq, 'TAKEN'))
      continue
    }
    const orderLine = line.purchaseOrderLineId ? orderLines.get(line.purchaseOrderLineId) : undefined
    if (!orderLine) {
      skipped.push(skip(line.id, line.seq, 'NO_ORDER_LINE'))
      continue
    }
    const base = line.quantity ? invoicedBaseQuantity(line.quantity.toString(), orderLine.quantity.toString(), orderLine.baseQuantity.toString()) : null
    const invoiced = base === null ? null : paidPerBase(line.netAmount, invoice.currency, base)
    if (base === null || invoiced === null || line.netAmount < 0) {
      skipped.push(skip(line.id, line.seq, 'NO_QUANTITY'))
      continue
    }
    const standard = standardFor(standards, invoice.companyId, orderLine.itemId, day, currency)
    if (!standard) {
      skipped.push(skip(line.id, line.seq, 'NO_STANDARD'))
      continue
    }
    const paid = await inCurrency(db, invoiced, invoice.currency, standard.currency, day)
    if (paid === null) {
      skipped.push(skip(line.id, line.seq, 'NO_RATE'))
      continue
    }
    drafts.push({
      id: ids(),
      companyId: invoice.companyId,
      partyId: invoice.partyId,
      at: 'INVOICE',
      siteId: null,
      receiptLineId: null,
      supplierInvoiceLineId: line.id,
      itemId: orderLine.itemId,
      quantity: base,
      standardUnitCost: standard.unitCost,
      standardCostId: standard.id,
      paidUnitCost: paid,
      differenceAmount: ppvDifference(base, paid, standard.unitCost, standard.currency),
      currency: standard.currency,
      idempotencyKey: ppvKeys.invoiceLine(line.id, (seen?.count ?? 0) + 1),
    })
  }
  return { ...plan, drafts, skipped }
}

/** Writes a plan's drafts inside the caller's command, with its audit row and event; returns the ids written. */
export async function writeVariances(tools: CommandTools, plan: PpvPlan): Promise<string[]> {
  if (plan.drafts.length === 0) return []
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tools.tx.purchasePriceVariance.createMany({ data: plan.drafts.map((draft) => ({ ...draft, postedAt: tools.now, createdAt: tools.now, createdById })) })
  tools.audit({
    action: 'costing.postPurchasePriceVariance',
    recordType: plan.at === 'RECEIPT' ? 'GoodsReceipt' : 'SupplierInvoice',
    recordId: plan.documentId,
    companyId: plan.companyId,
    after: { at: plan.at, number: plan.number, variances: plan.drafts.map((draft) => ({ id: draft.id, key: draft.idempotencyKey, quantity: draft.quantity, differenceAmount: markMoney('cost', draft.differenceAmount) })), skipped: plan.skipped.map((row) => row.code) },
  })
  tools.emit({ type: 'purchase_price_variance.posted', subject: plan.documentId, companyId: plan.companyId, payload: { at: plan.at, documentId: plan.documentId, varianceIds: plan.drafts.map((draft) => draft.id), reversals: 0 } })
  return plan.drafts.map((draft) => draft.id)
}
