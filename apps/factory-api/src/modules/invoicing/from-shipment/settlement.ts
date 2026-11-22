import { isUuid } from '@nexus/factory-domain/core/ids'
import { orderSettlement, type OrderSettlement, type SettlementFacts } from '@nexus/factory-domain/invoicing/from-shipment/settlement'
import { invoicePaymentStateOf } from '@nexus/factory-domain/invoicing/from-shipment/settlement' // B-OM-023
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { assertMay, officeContextOf, type Reader } from '../store'
import { lockInvoicing } from './locks'
// B-OP-022 (order page plan N3): this order's share, by the one rule the orders list reads (sales/orders later-columns).
import type { Prisma } from '@nexus/factory-db'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { orderMoneyOf, shareOf } from '@nexus/factory-domain/sales/orders/later-columns'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { Dec, HUNDRED } from '@nexus/factory-domain/tax/decimal'
import { actorOf } from '../../../core/context'
import { orderMoneyFactsOf } from '../../sales/orders/later-columns'
// B-OM-001 (order money tab M1-B1): a small difference written off on an invoice counts.
import { underpaymentsWrittenOff } from '../../payments/write-offs/sums'

/**
 * The order's settlement (B-W1-51; PLAN §4.7 "Closing the order"): the port B-W1-25's close command asks ("is every line
 * shipped, invoiced and paid?" = `settlementOf(db, orderId).settlement.settled`), the office's view of it, and the events
 * that say when it changes.
 *
 * Settled is not stored (no schema change in W1). Every command that may change it ends with `settleOrders`: under the
 * orders' 'order' locks, taken last, it compares the settled state now with what the order's audit trail last announced,
 * and on a change writes the audit row and emits `order.fully_settled` or `order.unsettled` (with what is missing), once.
 * Called by: a payment allocated or taken back (payments.ts, deposits.ts), an invoice issued (issue.ts: a TD04 or a new
 * invoice unsettles), an SDI outcome (sdi/record.ts syncInvoice notes the orders, `noteOrders`; the poll, the webhook and
 * the send result settle them at their end, `settleNoted`, after every invoice row they lock: settled only when every
 * document is DELIVERED or NOT_DELIVERABLE). Shipping and order amendments do not call it (their modules): B-W2b-GB02
 * (G148) the worker's `invoicing.settleAfterChanges` (settle-handler.ts) announces their effect after a shipment moved
 * (shipped, delivered, returned, cancelled) or an order was amended, split or had lines closed or reopened.
 */

const SHIPPED = ['SHIPPED', 'DELIVERED'] as const

// ── B-OM-003 (order money tab M5-B3): the order's deposit invoices (TD02) and credit notes (TD04) as rows ──
/** An issued TD02 of the order's deposit requests: its SDI life is its status; amounts gross (credited: its TD04s' gross). */
export interface SettlementDepositRow {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly issueDate: string | null
  readonly gross: number
  readonly credited: number
  /** What issued invoices deduct from it (net, positive). */
  readonly deductedNet: number
  readonly depositRequestId: string | null
}
/** An issued TD04 crediting one of the order's invoices or deposit invoices. */
export interface SettlementCreditRow {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly issueDate: string | null
  readonly gross: number
  readonly creditOfId: string
}
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
// ── end B-OM-003 ──

export interface OrderSettlementOf {
  readonly orderId: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  readonly settlement: OrderSettlement
  /** B-OM-003: its TD02 and TD04 rows, as read. */
  readonly documents: { readonly depositInvoices: readonly SettlementDepositRow[]; readonly creditNotes: readonly SettlementCreditRow[] }
}

/** The facts of an order's settlement, read now. Null: not found (or out of the reader's tenant). */
export async function settlementOf(db: Reader, orderId: string): Promise<OrderSettlementOf | null> {
  if (!isUuid(orderId)) return null
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, status: true, currency: true, companyId: true, partyId: true, lines: { select: { id: true, seq: true, kind: true, quantity: true, description: true, closedShortQuantity: true, feeCreditedAt: true, sizes: { select: { size: true, quantity: true } } } } },
  })
  if (!order) return null
  const lineIds = order.lines.map((line) => line.id)
  // B-W2b-396 (VI1:02): a fee credited against the customer's bulk order is settled there: this order never waits for it.
  const lines = order.lines.filter((line) => !(line.kind === 'FEE' && line.feeCreditedAt !== null))
  // B-W2b-330 (SAL-181): a fee line is never shipped: it counts as delivered in full, and is billed by the SERVICE line
  // that names it (modules/sales/price-waterfall/fee-invoicing), once.
  const fees = lines.filter((line) => line.kind === 'FEE')
  const shipped = [
    ...(await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lineIds }, shipment: { status: { in: [...SHIPPED] } } }, select: { salesOrderLineId: true, size: true, quantity: true } })),
    // (a fee closed short is dropped: it owes nothing)
    ...fees.filter((line) => line.closedShortQuantity === null).map((line) => ({ salesOrderLineId: line.id, size: '', quantity: line.quantity })),
  ]
  const billed = await db.invoiceLine.findMany({
    where: { salesOrderLineId: { in: lineIds }, OR: [{ kind: 'GOODS' }, ...(fees.length > 0 ? [{ kind: 'SERVICE' as const, salesOrderLineId: { in: fees.map((line) => line.id) } }] : [])], invoice: { docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' } } },
    select: { salesOrderLineId: true, size: true, quantity: true },
  })
  const invoices = await db.invoice.findMany({
    where: { docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' }, OR: [{ salesOrderId: order.id }, { lines: { some: { salesOrderLineId: { in: lineIds } } } }] },
    select: { id: true, docType: true, number: true, status: true, grossTotal: true },
    orderBy: { id: 'asc' },
  })
  const requests = await db.depositRequest.findMany({ where: { orderId: order.id }, select: { id: true, status: true, fiscalDocument: true, amount: true } })
  const deposits = await db.invoice.findMany({
    where: { docType: 'TD02', status: { not: 'DRAFT' }, OR: [{ salesOrderId: order.id }, ...(requests.length > 0 ? [{ depositRequestId: { in: requests.map((request) => request.id) } }] : [])] },
    select: { id: true, depositRequestId: true, number: true, status: true, netTotal: true, grossTotal: true, /* B-OM-003 */ issueDate: true },
    orderBy: { id: 'asc' },
  })
  const credited = [...invoices, ...deposits].map((invoice) => invoice.id)
  const credits = credited.length > 0 ? await db.invoice.findMany({ where: { creditOfId: { in: credited }, docType: 'TD04', status: { not: 'DRAFT' } }, select: { id: true, number: true, status: true, creditOfId: true, netTotal: true, grossTotal: true, /* B-OM-003 */ issueDate: true }, orderBy: { id: 'asc' } }) : []
  const allocations = await db.paymentAllocation.findMany({
    where: { OR: [...(invoices.length > 0 ? [{ invoiceId: { in: invoices.map((invoice) => invoice.id) } }] : []), ...(requests.length > 0 ? [{ depositRequestId: { in: requests.map((request) => request.id) } }] : [])] },
    select: { invoiceId: true, depositRequestId: true, amount: true },
  })
  const writtenOff = await underpaymentsWrittenOff(db, invoices.map((invoice) => invoice.id)) // B-OM-001
  const deductions = deposits.length > 0 ? await db.invoiceLine.findMany({ where: { depositInvoiceId: { in: deposits.map((deposit) => deposit.id) }, invoice: { status: { not: 'DRAFT' } } }, select: { depositInvoiceId: true, netAmount: true } }) : []
  // B-W2a-61: what PAID refunds of the credit notes gave back.
  const refunds = credits.length > 0 ? await db.refund.findMany({ where: { status: 'PAID', creditNoteId: { in: credits.map((credit) => credit.id) } }, select: { creditNoteId: true, amount: true } }) : []
  const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0)
  const refundedOn = (invoiceId: string) => sum(refunds.filter((refund) => credits.some((credit) => credit.id === refund.creditNoteId && credit.creditOfId === invoiceId)), (refund) => refund.amount)

  const facts: SettlementFacts = {
    order: { id: order.id, number: order.number, status: order.status, currency: order.currency },
    lines: lines.map((line) => ({
      salesOrderLineId: line.id,
      seq: line.seq,
      description: line.description ?? `line ${line.seq}`,
      sizes: line.sizes.length > 0 ? line.sizes.map((size) => ({ size: size.size, ordered: size.quantity })) : [{ size: null, ordered: line.quantity }],
      // B-W2a-54: a line closed short (B-W2a-30) owes nothing more of what it never shipped.
      closedShort: line.closedShortQuantity !== null,
    })),
    shipped: shipped.map((row) => ({ salesOrderLineId: row.salesOrderLineId, size: row.size, quantity: row.quantity })),
    invoiced: billed.map((row) => ({ salesOrderLineId: row.salesOrderLineId!, size: row.size, quantity: row.quantity.toFixed(4) })),
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      docType: invoice.docType,
      number: invoice.number,
      status: invoice.status,
      grossTotal: invoice.grossTotal,
      creditedGross: sum(credits.filter((credit) => credit.creditOfId === invoice.id), (credit) => credit.grossTotal),
      paid: sum(allocations.filter((row) => row.invoiceId === invoice.id), (row) => row.amount),
      refunded: refundedOn(invoice.id),
      writtenOff: writtenOff.get(invoice.id) ?? 0, // B-OM-001
    })),
    depositRequests: requests.map((request) => ({ id: request.id, status: request.status, fiscalDocument: request.fiscalDocument, amount: request.amount, paid: sum(allocations.filter((row) => row.depositRequestId === request.id), (row) => row.amount) })),
    depositInvoices: deposits.map((deposit) => ({
      id: deposit.id,
      depositRequestId: deposit.depositRequestId ?? '',
      number: deposit.number,
      status: deposit.status,
      netTotal: deposit.netTotal,
      grossTotal: deposit.grossTotal,
      creditedNet: sum(credits.filter((credit) => credit.creditOfId === deposit.id), (credit) => credit.netTotal),
      creditedGross: sum(credits.filter((credit) => credit.creditOfId === deposit.id), (credit) => credit.grossTotal),
      deductedNet: -sum(deductions.filter((line) => line.depositInvoiceId === deposit.id), (line) => line.netAmount),
      refunded: refundedOn(deposit.id),
    })),
    creditNotes: credits.map((credit) => ({ id: credit.id, number: credit.number, status: credit.status, creditOfId: credit.creditOfId! })),
  }
  // B-OM-003: the TD02 and TD04 rows (the settlement's own reads, with their issue day).
  const documents = {
    depositInvoices: facts.depositInvoices.map((deposit) => ({
      id: deposit.id,
      number: deposit.number,
      status: deposit.status,
      issueDate: dayOf(deposits.find((row) => row.id === deposit.id)?.issueDate ?? null),
      gross: deposit.grossTotal,
      credited: deposit.creditedGross,
      deductedNet: deposit.deductedNet,
      depositRequestId: deposits.find((row) => row.id === deposit.id)?.depositRequestId ?? null,
    })),
    creditNotes: credits.map((credit) => ({ id: credit.id, number: credit.number, status: credit.status, issueDate: dayOf(credit.issueDate), gross: credit.grossTotal, creditOfId: credit.creditOfId! })),
  }
  return { orderId: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId, settlement: orderSettlement(facts), documents }
}

/** The orders an invoice is about: its order, its lines' orders, a TD02's request's order, a TD04's credited invoice's. */
export async function ordersOfInvoices(db: Reader, invoiceIds: readonly string[]): Promise<string[]> {
  const orders = new Set<string>()
  let ids = [...new Set(invoiceIds)]
  for (let depth = 0; depth < 2 && ids.length > 0; depth++) {
    const rows = await db.invoice.findMany({ where: { id: { in: ids } }, select: { salesOrderId: true, creditOfId: true, depositRequest: { select: { orderId: true } } } })
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: { in: ids }, salesOrderLineId: { not: null } }, select: { salesOrderLine: { select: { orderId: true } } } })
    for (const row of rows) {
      if (row.salesOrderId) orders.add(row.salesOrderId)
      if (row.depositRequest?.orderId) orders.add(row.depositRequest.orderId)
    }
    for (const line of lines) if (line.salesOrderLine) orders.add(line.salesOrderLine.orderId)
    ids = rows.flatMap((row) => (row.creditOfId ? [row.creditOfId] : []))
  }
  return [...orders]
}

/** The orders of deposit requests. */
export async function ordersOfRequests(db: Reader, requestIds: readonly string[]): Promise<string[]> {
  if (requestIds.length === 0) return []
  const rows = await db.depositRequest.findMany({ where: { id: { in: [...requestIds] } }, select: { orderId: true } })
  return [...new Set(rows.flatMap((row) => (row.orderId ? [row.orderId] : [])))]
}

type SettleTools = Pick<CommandTools, 'tx' | 'context' | 'audit' | 'emit'>

export const ORDER_SETTLED = 'invoices.orderSettled'
export const ORDER_UNSETTLED = 'invoices.orderUnsettled'

/** What each running command announced already (deposit received allocates, then issues: one command, two calls). */
const announcedIn = new WeakMap<object, Map<string, boolean>>()

/**
 * Whether the order was last announced settled: its newest settlement audit row (ids are time-ordered UUIDv7, written
 * while the order's lock is held, so they follow the announcements' order). None: never settled.
 */
async function lastAnnounced(db: Reader, orderId: string): Promise<boolean> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, action: { in: [ORDER_SETTLED, ORDER_UNSETTLED] } }, orderBy: { id: 'desc' }, select: { action: true } })
  return row?.action === ORDER_SETTLED
}

/**
 * At the END of a command's work, after all of its writes: takes the orders' locks (the command's last locks, id order)
 * and, for each order whose settled state now differs from what was last announced (its audit trail), records it (an
 * audit row on the SalesOrder) and emits `order.fully_settled` or `order.unsettled`. Two commands that complete an order
 * at once queue on its lock: the second sees the first's change and announcement. Nothing waits for another lock after
 * these, so no lock cycle can form; a change made by a command that does not call it (shipping, an order amendment) is
 * announced by the next one that does.
 */
export async function settleOrders(tools: SettleTools, orderIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(orderIds)].sort()
  if (ids.length === 0) return
  await lockInvoicing(tools.tx, tools.context, 'order', ids)
  const announced = announcedIn.get(tools) ?? new Map<string, boolean>()
  announcedIn.set(tools, announced)
  for (const id of ids) {
    const now = await settlementOf(tools.tx, id)
    if (!now) continue
    const last = announced.get(id) ?? (await lastAnnounced(tools.tx, id))
    if (now.settlement.settled === last) continue
    announced.set(id, now.settlement.settled)
    const missing = now.settlement.missing.map((gap) => gap.code)
    tools.audit({
      action: now.settlement.settled ? ORDER_SETTLED : ORDER_UNSETTLED,
      recordType: 'SalesOrder',
      recordId: id,
      companyId: now.companyId,
      before: { settled: last },
      after: { settled: now.settlement.settled, missing, balanceDue: markMoney('price', now.settlement.money.balanceDue), refundDue: markMoney('price', now.settlement.money.refundDue) },
    })
    if (now.settlement.settled) tools.emit({ type: 'order.fully_settled', subject: id, companyId: now.companyId, payload: { orderId: id, partyId: now.partyId } })
    else tools.emit({ type: 'order.unsettled', subject: id, companyId: now.companyId, payload: { orderId: id, partyId: now.partyId, missing } })
  }
}

/** Orders a command will settle at its end (an SDI command applies several sends' messages, each under its invoice's row). */
const notedIn = new WeakMap<object, Set<string>>()

/** Notes orders to settle at the end of the command (settleNoted), without taking their locks now. */
export function noteOrders(tools: object, orderIds: Iterable<string>): void {
  const noted = notedIn.get(tools) ?? new Set<string>()
  for (const id of orderIds) noted.add(id)
  notedIn.set(tools, noted)
}

/** At the end of a command's work: settles the orders noted (settleOrders). */
export async function settleNoted(tools: SettleTools): Promise<void> {
  const noted = notedIn.get(tools)
  if (!noted || noted.size === 0) return
  notedIn.delete(tools)
  await settleOrders(tools, noted)
}

// ── B-OP-022 (order page plan N3; 13-backend §3; review N-4) ──────────────────────────────────────────────────────────────────
/** A FREIGHT charge line's amount with its VAT: its gross on a VAT-included invoice, else its net and the VAT at its rate. */
function freightGrossOf(line: { readonly netAmount: number; readonly grossAmount: number | null; readonly vatRatePct: Prisma.Decimal | string }): number {
  if (line.grossAmount !== null) return line.grossAmount
  return line.netAmount + Number(new Dec(line.netAmount).times(line.vatRatePct.toString()).dividedBy(HUNDRED).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0))
}

/**
 * The order's own share of its money, by the rule the orders list reads (sales/orders later-columns orderMoneyFactsOf, then
 * factory-domain orderMoneyOf), so its page and its row say the same paid and still to pay. Per invoice that bills it: its share
 * of the invoice's goods (the invoice's gross less its freight, split by the net each order's lines carry on it), what of that
 * share is still open (less its share of the credit notes and of what is paid), the freight apart (it is in no order), and the
 * other orders the invoice bills — the invoice's own buyer's only (a TD24 bills one customer), each named only when the reader
 * reaches it with orders.view, the rest counted.
 */
async function shareOfOrder(db: Reader, orderId: string, invoiceIds: readonly string[], actor: Actor) {
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, grossAmount: true, /* B-OM-002 */ status: true } })
  const lines = await db.salesOrderLine.findMany({ where: { orderId }, select: { id: true, orderId: true, kind: true, quantity: true, closedShortQuantity: true, feeCreditedAt: true, netAmount: true, vatAmount: true } })
  const money = await orderMoneyFactsOf(db, [orderId], lines)
  const answer = orderMoneyOf(money.factsOf(order))
  const shares = money.invoicesOf(orderId)
  const ids = [...new Set([...invoiceIds, ...shares.map((invoice) => invoice.id)])]
  const freightLines = ids.length > 0 ? await db.invoiceLine.findMany({ where: { invoiceId: { in: ids }, kind: 'CHARGE', chargeKind: 'FREIGHT' }, select: { invoiceId: true, netAmount: true, grossAmount: true, vatRatePct: true } }) : []
  const freightOf = (invoiceId: string) => freightLines.filter((line) => line.invoiceId === invoiceId).reduce((sum, line) => sum + freightGrossOf(line), 0)
  // The other orders each invoice bills: those of its order lines and the order it names, of its own buyer only.
  const heads = ids.length > 0 ? await db.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, buyerPartyId: true, salesOrderId: true } }) : []
  const billed = ids.length > 0 ? await db.invoiceLine.findMany({ where: { invoiceId: { in: ids }, salesOrderLineId: { not: null } }, select: { invoiceId: true, salesOrderLineId: true }, distinct: ['invoiceId', 'salesOrderLineId'] }) : []
  const ownLines = new Set(lines.map((line) => line.id))
  const foreignLineIds = [...new Set(billed.flatMap((line) => (line.salesOrderLineId && !ownLines.has(line.salesOrderLineId) ? [line.salesOrderLineId] : [])))]
  const orderOfLine = new Map((foreignLineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: foreignLineIds } }, select: { id: true, orderId: true } }) : []).map((line) => [line.id, line.orderId]))
  const othersOf = (invoiceId: string): string[] => {
    const head = heads.find((row) => row.id === invoiceId)
    const fromLines = billed.flatMap((line) => (line.invoiceId === invoiceId && line.salesOrderLineId ? [orderOfLine.get(line.salesOrderLineId)] : [])).filter((id): id is string => typeof id === 'string')
    return [...new Set([...fromLines, ...(head?.salesOrderId ? [head.salesOrderId] : [])])].filter((id) => id !== orderId)
  }
  const otherIds = [...new Set(ids.flatMap(othersOf))]
  const others = new Map((otherIds.length > 0 ? await db.salesOrder.findMany({ where: { id: { in: otherIds } }, select: { id: true, number: true, companyId: true, partyId: true } }) : []).map((row) => [row.id, row]))
  const invoiceOf = (invoiceId: string) => {
    const billing = shares.find((invoice) => invoice.id === invoiceId)
    const head = heads.find((row) => row.id === invoiceId)
    const freight = freightOf(invoiceId)
    const goods = billing ? shareOf(billing.grossTotal - freight, billing.part, billing.whole) : 0
    // B-OM-001: + its share of the small differences written off on it.
    const settled = billing ? shareOf(billing.creditedGross, billing.part, billing.whole) + shareOf(billing.placed - billing.refunded, billing.part, billing.whole) + shareOf(billing.writtenOff ?? 0, billing.part, billing.whole) : 0
    // Of the invoice's own buyer only (never another customer's order, not even counted); named only when the reader reaches it.
    const buyers = othersOf(invoiceId).flatMap((id) => (others.has(id) && others.get(id)!.partyId === head?.buyerPartyId ? [others.get(id)!] : []))
    const named = buyers.filter((row) => can(actor, ORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId })).sort((a, b) => a.number.localeCompare(b.number))
    return { share: goods, openShare: Math.max(0, goods - settled), freight, otherOrders: named.map((row) => ({ id: row.id, number: row.number })), otherOrdersHidden: buyers.length - named.length }
  }
  const invoicedShare = shares.reduce((sum, invoice) => sum + shareOf(invoice.grossTotal - freightOf(invoice.id), invoice.part, invoice.whole) - shareOf(invoice.creditedGross, invoice.part, invoice.whole), 0)
  const writtenOffShare = shares.reduce((sum, invoice) => sum + shareOf(invoice.writtenOff ?? 0, invoice.part, invoice.whole), 0) // B-OM-001
  return { thisOrder: { paid: answer.paid, stillToPay: answer.balance, invoicedShare, depositsPaid: money.depositsPaidOf(orderId), writtenOff: writtenOffShare }, invoiceOf }
}
// ── end B-OP-022 ──

/** invoices.view (A2 SCR-081 "Deposits & payments", SCR-082): the order's settlement, money with the price grain. */
export async function getSettlement(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const found = await caller.withClient((client) => settlementOf(client, orderId))
  assertMay(context, INVOICES_VIEW, INVOICES_VIEW, found ? { companyId: found.companyId, partyId: found.partyId } : null, 'Order')
  const { settlement, documents } = found! // B-OM-003: + the TD02 / TD04 rows
  // B-OP-022: this order's share (the list's rule), each invoice's share and the other orders it bills.
  const ours = await caller.withClient((client) => shareOfOrder(client, found!.orderId, settlement.invoices.map((invoice) => invoice.id), actorOf(context)))
  return {
    settlement: {
      orderId: found!.orderId,
      number: found!.number,
      settled: settlement.settled,
      gaps: settlement.missing.map((gap) => gap.code),
      // The words may name amounts: with the price grain only.
      missing: asMoney('price', [...settlement.missing]),
      fullyShipped: settlement.fullyShipped,
      fullyInvoiced: settlement.fullyInvoiced,
      documentsFinal: settlement.documentsFinal,
      lines: [...settlement.lines],
      invoices: settlement.invoices.map((invoice) => {
        const mine = ours.invoiceOf(invoice.id) // B-OP-022
        return {
          id: invoice.id,
          docType: invoice.docType,
          number: invoice.number,
          status: invoice.status,
          grossTotal: asMoney('price', invoice.grossTotal),
          creditedAmount: asMoney('price', invoice.creditedGross),
          paidAmount: asMoney('price', invoice.paid),
          openAmount: asMoney('price', invoice.open),
          refundDueAmount: asMoney('price', invoice.refundDue),
          writtenOffAmount: asMoney('price', invoice.writtenOff ?? 0), // B-OM-001
          paymentState: invoicePaymentStateOf(invoice), // B-OM-023: a word-code, no amount (every invoices.view reader)
          // ── B-OP-022: this order's share of it, the freight apart, the other orders it bills (its buyer's only) ──
          share: asMoney('price', mine.share),
          openShare: asMoney('price', mine.openShare),
          freight: asMoney('price', mine.freight),
          otherOrders: mine.otherOrders,
          otherOrdersHidden: mine.otherOrdersHidden,
        }
      }),
      // ── B-OM-003 (order money tab M5-B3): the TD02s of its deposit requests and the TD04s crediting its documents; the status
      // is the SDI life (no per-invoice SDI read); amounts with the price grain only ──
      depositInvoices: documents.depositInvoices.map((row) => ({ id: row.id, number: row.number, status: row.status, issueDate: row.issueDate, gross: asMoney('price', row.gross), credited: asMoney('price', row.credited), deductedNet: asMoney('price', row.deductedNet), depositRequestId: row.depositRequestId })),
      creditNotes: documents.creditNotes.map((row) => ({ id: row.id, number: row.number, status: row.status, issueDate: row.issueDate, gross: asMoney('price', row.gross), creditOfId: row.creditOfId })),
      // ── end B-OM-003 ──
      invoicedAmount: asMoney('price', settlement.money.invoicedGross),
      creditedAmount: asMoney('price', settlement.money.creditedGross),
      paidAmount: asMoney('price', settlement.money.paidOnInvoices),
      depositsPaidWithoutInvoiceAmount: asMoney('price', settlement.money.depositsPaidWithoutInvoice),
      balanceDueAmount: asMoney('price', settlement.money.balanceDue),
      refundDueAmount: asMoney('price', settlement.money.refundDue),
      writtenOffAmount: asMoney('price', settlement.money.writtenOff), // B-OM-001
      // B-OP-022: Money = this order's share (the list's paid and balance).
      thisOrder: {
        paid: asMoney('price', ours.thisOrder.paid),
        stillToPay: asMoney('price', ours.thisOrder.stillToPay),
        invoicedShare: asMoney('price', ours.thisOrder.invoicedShare),
        depositsPaid: asMoney('price', ours.thisOrder.depositsPaid),
        writtenOff: asMoney('price', ours.thisOrder.writtenOff), // B-OM-001
      },
    },
  }
}

// ---- B-W2b-GB02 (G148; B-W1-51's gap "order.unsettled only from watched commands") -----------------------------------------

/** Whether the order's settled state now differs from what its history last announced (a change nobody announced yet). */
export async function settledStateChanged(db: Reader, orderId: string): Promise<boolean> {
  const now = await settlementOf(db, orderId)
  if (!now) return false
  return now.settlement.settled !== (await lastAnnounced(db, orderId))
}
// ---- end B-W2b-GB02
