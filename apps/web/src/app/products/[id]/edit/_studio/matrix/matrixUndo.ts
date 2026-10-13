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
 *
 * 2026-10-13 (one save line): an undo puts a cell back only while it still holds what the edit wrote — a newer value, the
 * person's own or anyone else's, stays (`matrixStillHolds`). A pop-up's toast Undo (B2B price, Sells from) is the SAME
 * ⌘Z step (`SheetUndoHistory.undoStep`), so there is one way back, never two.
 */
import { matrixCellStamp, matrixStampHolds } from '@nexus/shared/matrix-stamp'
import { HISTORY_ONLY } from '../sheet/sheetUndo'
import { matrixBusinessSettingOfCell, matrixCellValue, matrixWrite, MATRIX_UNCHANGED, type CoordinateKey, type MatrixCellKind, type MatrixCells, type MatrixDoorKind, type MatrixWriteCell } from '@/design-system/grid'
import { MATRIX_COPY, type MatrixWriteOutcome } from './contract'
import { sameSourceCodes } from './preview'
import { fromGroupKey, isMatrixFromColId, matrixFromColId } from './sellsFrom'
import { stampAfterOwnWrite } from './stamps'

/**
 * A Matrix cell's history value — only the history holds it (`HISTORY_ONLY`): the sheet's replay skips it, and the page
 * turns it into writes (`matrixReplay`).
 */
export interface MatrixHistoryValue {
  readonly [HISTORY_ONLY]: true
  readonly kind: 'matrix-cell'
  /** The undo side: the coordinate's cells as the server last read them, BEFORE the edit. */
  readonly before?: MatrixCells | null
  /** The undo side: what the edit wrote — an undo puts the cell back only while it still holds it (`matrixStillHolds`). */
  readonly written?: unknown
  /** The redo side: the value the edit wrote. */
  readonly value?: unknown
}

/** The undo side of an edit: the cells before it, and — when given — what it wrote (`after`, its redo side). */
export const matrixHistoryBefore = (cells: MatrixCells | null, after?: MatrixHistoryValue): MatrixHistoryValue =>
  Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'matrix-cell' as const, before: cells ? structuredClone(cells) : null, ...(after && 'value' in after ? { written: after.value } : {}) })
export const matrixHistoryAfter = (value: unknown): MatrixHistoryValue =>
  Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'matrix-cell' as const, value })
export const isMatrixHistoryValue = (value: unknown): value is MatrixHistoryValue =>
  typeof value === 'object' && value !== null && (value as Partial<MatrixHistoryValue>)[HISTORY_ONLY] === true && (value as Partial<MatrixHistoryValue>).kind === 'matrix-cell'

export const MATRIX_UNDO_COPY = {
  gone: 'This change cannot be put back: the listing on this market is not the one that was changed',
  /** A toast's Undo whose ⌘Z step is gone: ⌘Z took it already, or the change was not saved. */
  done: 'Nothing to put back: this change was undone already',
  /**
   * A clamped price shows its floor or ceiling, not the listing's own price: the page cannot tell whether someone set
   * another price since, so an undo never writes over it blind.
   */
  clamped: 'Not put back: this price is held at its floor or ceiling, so Nexus cannot tell whether it changed since. Set it in the cell',
  /**
   * The B2B price before the change was set at Amazon and is not kept in Nexus: putting it "back" would remove the
   * business offer at Amazon. The pop-up's toast offers no Undo then; ⌘Z refuses the same way.
   */
  amazonOwn: 'Not put back: the business price before this change was set at Amazon, outside Nexus. Nexus never removes it to undo — set it in the B2B price pop-up',
} as const

/** A kind the Matrix's history holds: a Matrix cell's, or a market's "Sells from" (the From column, `source`). */
export type MatrixHistoryKind = MatrixCellKind | 'source'

/** The history's place of a column: a Matrix cell (`<key>.<kind>`) or a From column (`<key>.from` → `source`). */
export function matrixHistoryPlace(colId: string): { key: CoordinateKey; kind: MatrixHistoryKind } | null {
  if (isMatrixFromColId(colId)) return { key: fromGroupKey(colId), kind: 'source' }
  const i = colId.lastIndexOf('.')
  if (i <= 0) return null
  const key = colId.slice(0, i)
  const kind = colId.slice(i + 1)
  return key !== 'shared' && ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'price', 'salePrice', 'businessPrice', 'businessTiers'].includes(kind) ? { key, kind: kind as MatrixCellKind } : null
}
/** The history column of a write (a "Sells from" write is its group's From column). */
export const matrixHistoryColId = (key: CoordinateKey, cell: MatrixDoorKind): string => (cell === 'source' ? matrixFromColId(key) : `${key}.${cell}`)

const isoDay = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '')

/**
 * Does `live` still hold what a change wrote there (`written`, the value its write sent)? An undo puts a cell back only
 * then (2026-10-13, one save line): a newer value — the person's own later edit, or anyone else's — is never written over;
 * the cell says `MATRIX_COPY.changedSince`. `null` = the page cannot tell (a clamped or formula price, a value it cannot read
 * back the same way): the version decides, as before.
 */
export function matrixStillHolds(kind: MatrixHistoryKind, written: unknown, live: MatrixCells | null): boolean | null {
  if (!live) return null
  if (kind === 'salePrice') {
    // The dates as days: the read spells them as full times, a write may send the day.
    const w = (written ?? null) as { value?: number | null; start?: string | null; end?: string | null } | null
    if (!live.sale) return null
    return (w?.value ?? null) === live.sale.value && isoDay(w?.start) === isoDay(live.sale.start) && isoDay(w?.end) === isoDay(live.sale.end)
  }
  if (kind === 'source') return live.source && Array.isArray(written) ? sameSourceCodes(written as string[], live.source.own) : null
  if (kind === 'listing' || kind === 'syncState') return null
  /* A clamped price shows the floor or ceiling, not the listing's own price: the price's SOURCE still says whether it is
     the listing's own or the base price's. Back to the base price (null) is read from it; an own number cannot be. */
  if (kind === 'price' && live.price?.clamped) {
    if (written === null) return live.price.source === 'master'
    return live.price.source === 'override' ? null : false
  }
  const expected = stampAfterOwnWrite(kind, { cell: kind, value: written })
  if (!expected || matrixCellStamp(kind, live) === undefined) return null
  return matrixStampHolds(kind, expected, live)
}

export type MatrixReplay =
  | { kind: 'write'; cell: MatrixWriteCell }
  | { kind: 'skip' }
  | { kind: 'refuse'; reason: string }

const SKIP: MatrixReplay = { kind: 'skip' }

/**
 * What replaying one history value on `live` (the coordinate's cells as the server reads them NOW) writes. Undo
 * (`entry.before`): the write that takes `live` back to `before`, or skip when it already is — refused with
 * `MATRIX_COPY.changedSince` when the cell no longer holds what the edit wrote (`entry.written`): a newer value stays. Redo
 * (`entry.value`): the edit again. Pure.
 */
export function matrixReplay(
  kind: MatrixHistoryKind,
  entry: MatrixHistoryValue,
  live: MatrixCells | null,
  place: { rowId: string; coordinateKey: CoordinateKey },
): MatrixReplay {
  const step = replayStep(kind, entry, live, place)
  if (step.kind !== 'write' || !('before' in entry)) return step
  /* Undo: a cell is put back only while it still holds what the edit wrote (a newer value stays). */
  if ('written' in entry) {
    const holds = matrixStillHolds(kind, entry.written, live)
    if (holds === false) return { kind: 'refuse', reason: MATRIX_COPY.changedSince }
    // A clamped own price cannot be read back: never a blind write over it.
    if (holds === null && kind === 'price' && live?.price?.clamped) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.clamped }
  } else if (kind === 'price' && live?.price?.clamped && live.price.source === 'override') {
    return { kind: 'refuse', reason: MATRIX_UNDO_COPY.clamped }
  }
  return step
}

function replayStep(
  kind: MatrixHistoryKind,
  entry: MatrixHistoryValue,
  live: MatrixCells | null,
  place: { rowId: string; coordinateKey: CoordinateKey },
): MatrixReplay {
  if (!live) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
  /* "Sells from" (this product's own list; `[]` = the market default): its redo sends the list again, its undo the list
     the listing had. */
  if (kind === 'source') {
    const now = live.source
    if (!now) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
    const send = (codes: readonly string[]): MatrixReplay =>
      ({ kind: 'write', cell: { rowId: place.rowId, coordinateKey: place.coordinateKey, cell: 'source', value: [...codes], expectedVersion: live.version } })
    if (!('before' in entry)) return Array.isArray(entry.value) && !sameSourceCodes(entry.value as string[], now.own) ? send(entry.value as string[]) : SKIP
    if (!entry.before || entry.before.listingId !== live.listingId) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.gone }
    const was = entry.before.source?.own
    return was && !sameSourceCodes(was, now.own) ? send(was) : SKIP
  }
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
      // A business price set at Amazon (not kept in Nexus) is never "put back" by removing the offer.
      if (b.business.rule == null && b.business.reported) return { kind: 'refuse', reason: MATRIX_UNDO_COPY.amazonOwn }
      const was = matrixBusinessSettingOfCell(b.business)
      return JSON.stringify(was) === JSON.stringify(matrixBusinessSettingOfCell(live.business)) ? SKIP : write(kind, was)
    }
    default:
      return SKIP
  }
}

/** The part of the page's history a replay needs: an undo it could not carry out leaves the redo stack. */
export interface ReplayHistory { dropRedo: (rowId: string, colId: string, before?: unknown) => boolean }

export interface MatrixStepReplay {
  /** The step's writes, built from the cells as they are when the line's turn comes. */
  build: () => MatrixWriteCell[]
  /** Why a cell could not be put back (or sent again), as said when the writes were built. */
  readonly refused: readonly string[]
  /** The server's answer: an undo it refused (or that met a newer value) leaves the redo stack too. */
  settle: (outcomes: readonly MatrixWriteOutcome[]) => void
}

/**
 * One history step's Matrix values on their way back (⌘Z, ⌘⇧Z, a pop-up toast's Undo) — 2026-10-13 review. An undo that is
 * refused — here (`changedSince`, a clamped price, a listing that is not the one changed) or by the server (a conflict, a
 * refusal) — takes its change OFF the redo stack (`dropRedo`): a ⌘⇧Z never writes the old edit over the newer value. A
 * change put back stays redoable.
 */
export function matrixStepReplay(
  values: ReadonlyArray<{ rowId: string; colId: string; value: unknown }>,
  direction: 'undo' | 'redo',
  deps: { liveOf: (rowId: string, key: CoordinateKey) => MatrixCells | null; history: ReplayHistory; stamp?: (cell: MatrixWriteCell, live: MatrixCells | null) => MatrixWriteCell; say?: (reason: string) => void },
): MatrixStepReplay {
  const refused: string[] = []
  const sentFrom = new Map<string, { rowId: string; colId: string; value: unknown }>()
  const drop = (v: { rowId: string; colId: string; value: unknown }) => { if (direction === 'undo') deps.history.dropRedo(v.rowId, v.colId, v.value) }
  return {
    refused,
    build() {
      refused.length = 0
      sentFrom.clear()
      const out: MatrixWriteCell[] = []
      for (const v of values) {
        const place = matrixHistoryPlace(v.colId)
        if (!place || !isMatrixHistoryValue(v.value)) continue
        const live = deps.liveOf(v.rowId, place.key)
        const step = matrixReplay(place.kind, v.value, live, { rowId: v.rowId, coordinateKey: place.key })
        if (step.kind === 'write') {
          out.push(deps.stamp ? deps.stamp(step.cell, live) : step.cell)
          sentFrom.set(`${v.rowId}|${place.key}|${step.cell.cell}`, v)
        } else if (step.kind === 'refuse') {
          refused.push(step.reason)
          deps.say?.(step.reason)
          drop(v)
        }
      }
      return out
    },
    settle(outcomes) {
      for (const o of outcomes) {
        if (o.outcome !== 'refused' && o.outcome !== 'conflict') continue
        const v = sentFrom.get(`${o.rowId}|${o.coordinateKey}|${o.cell}`)
        if (v) drop(v)
      }
    },
  }
}

/** One ⌘Z record of a Matrix write: the cell, and what the write saved (`matrixHistoryAfter`). */
export interface MatrixHistoryNote { rowId: string; colId: string; key: CoordinateKey; after: MatrixHistoryValue }

/**
 * The ⌘Z step of a write is recorded when it is SENT; a cell the server did not change — refused, a conflict (a stamped
 * field that moved since the person saw it among them), nothing to change — leaves it again: an undo never puts back, and a
 * redo never sends, what was not saved.
 */
export function forgetUnsaved(
  history: { forget: (rowId: string, colId: string, after: unknown) => void },
  notes: readonly MatrixHistoryNote[],
  outcomes: readonly MatrixWriteOutcome[],
): void {
  for (const o of outcomes) {
    if (o.outcome === 'applied') continue
    const note = notes.find((n) => n.rowId === o.rowId && n.key === o.coordinateKey && n.colId === matrixHistoryColId(o.coordinateKey, o.cell))
    if (note) history.forget(note.rowId, note.colId, note.after)
  }
}
