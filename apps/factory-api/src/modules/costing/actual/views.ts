import type { EntryEvent, LedgerEntryView } from '@nexus/factory-domain/costing/ledger/contracts'
import { isProvisional, type CostingMethod, type CostEntryKind } from '@nexus/factory-domain/costing/ledger/entries'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { romeDay, textOrNull, unique, type Reader } from './store'

/**
 * The cost ledger's rows as the screens read them (design finance.costing "Cost ledger": date, event, document,
 * quantity, value, reversal of): every figure money.cost, the source in words (a stock move by its reference or lot, a
 * scan by its bundle and operation, a rework, the entry an overhead was applied on), who reversed it never named (the
 * audit trail keeps people). Reads only.
 */

/** An entry row of any shape that carries the ledger's columns (a stored row, or a draft just posted). */
export interface LedgerRowFacts {
  readonly id: string
  readonly workOrderId: string
  readonly kind: CostEntryKind
  readonly occurredAt: Date
  readonly itemId: string | null
  readonly quantity: { toString(): string } | null
  readonly minutes: { toString(): string } | null
  readonly unitCost: { toString(): string } | null
  readonly standardUnitCost: { toString(): string } | null
  readonly amount: number
  readonly currency: string
  readonly costingMethod: CostingMethod
  readonly standardCostId: string | null
  readonly stockMoveId: string | null
  readonly operationScanId: string | null
  readonly subcontractOrderId: string | null
  readonly supplierInvoiceLineId: string | null
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly reversalOfId: string | null
  readonly reason: string | null
  readonly createdAt: Date
}

/** What the entry records, in the ledger's words. */
export function eventOf(row: Pick<LedgerRowFacts, 'kind' | 'quantity' | 'stockMoveId' | 'sourceType' | 'reversalOfId'>): EntryEvent {
  if (row.reversalOfId) return 'REVERSAL'
  switch (row.kind) {
    case 'MATERIAL':
      return row.quantity !== null && decimalOf(row.quantity.toString()).isNegative() ? 'RETURN' : 'ISSUE'
    case 'SCRAP':
      return row.stockMoveId ? 'STOCK_SCRAP' : row.sourceType === 'ReworkOrder' ? 'REWORK_SCRAP' : 'SCAN_SCRAP'
    default:
      return row.kind
  }
}

export async function ledgerViews(db: Reader, rows: readonly LedgerRowFacts[]): Promise<LedgerEntryView[]> {
  if (rows.length === 0) return []
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(rows.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const moves = new Map(
    (await db.stockMove.findMany({ where: { id: { in: unique(rows.map((row) => row.stockMoveId)) } }, select: { id: true, reason: true, reference: true, lotId: true, hideId: true } })).map((row) => [row.id, row]),
  )
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique([...moves.values()].map((move) => move.lotId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique([...moves.values()].map((move) => move.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const scans = new Map(
    (await db.operationScan.findMany({ where: { id: { in: unique(rows.map((row) => row.operationScanId)) } }, select: { id: true, kind: true, bundleId: true, workOrderOperationId: true } })).map((row) => [row.id, row]),
  )
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique([...scans.values()].map((scan) => scan.bundleId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const operations = new Map(
    (await db.workOrderOperation.findMany({ where: { id: { in: unique([...scans.values()].map((scan) => scan.workOrderOperationId)) } }, select: { id: true, seq: true, code: true } })).map((row) => [row.id, row]),
  )
  const subcontracts = new Map((await db.subcontractOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.subcontractOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const reversals = new Map(
    (await db.workOrderCostEntry.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { id: true, reversalOfId: true, occurredAt: true, reason: true } })).map((row) => [row.reversalOfId!, row]),
  )

  const documentOf = (row: LedgerRowFacts): LedgerEntryView['document'] => {
    if (row.sourceType === 'ReworkOrder' && row.sourceId) return { type: 'ReworkOrder', id: row.sourceId, label: 'Rework' }
    if (row.stockMoveId) {
      const move = moves.get(row.stockMoveId)
      const where = [move?.hideId ? hides.get(move.hideId) : null, move?.lotId ? lots.get(move.lotId) : null].filter(Boolean).join(' · ')
      return { type: 'StockMove', id: row.stockMoveId, label: [move?.reason ?? 'Move', move?.reference, where].filter(Boolean).join(' · ') }
    }
    if (row.operationScanId) {
      const scan = scans.get(row.operationScanId)
      const operation = scan ? operations.get(scan.workOrderOperationId) : undefined
      return { type: 'OperationScan', id: row.operationScanId, label: [scan ? bundles.get(scan.bundleId) : null, operation ? `${operation.seq} ${operation.code}` : null, scan && scan.kind !== 'REPORT' ? scan.kind : null].filter(Boolean).join(' · ') }
    }
    if (row.subcontractOrderId) return { type: 'SubcontractOrder', id: row.subcontractOrderId, label: subcontracts.get(row.subcontractOrderId) ?? 'Subcontract order' }
    if (row.supplierInvoiceLineId) return { type: 'SupplierInvoiceLine', id: row.supplierInvoiceLineId, label: 'Supplier invoice line' }
    if (row.sourceType === 'WorkOrderCostEntry' && row.sourceId) return { type: 'WorkOrderCostEntry', id: row.sourceId, label: 'Applied on an entry' }
    // A reversal by hand names the entry it takes back.
    if (row.reversalOfId) return { type: 'WorkOrderCostEntry', id: row.reversalOfId, label: 'Reverses an entry' }
    return null
  }

  return rows.map((row) => {
    const item = row.itemId ? items.get(row.itemId) : undefined
    const reversal = reversals.get(row.id)
    return {
      id: row.id,
      workOrder: { id: row.workOrderId, number: orders.get(row.workOrderId) ?? '' },
      kind: row.kind,
      event: eventOf(row),
      occurredAt: toUtcIso(row.occurredAt),
      day: romeDay(row.occurredAt),
      item: item ? { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom } : null,
      quantity: textOrNull(row.quantity),
      minutes: textOrNull(row.minutes),
      unitCost: asMoney('cost', textOrNull(row.unitCost)),
      standardUnitCost: asMoney('cost', textOrNull(row.standardUnitCost)),
      amount: asMoney('cost', row.amount),
      currency: row.currency,
      method: row.costingMethod,
      provisional: isProvisional(row.costingMethod),
      standardId: row.standardCostId,
      document: documentOf(row),
      reversalOfId: row.reversalOfId,
      reversedBy: reversal ? { id: reversal.id, occurredAt: toUtcIso(reversal.occurredAt), reason: reversal.reason } : null,
      reason: row.reason,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}
