/**
 * ⌘Z / ⌘⇧Z on the Matrix (Owner 2026-10-12: "Ctrl+Z … not working").
 *
 * 🔴 Why not AG's own undo: AG forgets its history at every row-model update (`sheet/sheetUndo.ts`), and the Matrix reads
 * again after every save — so ⌘Z only ever had the second before a save landed. The page keeps the sheet's own history
 * (`SheetUndoHistory`, keyed by row and column, one paste or fill = one step); this file says what a step WRITES.
 *
 * Undo puts a cell back AS IT WAS, not only its number: a quantity that followed the stock follows it again (a typed
 * number would pin it), a price that followed the base price follows it again. These are the server's own revert rules
 * (`restoreWrites`, `apps/api/src/services/pim/matrix-write.service.ts`) for the kinds a cell edit changes. Redo
 * sends the edit again, as typing it would.
 */
import { HISTORY_ONLY } from '../sheet/sheetUndo'
import { matrixBusinessSettingOfCell, matrixCellValue, matrixWrite, MATRIX_UNCHANGED, type CoordinateKey, type MatrixCellKind, type MatrixCells, type MatrixDoorKind, type MatrixWriteCell } from '@/design-system/grid'

/**
 * A Matrix cell's history value — only the history holds it (`HISTORY_ONLY`): the sheet's replay skips it, and the page
 * turns it into writes (`matrixReplay`).
 */
export interface MatrixHistoryValue {
  readonly [HISTORY_ONLY]: true
  readonly kind: 'matrix-cell'
  /** The undo side: the coordinate's cells as the server last read them, BEFORE the edit. */
  readonly before?: MatrixCells | null
  /** The redo side: the value the edit wrote. */
  readonly value?: unknown
}

export const matrixHistoryBefore = (cells: MatrixCells | null): MatrixHistoryValue =>
  Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'matrix-cell' as const, before: cells ? structuredClone(cells) : null })
export const matrixHistoryAfter = (value: unknown): MatrixHistoryValue =>
  Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'matrix-cell' as const, value })
export const isMatrixHistoryValue = (value: unknown): value is MatrixHistoryValue =>
  typeof value === 'object' && value !== null && (value as Partial<MatrixHistoryValue>)[HISTORY_ONLY] === true && (value as Partial<MatrixHistoryValue>).kind === 'matrix-cell'

export const MATRIX_UNDO_COPY = {
  gone: 'This change cannot be put back: the listing on this market is not the one that was changed',
} as const

export type MatrixReplay =
  | { kind: 'write'; cell: MatrixWriteCell }
  | { kind: 'skip' }
  | { kind: 'refuse'; reason: string }

const SKIP: MatrixReplay = { kind: 'skip' }

/**
 * What replaying one history value on `live` (the coordinate's cells as the server reads them NOW) writes. Undo
 * (`entry.before`): the write that takes `live` back to `before`, or skip when it already is. Redo (`entry.value`): the
 * edit again. Pure.
 */
export function matrixReplay(
  kind: MatrixCellKind,
  entry: MatrixHistoryValue,
  live: MatrixCells | null,
  place: { rowId: string; coordinateKey: CoordinateKey },
): MatrixReplay {
  if (!live) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
  /* A business edit wrote the WHOLE setting (the B2B price and its tiers): its redo sends that setting again, as it was
     saved — never only the half its column shows, joined to what the other column holds after the undo. */
  if (!('before' in entry) && (kind === 'businessPrice' || kind === 'businessTiers')) {
    if (!live.business) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
    if (JSON.stringify(entry.value ?? null) === JSON.stringify(matrixBusinessSettingOfCell(live.business))) return SKIP
    return { kind: 'write', cell: { rowId: place.rowId, coordinateKey: place.coordinateKey, cell: kind, value: entry.value ?? null, expectedVersion: live.version } }
  }
  if (!('before' in entry)) {
    const decision = matrixWrite({ kind, coordinateKey: place.coordinateKey, rowId: place.rowId }, live, matrixCellValue(kind, live), entry.value)
    if (decision.send) return { kind: 'write', cell: decision.cell }
    return decision.reason === MATRIX_UNCHANGED ? SKIP : { kind: 'refuse', reason: decision.reason }
  }
  const b = entry.before
  if (!b || b.listingId !== live.listingId) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
  const write = (cell: MatrixDoorKind, value: unknown): MatrixReplay =>
    ({ kind: 'write', cell: { rowId: place.rowId, coordinateKey: place.coordinateKey, cell, value, expectedVersion: live.version } })
  switch (kind) {
    case 'syncQty':
    case 'syncMode': {
      const was = b.sync, now = live.sync
      if (!was || !now || was.kind === 'FBA_EXCLUDED') return SKIP
      if (was.mode === 'PINNED' && (now.mode !== 'PINNED' || now.intended !== was.intended)) return write('syncQty', was.intended ?? was.held ?? 0)
      if (was.mode === 'FOLLOW' && now.mode !== 'FOLLOW') return write('syncMode', 'FOLLOW')
      return SKIP
    }
    case 'syncBuffer':
      return b.sync && live.sync && b.sync.buffer !== live.sync.buffer ? write('syncBuffer', b.sync.buffer) : SKIP
    case 'price': {
      const was = b.price, now = live.price
      /* A formula's price is never a cell edit (the server holds the cell), so there is nothing of it to put back. */
      if (!was || !now || was.source === 'formula') return SKIP
      if (was.source === 'override' && (now.value !== was.value || now.source !== 'override')) return write('price', was.value)
      // `null` = follow the base price again (the price door's own word for it).
      if (was.source === 'master' && now.source === 'override') return write('price', null)
      return SKIP
    }
    case 'salePrice': {
      const was = b.sale, now = live.sale
      if (!was || !now || (was.value === now.value && was.start === now.start && was.end === now.end)) return SKIP
      return write('salePrice', { value: was.value, start: was.start, end: was.end })
    }
    /* Amazon Business: the whole setting as it was (`null` = no business price), through the column's own door kind. */
    case 'businessPrice':
    case 'businessTiers': {
      if (!b.business || !live.business) return SKIP
      const was = matrixBusinessSettingOfCell(b.business)
      return JSON.stringify(was) === JSON.stringify(matrixBusinessSettingOfCell(live.business)) ? SKIP : write(kind, was)
    }
    default:
      return SKIP
  }
}
