import type { FactoryClient } from '@nexus/factory-db'
import type { WaitingView } from '@nexus/factory-domain/costing/ledger/contracts'
import type { EntryDraft } from '@nexus/factory-domain/costing/ledger/entries'
import { earnedAmount } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { CommandTx } from '../../../core/command'
// B-W2b-111: good pieces of a receipt waiting for its incoming inspection earn nothing yet.
import { heldGoodByOperation } from './held'
// B-W2b-331 (SCM-146): the workshop's own cost entries of the orders, and the pieces their FEE entries book.
import { bookedFeePieces, workshopEntryPlan } from '../subcontract-depth/cost-source'
// B-W2b-389 (CY1:03): the fee of an order in another currency posted in the work order's currency.
import { convertMinor, convertUnit } from '@nexus/factory-domain/money/currency/convert'
import { rateWords } from '@nexus/factory-domain/money/currency/rates'
import { orderRateOf, type OrderRate } from '../subcontract-depth/rate'

/**
 * The subcontract source of the work order's cost ledger (B-W2a-25; FIN-026; cost-ledger.prisma WorkOrderCostEntry kind
 * SUBCONTRACT): what a workshop earned on a work order is its fee per piece × the pieces it sent back GOOD, per operation
 * of each issued order (defective and scrapped pieces earn nothing until a supplier invoice says otherwise, B-W2a-62).
 * modules/costing/actual/post.ts `planCosts` reads it like its other sources, so a receipt posts in its own command
 * (receive.ts: postCostsInCommand with `subcontractOrderIds`), and a catch-up or a retried job never posts twice:
 *
 *   per operation   target = earnedAmount(piecesBackGood, fee, the order's currency); posted = the sum of the
 *                   operation's SUBCONTRACT entries (sourceType SubcontractOperation, sourceId its id); a difference posts
 *                   one entry of that amount (negative when a count went down), key `subcontract:<operationId>:<n>` (n =
 *                   its entries so far + 1), dated when the counts last changed (the operation's updatedAt).
 *   currency        B-W2b-389 (CY1:03): an order in another currency than the work order's cost posts in the work
 *                   order's currency at the day's rate of its issue day (subcontract-depth/rate.ts); with no rate of that
 *                   day it waits, in words.
 *   held            B-W2b-111 (QHS-036, held.ts): the good pieces of a receipt whose incoming inspection is OPEN are left out
 *                   of piecesBackGood until it is decided (the decision's command posts again: a rejected bundle's pieces
 *                   are defective by then, so they never earn).
 */

type Reader = FactoryClient | CommandTx

/** An entry the ledger holds (or plans), as this source reads it. */
export interface PostedFacts {
  readonly kind: string
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly amount: number
  readonly idempotencyKey: string
}

export const subcontractKey = (operationId: string, n: number): string => `subcontract:${operationId}:${n}`

/** The SUBCONTRACT entries the work order's issued orders (all of them, or these) lack. */
export async function subcontractCostPlan(
  db: Reader,
  workOrder: { readonly id: string; readonly currency: string },
  orderIds: readonly string[] | null,
  existing: readonly PostedFacts[],
  ids: () => string,
): Promise<{ drafts: EntryDraft[]; waiting: WaitingView[] }> {
  const orders = await db.subcontractOrder.findMany({
    where: { workOrderId: workOrder.id, status: { notIn: ['DRAFT', 'CANCELLED'] }, ...(orderIds ? { id: { in: [...orderIds] } } : {}) },
    select: { id: true, number: true, currency: true, issuedAt: true, orderDate: true },
    orderBy: { id: 'asc' },
  })
  if (orders.length === 0) return { drafts: [], waiting: [] }
  const operations = await db.subcontractOperation.findMany({
    where: { subcontractOrderId: { in: orders.map((order) => order.id) } },
    select: { id: true, subcontractOrderId: true, seq: true, pricePerPiece: true, piecesBackGood: true, updatedAt: true },
    orderBy: [{ subcontractOrderId: 'asc' }, { seq: 'asc' }],
  })
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const held = await heldGoodByOperation(db, orders.map((order) => order.id))
  // B-W2b-331: pieces a FEE entry of the order's own cost ledger books (at the workshop's price) earn nothing here.
  const booked = await bookedFeePieces(db, orders.map((order) => order.id))
  const drafts: EntryDraft[] = []
  const waiting: WaitingView[] = []
  // B-W2b-389 (CY1:03): an order in another currency converts at the day's rate of its issue day (one rate per order).
  const rates = new Map<string, OrderRate>()
  for (const order of orders) if (order.currency !== workOrder.currency) rates.set(order.id, await orderRateOf(db, order, workOrder.currency))
  for (const operation of operations) {
    const order = orderOf.get(operation.subcontractOrderId)!
    const posted = existing.filter((entry) => entry.kind === 'SUBCONTRACT' && entry.sourceType === 'SubcontractOperation' && entry.sourceId === operation.id)
    const sum = posted.reduce((total, entry) => total + entry.amount, 0)
    const fee = operation.pricePerPiece.toFixed(6)
    const good = Math.max(0, operation.piecesBackGood - (held.get(operation.id) ?? 0) - (booked.get(operation.id) ?? 0))
    const converted = rates.get(order.id)
    if (converted && converted.rate === null) {
      if (good > 0 && sum === 0) {
        waiting.push({ code: 'CURRENCY', sourceType: 'SubcontractOrder', sourceId: order.id, words: `Subcontract order ${order.number} is in ${order.currency}; the work order's cost is kept in ${workOrder.currency}. ${converted.words}` })
      }
      continue
    }
    const rate = converted?.rate ?? null
    const earned = earnedAmount(good, fee, order.currency)
    const amount = (rate ? convertMinor(earned, order.currency, workOrder.currency, rate) : earned) - sum
    if (amount === 0) continue
    const key = subcontractKey(operation.id, posted.length + 1)
    if (existing.some((entry) => entry.idempotencyKey === key)) continue
    drafts.push({
      id: ids(),
      kind: 'SUBCONTRACT',
      occurredAt: operation.updatedAt,
      itemId: null,
      quantity: null,
      minutes: null,
      unitCost: rate ? convertUnit(fee, order.currency, workOrder.currency, rate) : fee,
      standardUnitCost: null,
      standardCostId: null,
      amount,
      stockMoveId: null,
      operationScanId: null,
      subcontractOrderId: order.id,
      supplierInvoiceLineId: null,
      sourceType: 'SubcontractOperation',
      sourceId: operation.id,
      reversalOfId: null,
      reason: `Workshop fee of ${order.number}, operation ${operation.seq}: ${good} piece(s) back good in all${(held.get(operation.id) ?? 0) > 0 ? ` (${held.get(operation.id)} waiting for incoming inspection)` : ''}${(booked.get(operation.id) ?? 0) > 0 ? ` (${booked.get(operation.id)} booked at the workshop's price)` : ''}${rate ? `; in ${workOrder.currency} at ${rateWords(rate)} of ${rate.rateDate}` : ''}`,
      idempotencyKey: key,
    })
  }
  // B-W2b-331: each of the orders' own cost entries, once, onto the work order (B-W2b-389: converted at the same rate).
  const workshop = await workshopEntryPlan(db, workOrder, orders, existing, ids, rates)
  return { drafts: [...drafts, ...workshop.drafts], waiting: [...waiting, ...workshop.waiting] }
}
