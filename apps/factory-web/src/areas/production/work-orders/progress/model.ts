import type { WorkOrder, WorkOrderWip } from '../../_shared/api'
import { percentOf } from '../../_shared/model'

/**
 * F-PR-06 — Operations & WIP without a screen (06-tree A.4 Tab 4, O-WO-ops): ONE operation table — the By operation / By size
 * switch went; each operation row opens to its sizes (the good, waiting, scrap and rework of each colourway × size at that
 * operation, from the floor's scans); the biggest pile is marked (the W2a OperationFlow, a second drawing of the same
 * operations, went into the table). An outsourced operation (a subcontract work centre) is marked. Output per line from the
 * final operation. Per work order, operation, size and line only: never a person or a station (F2).
 */

export interface OperationSize {
  /** The work order's size (cell). */
  readonly id: string
  readonly cell: string
  readonly quantity: number
  readonly good: number
  readonly waiting: number
  readonly scrap: number
  readonly rework: number
}

export interface OperationRow {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly final: boolean
  readonly sewn: boolean
  readonly unplanned: boolean
  readonly scanned: boolean
  /** At a workshop (a SUBCONTRACT work centre): its figures are the scans of what came back. */
  readonly outsourced: boolean
  /** The frozen routing's standard minutes (null: an operation the routing does not hold). */
  readonly minutes: string | null
  readonly arrived: number
  readonly waiting: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
  /** The biggest pile waiting before an operation of the routing (more than 0; design wo-flow, the W2a OperationFlow's mark). */
  readonly bottleneck: boolean
  readonly bundles: { readonly done: number; readonly waiting: number; readonly notReached: number }
  /** Good garments of all the work order's pieces, %. */
  readonly progress: number | null
  /** Per size, in the work order's order; empty where the operation is not scanned (nothing is counted per size). */
  readonly sizes: readonly OperationSize[]
}

/** The operation table's rows: the WIP's operations in their order, each with its sizes. */
export function operationRows(workOrder: Pick<WorkOrder, 'spec' | 'pieces'>, wip: Pick<WorkOrderWip, 'operations' | 'cells'>): OperationRow[] {
  const minutes = new Map(workOrder.spec.operations.map((op) => [op.seq, op.standardMinutes]))
  // B-W2b-82: nothing waits for an unplanned operation; the pile is the routing's.
  const most = Math.max(0, ...wip.operations.filter((op) => !op.unplanned).map((op) => op.waiting))
  return wip.operations.map((op) => ({
    id: op.operationId,
    seq: op.seq,
    code: op.code,
    name: op.name,
    kind: op.workCentreKind,
    final: op.final,
    sewn: op.sewn,
    unplanned: !!op.unplanned,
    scanned: op.scanRequired,
    outsourced: op.workCentreKind === 'SUBCONTRACT',
    minutes: minutes.get(op.seq) ?? null,
    arrived: op.arrived,
    waiting: op.waiting,
    good: op.good,
    scrap: op.scrap,
    rework: op.rework,
    bottleneck: !op.unplanned && most > 0 && op.waiting === most,
    bundles: op.bundles,
    progress: percentOf(op.good, workOrder.pieces),
    sizes: wip.cells.flatMap((cell) => {
      const at = op.cells.find((entry) => entry.workOrderSizeId === cell.workOrderSizeId)
      return at ? [{ id: cell.workOrderSizeId, cell: `${cell.colourwayCode} ${cell.size}`, quantity: cell.quantity, good: at.good, waiting: at.waiting, scrap: at.scrap, rework: at.rework }] : []
    }),
  }))
}

/** Finished per line: the final operation's good garments summed per line (the line of the reporting station; never a station). */
export function linesOutput(wip: Pick<WorkOrderWip, 'operations'>): Array<{ id: string; code: string; name: string; good: number }> {
  const lines = new Map<string, { id: string; code: string; name: string; good: number }>()
  for (const op of wip.operations.filter((entry) => entry.final)) for (const line of op.lines) lines.set(line.lineId, { id: line.lineId, code: line.code, name: line.name, good: (lines.get(line.lineId)?.good ?? 0) + line.good })
  return [...lines.values()]
}
