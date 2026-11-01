import type { Issue } from '../../core/errors'
import { MAX_CELL_PIECES, MAX_CELLS } from './cells'
import type { WorkOrderKind, WorkOrderStatus } from './machine'

/**
 * Split a work order (B-W2b-51; MES-010 "Split a work order"; design production.workorders pop wo-split "sizes or
 * quantity to move into a child work order with its own due date; genealogy kept"), pure. apps/factory-api's
 * modules/production/work-orders split.ts makes it in ONE command.
 *
 *   what      a DRAFT size-grid work order gives some of its cells, whole or in part, to a NEW draft work order of the
 *             same style, site, revision and kind, which names it (WorkOrder.splitFromId: set when it is made, never
 *             changed — the genealogy). The order lines' pieces are the same afterwards, only on two work orders: nothing
 *             is made twice or lost.
 *   when      only a DRAFT: the database freezes a work order's cells at its release (MES-005; the WorkOrderSize guard
 *             refuses any change after DRAFT), so a released, started or held work order keeps them. A repair (one
 *             garment of a repair order) and a made-to-measure unit (one piece) have nothing to split.
 *   cells     each asked cell of the work order once, from 1 piece to all its pieces; at least one piece moves and at
 *             least one stays.
 *   child     its own due date (default the parent's), priority, rush flag (default the parent's) and note; on no line
 *             yet (the planner allocates it). Its materials are planned from its cells like any draft's, and the parent's
 *             drafted materials go (the release plans them again from the cells it keeps). Stock reserved for the parent,
 *             its kit and its operations on the planning board stay with the parent.
 */

/** The statuses a work order is split in. */
export const SPLITTABLE: readonly WorkOrderStatus[] = Object.freeze(['DRAFT'])

/** The work order to split, as the rules read it. */
export interface SplitParent {
  readonly number: string
  readonly status: WorkOrderStatus
  readonly kind: WorkOrderKind
}

/** Why this work order is not split at all, in words (the API's 409), or null. */
export function splitRefusal(parent: SplitParent): string | null {
  if (parent.kind === 'REPAIR') return `Work order ${parent.number} repairs one garment of its repair order: there is nothing to split.`
  if (parent.kind === 'MADE_TO_MEASURE') return `Work order ${parent.number} makes one made-to-measure unit: there is nothing to split.`
  if (!SPLITTABLE.includes(parent.status)) {
    return `Work order ${parent.number} is ${parent.status}; its sizes were frozen at its release (MES-005), so only a DRAFT is split. Make a new work order for what is still open on the order lines instead.`
  }
  return null
}

/** One cell of the work order, as the rules read it. */
export interface SplitCell {
  readonly id: string
  /** `BLK 52`: the colourway's code and the size. */
  readonly label: string
  readonly quantity: number
}

/** One cell to move: how many of its pieces go to the new work order. */
export interface SplitAsk {
  readonly cellId: string
  readonly quantity: number
}

/** The problems of an ask, one per path (`body/cells/<i>`): an unknown or repeated cell, a quantity out of range, nothing moved or nothing left. */
export function splitProblems(cells: readonly SplitCell[], asked: readonly SplitAsk[], path = 'body/cells'): Issue[] {
  const problems: Issue[] = []
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  const seen = new Set<string>()
  if (asked.length === 0) problems.push({ path, message: 'Choose at least one size to move.' })
  if (asked.length > MAX_CELLS) problems.push({ path, message: `Move up to ${MAX_CELLS} cells at once.` })
  asked.forEach((ask, index) => {
    const at = `${path}/${index}`
    const cell = byId.get(ask.cellId)
    if (!cell) {
      problems.push({ path: `${at}/cellId`, message: 'Not a cell of this work order.' })
      return
    }
    if (seen.has(cell.id)) problems.push({ path: `${at}/cellId`, message: `${cell.label} is named twice.` })
    seen.add(cell.id)
    if (!Number.isInteger(ask.quantity) || ask.quantity < 1 || ask.quantity > MAX_CELL_PIECES) problems.push({ path: `${at}/quantity`, message: 'Move at least one piece.' })
    else if (ask.quantity > cell.quantity) problems.push({ path: `${at}/quantity`, message: `${cell.label} has ${cell.quantity} piece(s): move at most ${cell.quantity}.` })
  })
  if (problems.length > 0) return problems
  const moved = asked.reduce((sum, ask) => sum + ask.quantity, 0)
  const total = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  if (moved >= total) problems.push({ path, message: 'Keep at least one piece on this work order: moving everything is not a split (change the due date, priority or rush flag instead).' })
  return problems
}

/** What the split does to the cells: what each parent cell keeps (or that it goes), and what the new work order gets. */
export interface SplitPlan {
  /** Parent cells that keep part of their pieces: their new quantity. */
  readonly keep: readonly { readonly cellId: string; readonly quantity: number }[]
  /** Parent cells that move whole: they go from the parent. */
  readonly remove: readonly string[]
  /** The new work order's cells: from which parent cell, how many pieces. */
  readonly move: readonly { readonly fromCellId: string; readonly quantity: number }[]
  /** Pieces that move, and pieces that stay on the parent. */
  readonly moved: number
  readonly kept: number
}

/** The plan of an ask with no problems (splitProblems first). */
export function splitPlan(cells: readonly SplitCell[], asked: readonly SplitAsk[]): SplitPlan {
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  const keep: { cellId: string; quantity: number }[] = []
  const remove: string[] = []
  const move: { fromCellId: string; quantity: number }[] = []
  for (const ask of asked) {
    const cell = byId.get(ask.cellId)!
    move.push({ fromCellId: cell.id, quantity: ask.quantity })
    if (ask.quantity === cell.quantity) remove.push(cell.id)
    else keep.push({ cellId: cell.id, quantity: cell.quantity - ask.quantity })
  }
  const moved = move.reduce((sum, entry) => sum + entry.quantity, 0)
  const total = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  return { keep, remove, move, moved, kept: total - moved }
}
