/**
 * What a REFUSED Matrix write leaves on the page — the stored value, and the reason where the person can read it.
 *
 * Found by the combined end-to-end run (2026-09-30): a typed Amazon EU quantity the server refused as
 * "Amazon-managed" kept showing the typed number (the grid edits a CLONE of the cells, and a refused live write
 * never re-read), the hover said "Pinned at 8 · …" (the cell's own tooltip, from that clone), the reason appeared
 * nowhere, and "1 refused" led nowhere. The rules, pure so they are tested:
 *   - after a live write that moved something, re-read (as before); after a refusal, RESTORE the stored read, so the
 *     cell shows what is saved;
 *   - a refused cell's hover leads with the reason (hover elaborates — the sheet's `composeCellTooltip` order);
 *   - the footer's refusal note carries ONE phrased example and narrows the grid to the affected rows (the sheet's
 *     `GridSheetNote kind="refusal"` with `onShow`).
 */
import { MATRIX_CELL_LABELS, type MatrixCellKind, type MatrixCoordinate, type MatrixWriteOutcome } from './contract'

/** What a live write leaves the grid holding: the server's new read, the stored read again, or nothing new. */
export type AfterLiveWrite = 'reread' | 'restore' | 'none'

export function afterLiveWrite(results: readonly MatrixWriteOutcome[]): AfterLiveWrite {
  if (results.some((r) => r.outcome === 'applied' || r.outcome === 'conflict')) return 'reread'
  if (results.some((r) => r.outcome === 'refused')) return 'restore'
  return 'none'
}

/** A refused cell's hover: the reason first, then what the cell says. */
export function refusedTooltip(reason: string | null | undefined, cellTooltip: string | null | undefined): string | undefined {
  if (!reason) return cellTooltip ?? undefined
  return cellTooltip ? `${reason} · ${cellTooltip}` : reason
}

export interface RefusedMark {
  rowId: string
  coordinate: Pick<MatrixCoordinate, 'label'>
  kind: MatrixCellKind
  reason: string | null | undefined
}

/** The footer note's ONE example, already phrased: `Amazon · EU inventory · IT DE · Qty — Amazon-managed`. */
export function refusalLead(marks: readonly RefusedMark[]): string | undefined {
  const first = marks.find((m) => m.reason) ?? marks[0]
  if (!first) return undefined
  const where = `${first.coordinate.label} · ${MATRIX_CELL_LABELS[first.kind]}`
  return first.reason ? `${where} — ${first.reason}` : where
}

/** The rows the note narrows the grid to. */
export const refusedRowIds = (marks: readonly RefusedMark[]): Set<string> => new Set(marks.map((m) => m.rowId))
