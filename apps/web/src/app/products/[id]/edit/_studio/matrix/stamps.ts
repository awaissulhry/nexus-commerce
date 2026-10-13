/**
 * Field stamps on the page's writes (2026-10-13, `@nexus/shared/matrix-stamp`): each write carries what its cell SHOWED
 * when the person edited it, so the door can tell "a sale moved this listing's version" from "someone changed this
 * field". The version moves on every sale and cascade; the stamp only when the field does.
 *
 * 🔴 The stamp comes from the PRISTINE read (`MatrixState.savedCellsOf`), never from the grid's cells: the engine's
 * valueSetter writes the typed value into the grid's clone BEFORE the write is built, so a stamp read from the clone would
 * name the new value and every stamped write would be refused.
 *
 * A stamp is taken only from cells read at the version the write expects (and on the listing it expects): any other read
 * is not what the person saw, so the write goes without one and the version alone decides, as before.
 */
import { matrixCellStamp } from '@nexus/shared/matrix-stamp'

import type { MatrixCells, MatrixWriteCell, MatrixWriteOutcome } from './contract'

export function withStamp(cell: MatrixWriteCell, seen: MatrixCells | null | undefined): MatrixWriteCell {
  if (cell.expected || !seen || seen.version !== cell.expectedVersion) return cell
  if (cell.expectedListingId && seen.listingId !== cell.expectedListingId) return cell
  const expected = matrixCellStamp(cell.cell, seen)
  return expected ? { ...cell, expected } : cell
}

/**
 * The page's own moves (#592's re-basing): for every write this page applied, the hop from the version it was checked at
 * to the version it left — so an edit made on the view before that write landed is sent at the version it left, never
 * "changed elsewhere" against the person's own write. The hop starts where the SERVER checked the write: a stamped write
 * that went ahead over a version moved by someone else (`writtenAt`) hops from that fresh version, never from the older one
 * it was sent at — that would carry a later edit over the other change without its check.
 */
export function recordOwnMoves(moves: Map<string, Map<number, number>>, sent: readonly MatrixWriteCell[], outcomes: readonly MatrixWriteOutcome[]): void {
  outcomes.forEach((o, i) => {
    const cell = sent[i]
    if (o.outcome !== 'applied' || !cell?.expectedListingId) return
    const from = o.writtenAt ?? cell.expectedVersion
    if (from === o.version) return
    const hops = moves.get(cell.expectedListingId) ?? new Map<number, number>()
    hops.set(from, o.version)
    moves.set(cell.expectedListingId, hops)
  })
}
