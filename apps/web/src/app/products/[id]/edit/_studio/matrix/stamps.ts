/**
 * Field stamps on the page's writes (2026-10-13, `@nexus/shared/matrix-stamp`): each write carries what its cell SHOWED
 * when the person edited it, so the door can tell "a sale moved this listing's version" from "someone changed this
 * field". The version moves on every sale and cascade; the stamp only when the field does.
 *
 * 🔴 The stamp comes from the PRISTINE read (`MatrixState.savedCellsOf`), never from the grid's cells: the engine's
 * valueSetter writes the typed value into the grid's clone BEFORE the write is built, so a stamp read from the clone would
 * name the new value and every stamped write would be refused.
 *
 * 🔴 The stamp, the version and the LISTING come from ONE read. A typed cell is built without a listing
 * (`matrixWrite`); `withStamp` names the listing of the read it stamped from, so a write is never sent to another listing
 * that took the coordinate since (an alias that became the main listing, a delete and re-create) with a stamp that
 * happens to hold there too — the door refuses another listing than the one named.
 */
import { roundCents } from '@nexus/shared/listing-price'
import { matrixCellStamp } from '@nexus/shared/matrix-stamp'

import type { MatrixCells, MatrixCellStamp, MatrixDoorKind, MatrixRead, MatrixWriteCell, MatrixWriteOutcome } from './contract'

/**
 * The write, stamped with what `seen` showed and pinned to `seen`'s listing — only when `seen` is the read the write's
 * version came from (and the listing it names, when it names one). Any other read is not what the person saw: the write
 * goes as it is, and the version alone decides.
 */
export function withStamp(cell: MatrixWriteCell, seen: MatrixCells | null | undefined): MatrixWriteCell {
  if (!seen || seen.version !== cell.expectedVersion) return cell
  if (cell.expectedListingId && seen.listingId !== cell.expectedListingId) return cell
  const pinned = !cell.expectedListingId && seen.listingId ? { ...cell, expectedListingId: seen.listingId } : cell
  if (pinned.expected) return pinned
  const expected = matrixCellStamp(cell.cell, seen)
  return expected ? { ...pinned, expected } : pinned
}

/* ── the page's own moves (#592's re-basing) ──────────────────────────────────────────────────── */

/** One move of a listing by this page: the version it left, and every cell it wrote there (in order). */
export interface OwnMove { to: number; wrote: Array<{ cell: MatrixDoorKind; value: unknown }> }
/** listing → the version a move started from → the move. */
export type OwnMoves = Map<string, Map<number, OwnMove>>

/** The field a kind's stamp names — two kinds share one when a write of either changes the other's stamp. */
const FIELD_OF: Readonly<Record<MatrixDoorKind, string>> = {
  syncMode: 'mode', syncQty: 'mode', syncBuffer: 'buffer', price: 'price', salePrice: 'sale',
  businessPrice: 'business', businessTiers: 'business', source: 'source', fulfilment: 'fulfilment',
}

/**
 * For every write this page applied: the move from the version the SERVER checked it at to the version it left, with
 * what it wrote. A stamped write that went ahead over a version moved by someone else (`writtenAt`) moves from that
 * fresh version, never from the older one it was sent at — that would carry a later edit over the other change unchecked.
 */
export function recordOwnMoves(moves: OwnMoves, sent: readonly MatrixWriteCell[], outcomes: readonly MatrixWriteOutcome[]): void {
  outcomes.forEach((o, i) => {
    const cell = sent[i]
    if (o.outcome !== 'applied' || !cell?.expectedListingId) return
    const from = o.writtenAt ?? cell.expectedVersion
    if (from === o.version) return
    const hops = moves.get(cell.expectedListingId) ?? new Map<number, OwnMove>()
    const hop = hops.get(from)
    hops.set(from, { to: Math.max(hop?.to ?? o.version, o.version), wrote: [...(hop?.wrote ?? []), { cell: cell.cell, value: cell.value }] })
    moves.set(cell.expectedListingId, hops)
  })
}

/** The stamp a cell of `kind` has right after this page wrote `w` (same field), or undefined when the page cannot know it. */
export function stampAfterOwnWrite(kind: MatrixDoorKind, w: { cell: MatrixDoorKind; value: unknown }): MatrixCellStamp | undefined {
  const v = w.value
  switch (FIELD_OF[kind]) {
    case 'mode':
      if (w.cell === 'syncQty' && typeof v === 'number') return kind === 'syncQty' ? { mode: 'PINNED', qty: v } : { mode: 'PINNED' }
      if (w.cell === 'syncMode' && v === 'FOLLOW') return { mode: 'FOLLOW' }
      // Pinned from the Mode cell pins the number the listing showed then: the page does not know it.
      if (w.cell === 'syncMode' && v === 'PINNED') return kind === 'syncMode' ? { mode: 'PINNED' } : undefined
      return undefined
    case 'buffer':
      return typeof v === 'number' ? { buffer: v } : undefined
    case 'price':
      return v === null ? { own: null } : typeof v === 'number' ? { own: roundCents(v) } : undefined
    case 'sale': {
      const s = v as { value?: number | null; start?: string | null; end?: string | null } | null
      return { sale: { value: s?.value ?? null, start: s?.start ?? null, end: s?.end ?? null } }
    }
    case 'business': {
      if (v === null) return { business: null }
      const s = v as { rule?: unknown; percent?: number | null; price?: number | null; tiers?: { type: 'percent' | 'fixed'; levels: Array<{ minQty: number; value: number }> } | null } | null
      if (!s || (s.rule !== 'PERCENT_OFF' && s.rule !== 'FIXED')) return undefined
      return {
        business: {
          rule: s.rule,
          percent: s.rule === 'PERCENT_OFF' ? s.percent ?? null : null,
          exact: s.rule === 'FIXED' ? s.price ?? null : null,
          tiers: s.tiers ? { type: s.tiers.type, levels: s.tiers.levels.map((l) => ({ minQty: l.minQty, value: l.value })) } : null,
        },
      }
    }
    // "Sells from" and Fulfilment are stored in a form the page cannot work out (a market-default list, a derived method).
    default:
      return undefined
  }
}

/**
 * A cell edited on the view BEFORE an earlier write of this page landed is sent at the version that write left — never
 * "changed elsewhere" against the person's own write. When those writes changed the cell's OWN field, the stamp it was
 * taken with (the value from before them) is no longer what the cell holds: it is taken again — from the read at that
 * version when the page already has it, else from what the page itself wrote — or dropped when the page cannot know it
 * (the version alone decides). It is never kept: a restore by someone else to that older value would pass it.
 */
export function rebaseOnOwnMoves(cell: MatrixWriteCell, moves: OwnMoves, now: MatrixRead | null): MatrixWriteCell {
  const hops = cell.expectedListingId ? moves.get(cell.expectedListingId) : undefined
  let version = cell.expectedVersion
  const wrote: OwnMove['wrote'] = []
  for (let n = 0; hops?.has(version) && n < 1000; n++) {
    const hop = hops.get(version)!
    wrote.push(...hop.wrote)
    version = hop.to
  }
  if (version === cell.expectedVersion) return cell
  const moved: MatrixWriteCell = { ...cell, expectedVersion: version }
  const mine = wrote.filter((w) => FIELD_OF[w.cell] === FIELD_OF[cell.cell])
  if (!cell.expected || mine.length === 0) return moved
  const atNow = now?.rows.find((r) => r.id === cell.rowId)?.cells[cell.coordinateKey]
  const expected = atNow && atNow.version === version && atNow.listingId === cell.expectedListingId
    ? matrixCellStamp(cell.cell, atNow)
    : stampAfterOwnWrite(cell.cell, mine[mine.length - 1]!)
  if (expected) return { ...moved, expected }
  const { expected: _taken, ...unstamped } = moved
  return unstamped
}
