import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { matchLine, matchStatusOf, MATCH_SETTINGS, sameFacts, type GoodsFacts, type LineMatch, type MatchSettings, type MatchStatus, type SubcontractFacts } from '@nexus/factory-domain/payables/match'
import { matchSettingsOf } from '@nexus/factory-domain/payables/settings'
import type { CommandTools } from '../../core/command'
import { payablesSettingsFor } from './settings'
import { actorIdOf, invoiceInCommand, lockOrders, readLines, readMatches, RECORD, type InvoiceRow, type LineRow, type Reader } from './store'

/**
 * The three-way match in the database (B-W2a-62; FIN-137; the rule: factory-domain payables/match). Inside the caller's
 * command, after the invoice's row is held: the locks of every order the lines bill, the facts of each mapped goods or
 * subcontract line (the order line, the POSTED receipts against it, what the supplier's other live invoices bill on it),
 * one SupplierInvoiceMatch row per such line (the old ones deleted: the match is redone with new rows; an acceptance
 * whose facts did not change is kept), the invoice's matchStatus and matchedAt. A credit note is never matched: its
 * lines take off what their order lines' invoices bill.
 *
 * B-W2b-21 (Z8:03): the tolerances, the amount tolerance and the billing basis come from the company's payables settings
 * (settings.ts; factory-domain payables/settings matchSettingsOf), each match row copying the tolerances it was made with.
 */

const ENDED_ORDERS = ['CLOSED', 'CANCELLED']
const dec = (value: Prisma.Decimal | string | number | null): InstanceType<typeof Dec> => new Dec(value === null ? 0 : value.toString())

/** What the supplier's OTHER live invoices bill on an order line or subcontract order (credit notes take off). */
async function billedElsewhere(db: Reader, invoiceId: string, where: { purchaseOrderLineId: string } | { subcontractOrderId: string }): Promise<string> {
  const lines = await db.supplierInvoiceLine.findMany({
    where: { ...where, invoiceId: { not: invoiceId }, invoice: { status: { not: 'VOIDED' } } },
    select: { id: true, quantity: true, invoice: { select: { kind: true } }, matches: { select: { invoicedQuantity: true }, take: 1 } },
  })
  let total = new Dec(0)
  for (const line of lines) {
    const quantity = line.quantity ?? line.matches[0]?.invoicedQuantity ?? null
    if (quantity === null) continue
    total = line.invoice.kind === 'CREDIT_NOTE' ? total.minus(dec(quantity)) : total.plus(dec(quantity))
  }
  return Dec.max(0, total).toFixed(4)
}

export interface GoodsLineFacts {
  readonly facts: GoodsFacts
  readonly siteId: string
  readonly currency: string
  readonly receiptLineId: string | null
  readonly orderLine: { readonly id: string; readonly seq: number; readonly orderId: string; readonly orderNumber: string; readonly uom: string; readonly quantity: string; readonly item: { readonly code: string; readonly name: string } }
}

export interface SubcontractLineFacts {
  readonly facts: SubcontractFacts
  readonly siteId: string
  readonly currency: string
  readonly order: { readonly id: string; readonly number: string; readonly status: string; readonly workOrderId: string }
}

export async function goodsFacts(db: Reader, invoiceId: string, purchaseOrderLineId: string): Promise<GoodsLineFacts | null> {
  const line = await db.purchaseOrderLine.findUnique({
    where: { id: purchaseOrderLineId },
    select: {
      id: true,
      seq: true,
      siteId: true,
      quantity: true,
      uom: true,
      unitPrice: true,
      areaTolerancePct: true,
      cancelledAt: true,
      closedShortAt: true,
      item: { select: { code: true, name: true } },
      purchaseOrder: { select: { id: true, number: true, status: true, currency: true } },
    },
  })
  if (!line) return null
  const receipts = await db.goodsReceiptLine.findMany({
    where: { purchaseOrderLineId, receipt: { status: 'POSTED' } },
    select: { id: true, quantity: true, receipt: { select: { postedAt: true } } },
    orderBy: [{ receipt: { postedAt: 'asc' } }, { id: 'asc' }],
  })
  const received = receipts.reduce((total, receipt) => total.plus(dec(receipt.quantity)), new Dec(0))
  return {
    siteId: line.siteId,
    currency: line.purchaseOrder.currency,
    receiptLineId: receipts.at(-1)?.id ?? null,
    orderLine: { id: line.id, seq: line.seq, orderId: line.purchaseOrder.id, orderNumber: line.purchaseOrder.number, uom: line.uom, quantity: dec(line.quantity).toFixed(4), item: line.item },
    facts: {
      kind: 'GOODS',
      orderedQuantity: dec(line.quantity).toFixed(4),
      orderedUnitPrice: dec(line.unitPrice).toFixed(6),
      orderUom: line.uom,
      received: received.toFixed(4),
      billedElsewhere: await billedElsewhere(db, invoiceId, { purchaseOrderLineId }),
      ended: line.cancelledAt !== null || line.closedShortAt !== null || ENDED_ORDERS.includes(line.purchaseOrder.status),
      lineTolerancePct: line.areaTolerancePct === null ? null : dec(line.areaTolerancePct).toFixed(4),
    },
  }
}

export async function subcontractFacts(db: Reader, invoiceId: string, subcontractOrderId: string): Promise<SubcontractLineFacts | null> {
  const order = await db.subcontractOrder.findUnique({
    where: { id: subcontractOrderId },
    select: { id: true, number: true, status: true, siteId: true, currency: true, workOrderId: true, operations: { select: { pieces: true, piecesBackGood: true, pricePerPiece: true } } },
  })
  if (!order) return null
  let orderedValue = new Dec(0)
  let goodValue = new Dec(0)
  for (const operation of order.operations) {
    orderedValue = orderedValue.plus(dec(operation.pricePerPiece).times(operation.pieces))
    goodValue = goodValue.plus(dec(operation.pricePerPiece).times(operation.piecesBackGood))
  }
  return {
    siteId: order.siteId,
    currency: order.currency,
    order: { id: order.id, number: order.number, status: order.status, workOrderId: order.workOrderId },
    facts: {
      kind: 'SUBCONTRACT',
      orderedPieces: order.operations.reduce((total, operation) => total + operation.pieces, 0),
      piecesBackGood: order.operations.reduce((total, operation) => total + operation.piecesBackGood, 0),
      orderedValue: orderedValue.toFixed(6),
      goodValue: goodValue.toFixed(6),
      billedElsewhere: await billedElsewhere(db, invoiceId, { subcontractOrderId }),
      ended: ENDED_ORDERS.includes(order.status),
    },
  }
}

/** The match settings of an invoice's company (its payables settings, else the W2a rule). */
export async function matchSettingsFor(db: Reader, companyId: string): Promise<MatchSettings> {
  return matchSettingsOf(await payablesSettingsFor(db, companyId))
}

/** A line's match now, from the facts as they stand (null: not a matched line). */
export async function freshMatch(db: Reader, invoice: Pick<InvoiceRow, 'id' | 'kind' | 'currency'>, line: LineRow, settings: MatchSettings = MATCH_SETTINGS): Promise<{ match: LineMatch; goods: GoodsLineFacts | null; subcontract: SubcontractLineFacts | null } | null> {
  if (invoice.kind === 'CREDIT_NOTE') return null
  const invoiced = { quantity: line.quantity === null ? null : dec(line.quantity).toFixed(4), uom: line.uom, netAmount: line.netAmount }
  if (line.kind === 'GOODS' && line.purchaseOrderLineId) {
    const goods = await goodsFacts(db, invoice.id, line.purchaseOrderLineId)
    return goods ? { match: matchLine(invoiced, goods.facts, invoice.currency, settings), goods, subcontract: null } : null
  }
  if (line.kind === 'SUBCONTRACT' && line.subcontractOrderId) {
    const subcontract = await subcontractFacts(db, invoice.id, line.subcontractOrderId)
    return subcontract ? { match: matchLine(invoiced, subcontract.facts, invoice.currency, settings), goods: null, subcontract } : null
  }
  return null
}

export interface MatchOutcome {
  readonly matchStatus: MatchStatus
  readonly previous: MatchStatus
  readonly matches: number
  readonly outside: number
  readonly accepted: number
  readonly changed: boolean
}

/**
 * Redoes the invoice's match inside the caller's command (the invoice's row already held). `announce`: emit
 * supplier_invoice.matched even when nothing changed (a person asked). Refuses nothing: an invoice past RECEIVED and
 * DISPUTED keeps the match it was approved with.
 */
export async function rematchInCommand(tools: CommandTools, invoiceId: string, options: { readonly announce?: boolean; readonly bySystem?: boolean } = {}): Promise<MatchOutcome> {
  const { tx } = tools
  const invoice = await invoiceInCommand(tx, invoiceId)
  const previous = invoice.matchStatus as MatchStatus
  if (invoice.status !== 'RECEIVED' && invoice.status !== 'DISPUTED') return { matchStatus: previous, previous, matches: 0, outside: 0, accepted: 0, changed: false }
  const lines = await readLines(tx, invoiceId)
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : null
  if (tenantId) await lockOrders(tx, tenantId, lines.flatMap((line) => [line.purchaseOrderLineId, line.subcontractOrderId].filter((value): value is string => value !== null)))
  const before = await readMatches(tx, invoiceId)
  const settings = await matchSettingsFor(tx, invoice.companyId)
  const factsOf = (row: (typeof before)[number]) => ({
    invoicedQuantity: row.invoicedQuantity.toString(),
    receivedQuantity: row.receivedQuantity.toString(),
    orderedUnitPrice: row.orderedUnitPrice.toString(),
    invoicedUnitPrice: row.invoicedUnitPrice.toString(),
    differenceAmount: row.differenceAmount,
    withinTolerance: row.withinTolerance,
  })
  const keep = new Set<string>()
  const states: { withinTolerance: boolean; verdict: LineMatch['verdict']; accepted: boolean }[] = []
  let written = 0
  for (const line of lines) {
    const fresh = await freshMatch(tx, invoice, line, settings)
    if (!fresh) continue
    const siteId = fresh.goods?.siteId ?? fresh.subcontract!.siteId
    const receiptLineId = line.kind === 'GOODS' ? (fresh.goods?.receiptLineId ?? null) : null
    const sameOrder = (row: (typeof before)[number]) => row.invoiceLineId === line.id && row.purchaseOrderLineId === (line.kind === 'GOODS' ? line.purchaseOrderLineId : null) && row.subcontractOrderId === (line.kind === 'SUBCONTRACT' ? line.subcontractOrderId : null)
    const sameMatch = (row: (typeof before)[number]) => sameOrder(row) && sameFacts(factsOf(row), fresh.match)
    // The same match as before stays as it is (its id, acceptance and version).
    const same = before.find(
      (row) => !keep.has(row.id) && sameMatch(row) && row.goodsReceiptLineId === receiptLineId && dec(row.quantityTolerancePct).equals(dec(fresh.match.quantityTolerancePct)) && dec(row.priceTolerancePct).equals(dec(fresh.match.priceTolerancePct)),
    )
    if (same) {
      keep.add(same.id)
      states.push({ withinTolerance: same.withinTolerance, verdict: fresh.match.verdict, accepted: same.acceptedAt !== null })
      continue
    }
    // Written again; a person's acceptance of the same facts outside the tolerance is kept.
    const accepted = fresh.match.withinTolerance ? null : (before.find((row) => row.acceptedAt !== null && sameMatch(row)) ?? null)
    await tx.supplierInvoiceMatch.create({
      data: {
        id: newId(),
        siteId,
        partyId: invoice.partyId,
        invoiceId,
        invoiceLineId: line.id,
        purchaseOrderLineId: line.kind === 'GOODS' ? line.purchaseOrderLineId : null,
        goodsReceiptLineId: receiptLineId,
        subcontractOrderId: line.kind === 'SUBCONTRACT' ? line.subcontractOrderId : null,
        invoicedQuantity: fresh.match.invoicedQuantity,
        receivedQuantity: fresh.match.receivedQuantity,
        orderedUnitPrice: fresh.match.orderedUnitPrice,
        invoicedUnitPrice: fresh.match.invoicedUnitPrice,
        differenceAmount: fresh.match.differenceAmount,
        quantityTolerancePct: fresh.match.quantityTolerancePct,
        priceTolerancePct: fresh.match.priceTolerancePct,
        withinTolerance: fresh.match.withinTolerance,
        ...(accepted ? { acceptedAt: accepted.acceptedAt, acceptedById: accepted.acceptedById, acceptNote: accepted.acceptNote } : {}),
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    written++
    states.push({ withinTolerance: fresh.match.withinTolerance, verdict: fresh.match.verdict, accepted: accepted !== null })
  }
  const stale = before.filter((row) => !keep.has(row.id)).map((row) => row.id)
  if (stale.length > 0) await tx.supplierInvoiceMatch.deleteMany({ where: { id: { in: stale } } })
  const rows = states
  const matchStatus = matchStatusOf(invoice.kind as 'INVOICE' | 'CREDIT_NOTE', lines.map((line) => ({ kind: line.kind, mapped: line.purchaseOrderLineId !== null || line.subcontractOrderId !== null })), states)
  const outside = states.filter((state) => !state.withinTolerance).length
  const accepted = states.filter((state) => state.accepted).length
  const changed = matchStatus !== previous || stale.length > 0 || written > 0
  if (matchStatus !== previous || invoice.matchedAt === null || changed) {
    await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { matchStatus, matchedAt: tools.now }, select: { id: true } })
  }
  if (changed || options.announce) {
    tools.audit({ action: 'payables.match', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, before: { matchStatus: previous }, after: { matchStatus, matches: rows.length, outside, accepted, bySystem: options.bySystem ?? false } })
    tools.emit({
      type: 'supplier_invoice.matched',
      subject: invoiceId,
      companyId: invoice.companyId,
      payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: invoice.status, matchStatus, previousMatchStatus: previous, matches: rows.length, outside, accepted, bySystem: options.bySystem ?? false },
    })
  }
  return { matchStatus, previous, matches: rows.length, outside, accepted, changed }
}

/** The invoices still matched (RECEIVED, DISPUTED) whose lines bill these order lines or subcontract orders. */
export async function invoicesBilling(db: Reader, refs: { readonly purchaseOrderLineIds?: readonly string[]; readonly subcontractOrderIds?: readonly string[] }): Promise<string[]> {
  const or: Prisma.SupplierInvoiceLineWhereInput[] = [
    ...(refs.purchaseOrderLineIds && refs.purchaseOrderLineIds.length > 0 ? [{ purchaseOrderLineId: { in: [...refs.purchaseOrderLineIds] } }] : []),
    ...(refs.subcontractOrderIds && refs.subcontractOrderIds.length > 0 ? [{ subcontractOrderId: { in: [...refs.subcontractOrderIds] } }] : []),
  ]
  if (or.length === 0) return []
  const rows = await db.supplierInvoiceLine.findMany({ where: { OR: or, invoice: { status: { in: ['RECEIVED', 'DISPUTED'] }, kind: 'INVOICE' } }, select: { invoiceId: true }, distinct: ['invoiceId'], orderBy: { invoiceId: 'asc' } })
  return rows.map((row) => row.invoiceId)
}

export { MATCH_SETTINGS }
