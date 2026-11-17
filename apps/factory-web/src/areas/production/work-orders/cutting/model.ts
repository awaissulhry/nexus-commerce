import type { CutLog, WorkOrderBundles } from '../../_shared/api'
import type { Replacement } from '../../cutting/api'
import { piecesMatrix } from '../../cutting/model'
import type { CutOrderSummary, CutOrderView } from '../../cutting/orders/api'

/**
 * F-PR-06 — the work order's "Cutting & bundles" tab without a screen (06-tree A.4 Tab 3; 06-sections O-WO-cut-cells,
 * O-WO-cut-lays, O-WO-cut-bundles, O-CUT-rec): Cutting and Bundles are one tab, and the Cut record (`/production/cutting/<id>`,
 * the same work order) is merged into it. ONE table per size × colour (Planned · Cut · Bundled · Short, its parts under each
 * cell) replaces the cut-vs-plan grid and the bundles' per-cell card; the cut orders of this work order (its fabric lays) say
 * when they are shared with another work order, naming only what the API named for this reader (PW-03). Per work order only.
 */

// ---- ONE table: cut and bundled per size × colour (O-WO-cut-cells) ------------------------------------------------------------

export interface CutCellPart {
  readonly part: string
  /** A part the BOM names (else a part logged by another name: its pieces are said, no plan). */
  readonly planned: boolean
  readonly plannedPieces: number
  readonly cut: number
  /** Pieces of the part still to cut against the plan (never below 0). */
  readonly short: number
  /** Recuts asked for scrapped pieces of this part and not cut yet (a whole-garment recut counts one piece of every part). */
  readonly recut: number
}

export interface CutCellRow {
  /** The work order's size (cell). */
  readonly id: string
  readonly colourwayCode: string
  readonly size: string
  readonly planned: number
  /** Garments cut; null where the cut is not counted (or the cut log was not read): "—", never 0. */
  readonly cut: number | null
  /** Garments in live bundles; null when the bundles were not read. */
  readonly bundled: number | null
  /** Cut garments not in a bundle yet; null when the bundles were not read. */
  readonly toBundle: number | null
  /** Garments still to cut (the API's figure); null where the cut is not counted. */
  readonly short: number | null
  readonly parts: readonly CutCellPart[]
}

const counted = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null)
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
}

/**
 * The cells of the work order once: from the cut log (planned, cut, the API's still to cut, the pieces per part with the open
 * recuts) and the bundles (in bundles, still to bundle) joined by the size. One of the two not read: its columns are "—"; a cell
 * only one read names is still drawn (never dropped). The order is the cut log's (the work order's), else the bundles'.
 */
export function cutCellsOf(log: Pick<CutLog, 'cells'> | null, bundles: Pick<WorkOrderBundles, 'cells'> | null, recuts: readonly Replacement[] = []): CutCellRow[] {
  const bundled = new Map((bundles?.cells ?? []).map((cell) => [cell.workOrderSizeId, cell]))
  const matrix = log ? piecesMatrix(log, recuts) : []
  const rows: CutCellRow[] = (log?.cells ?? []).map((cell, index) => {
    const pack = bundled.get(cell.id) ?? null
    return {
      id: cell.id,
      colourwayCode: cell.colourwayCode,
      size: cell.size,
      planned: cell.quantity,
      cut: cell.cut,
      bundled: bundles ? (pack?.bundled ?? 0) : null,
      toBundle: bundles ? (pack?.toBundle ?? 0) : null,
      short: cell.toCut,
      // A part with nothing planned, cut or asked again in this cell says nothing (a cell not cut yet logs no part).
      parts: matrix
        .map((row) => {
          const at = row.cells[index]!
          return { part: row.part, planned: row.planned, plannedPieces: at.planned, cut: at.cut, short: at.short, recut: at.recut }
        })
        .filter((part) => part.plannedPieces > 0 || part.cut > 0 || part.recut > 0),
    }
  })
  const known = new Set(rows.map((row) => row.id))
  for (const cell of bundles?.cells ?? []) {
    if (known.has(cell.workOrderSizeId)) continue
    rows.push({
      id: cell.workOrderSizeId,
      colourwayCode: cell.colourwayCode,
      size: cell.size,
      planned: cell.quantity,
      cut: cell.cut,
      bundled: cell.bundled,
      toBundle: cell.toBundle,
      short: cell.cut === null ? null : Math.max(0, cell.quantity - cell.cut),
      parts: [],
    })
  }
  return rows
}

/** The table's Total row: each column summed over the cells that count it (null: no cell counts it). */
export function cutCellsTotal(rows: readonly CutCellRow[]): { planned: number; cut: number | null; bundled: number | null; toBundle: number | null; short: number | null } {
  return {
    planned: rows.reduce((sum, row) => sum + row.planned, 0),
    cut: counted(rows.map((row) => row.cut)),
    bundled: counted(rows.map((row) => row.bundled)),
    toBundle: counted(rows.map((row) => row.toBundle)),
    short: counted(rows.map((row) => row.short)),
  }
}

/** A part's words under its cell: cut of planned with what is short and what waits for a recut (a part not in the plan: its pieces). */
export function partPhrases(part: CutCellPart): Array<{ key: string; params: Record<string, string | number> }> {
  const out: Array<{ key: string; params: Record<string, string | number> }> = [part.planned ? { key: 'cutting.cells.part', params: { part: part.part, cut: part.cut, planned: part.plannedPieces } } : { key: 'cutting.cells.partExtra', params: { part: part.part, cut: part.cut } }]
  if (part.short > 0) out.push({ key: 'cutting.cells.partShort', params: { count: part.short } })
  if (part.recut > 0) out.push({ key: 'cutting.cells.partRecut', params: { count: part.recut } })
  return out
}

/**
 * The tab's count: the bundles live on the floor (ACTIVE). The cut log is a history (every entry stays, a correction adds one),
 * so a sum of entries and bundles would name no figure; the live bundles are what the tab's work is about once cutting starts.
 */
export function cuttingTabCount(bundles: Pick<WorkOrderBundles, 'bundles'> | null): number | null {
  return bundles ? bundles.bundles.filter((bundle) => bundle.status === 'ACTIVE').length : null
}

// ---- the cut orders of this work order: its fabric lays (O-WO-cut-lays) -------------------------------------------------------

/** The cut orders read for the tab: every state, found by this work order's number (the API matches its own scope only). */
export const cutOrdersQuery = (number: string): { view: CutOrderView; q: string; limit: number } => ({ view: 'all', q: number, limit: 50 })

export interface CutOrderOfWorkOrder {
  readonly order: CutOrderSummary
  /**
   * The other work orders the cut order cuts for, exactly as the API listed them for this reader (a reader limited to some
   * customers is never sent another customer's work order): never more, never a customer's name.
   */
  readonly others: ReadonlyArray<{ readonly id: string; readonly number: string }>
}

/**
 * PW-03 (web side): a number search may find cut orders that do not cut for this work order (another number containing it);
 * only those that name this work order's id are kept, each with the other work orders it shares the lays with.
 */
export function cutOrdersOf(rows: readonly CutOrderSummary[], workOrderId: string): CutOrderOfWorkOrder[] {
  return rows.filter((row) => row.workOrders.some((entry) => entry.id === workOrderId)).map((order) => ({ order, others: order.workOrders.filter((entry) => entry.id !== workOrderId) }))
}
