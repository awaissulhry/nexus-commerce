import type { FactoryClient } from '@nexus/factory-db'
import type { WaitingView } from '@nexus/factory-domain/costing/ledger/contracts'
import type { EntryDraft } from '@nexus/factory-domain/costing/ledger/entries'
import { bookedPiecesOf, costKindWords, type CostKind } from '@nexus/factory-domain/purchasing/subcontract-depth/cost'
import type { CommandTx } from '../../../core/command'

/**
 * The workshop's own cost entries as a source of the work order's cost ledger (B-W2b-331; SCM-146; FIN-026;
 * cost-ledger.prisma WorkOrderCostEntry kind SUBCONTRACT): W2a's subcontract source (../subcontracting/cost-source.ts)
 * calls these, so costing's one poster (modules/costing/actual/post.ts planCosts) posts them like its other sources, in the
 * command that books them (cost.ts: postCostsInCommand with `subcontractOrderIds`), and a catch-up or a retried job never
 * posts twice:
 *
 *   per entry     each SubcontractCostEntry of the work order's issued orders posts one SUBCONTRACT entry of its amount
 *                 (key `subcontract-entry:<id>`, sourceType SubcontractCostEntry, dated when it was incurred); a reversal
 *                 posts its own (negative) entry, so the work order's cost follows the order's ledger line by line
 *   FEE pieces    the pieces a FEE entry books are paid there at the workshop's price: W2a's earned fee leaves them out
 *                 (`bookedFeePieces`), so a piece is never paid twice
 *   currency      an order in another currency than the work order's cost waits, in words (no exchange rates), as W2a's
 *
 * The entries' words name the order, the kind and the operation, never a price or an amount (the ledger's reason shows to
 * people without the cost grain).
 */

type Reader = FactoryClient | CommandTx

export const workshopEntryKey = (entryId: string): string => `subcontract-entry:${entryId}`

/** The pieces FEE entries of these orders book, per operation (taken back ones out). */
export async function bookedFeePieces(db: Reader, orderIds: readonly string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.subcontractCostEntry.findMany({
    where: { subcontractOrderId: { in: [...orderIds] }, kind: 'FEE' },
    select: { id: true, kind: true, subcontractOperationId: true, quantity: true, amount: true, reversalOfId: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  return bookedPiecesOf(rows.map((row) => ({ ...row, kind: row.kind as CostKind, quantity: row.quantity.toString() })))
}

/** The SUBCONTRACT entries the orders' own cost entries lack on the work order. */
export async function workshopEntryPlan(
  db: Reader,
  workOrder: { readonly id: string; readonly currency: string },
  orders: readonly { readonly id: string; readonly number: string; readonly currency: string }[],
  existing: readonly { readonly idempotencyKey: string }[],
  ids: () => string,
): Promise<{ drafts: EntryDraft[]; waiting: WaitingView[] }> {
  if (orders.length === 0) return { drafts: [], waiting: [] }
  const entries = await db.subcontractCostEntry.findMany({
    where: { subcontractOrderId: { in: orders.map((order) => order.id) } },
    select: { id: true, subcontractOrderId: true, kind: true, subcontractOperationId: true, unitPrice: true, amount: true, occurredAt: true, reversalOfId: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  if (entries.length === 0) return { drafts: [], waiting: [] }
  const operations = new Map(
    (await db.subcontractOperation.findMany({ where: { id: { in: entries.flatMap((entry) => (entry.subcontractOperationId ? [entry.subcontractOperationId] : [])) } }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]),
  )
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const keys = new Set(existing.map((entry) => entry.idempotencyKey))
  const drafts: EntryDraft[] = []
  const waiting: WaitingView[] = []
  const waits = new Set<string>()
  for (const entry of entries) {
    const key = workshopEntryKey(entry.id)
    if (keys.has(key)) continue
    const order = orderOf.get(entry.subcontractOrderId)!
    if (order.currency !== workOrder.currency) {
      if (!waits.has(order.id)) {
        waits.add(order.id)
        waiting.push({ code: 'CURRENCY', sourceType: 'SubcontractOrder', sourceId: order.id, words: `The workshop's charges on subcontract order ${order.number} are in ${order.currency}; the work order's cost is kept in ${workOrder.currency} (no exchange rates).` })
      }
      continue
    }
    const seq = entry.subcontractOperationId ? operations.get(entry.subcontractOperationId) : undefined
    drafts.push({
      id: ids(),
      kind: 'SUBCONTRACT',
      occurredAt: entry.occurredAt,
      itemId: null,
      quantity: null,
      minutes: null,
      unitCost: entry.unitPrice.toFixed(6),
      standardUnitCost: null,
      standardCostId: null,
      amount: entry.amount,
      stockMoveId: null,
      operationScanId: null,
      subcontractOrderId: order.id,
      supplierInvoiceLineId: null,
      sourceType: 'SubcontractCostEntry',
      sourceId: entry.id,
      reversalOfId: null,
      reason: `Workshop ${costKindWords(entry.kind as CostKind)} of ${order.number}${seq !== undefined ? `, operation ${seq}` : ''}${entry.reversalOfId ? ': taken back' : ''}`,
      idempotencyKey: key,
    })
  }
  return { drafts, waiting }
}
