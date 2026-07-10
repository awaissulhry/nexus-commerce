import type { BaseRow } from './FlatFileGrid.types'

// UFX P2d — pure helpers for the ghost-row "infinite canvas" (GX.5 parity with
// the Amazon grid). Kept free of React so topup / materialize / paste-grow are
// unit-testable.
//
// A ghost row is a trailing blank "canvas" row: built from the consumer's
// makeBlankRow() but with `_ghost: true` and `_isNew`/`_dirty` forced FALSE —
// this specifically neutralizes consumers whose makeBlankRow marks new rows
// dirty (eBay), so the canvas never pollutes dirty counts, Save, validation,
// select-all or exports. It materializes into a real new row on its first
// real edit; the topup keeps the buffer full, so the sheet grows forever.

/** Build one ghost row from the consumer's blank-row factory. */
export function makeGhostRow(makeBlankRow: () => BaseRow): BaseRow {
  return { ...makeBlankRow(), _ghost: true, _isNew: false, _dirty: false }
}

/** Build `n` ghost rows (0 or negative → empty array). */
export function makeGhostRows(n: number, makeBlankRow: () => BaseRow): BaseRow[] {
  if (n <= 0) return []
  return Array.from({ length: n }, () => makeGhostRow(makeBlankRow))
}

/** Number of ghost rows in the sheet. */
export function countGhosts(rows: readonly BaseRow[]): number {
  let n = 0
  for (const r of rows) if (r._ghost) n++
  return n
}

/**
 * Append ghosts until `target` of them exist. Returns the SAME array when the
 * buffer is already full — the topup effect converges (setRows bails out on an
 * identical reference), so it can never render-loop.
 */
export function topUpGhosts(rows: BaseRow[], target: number, makeBlankRow: () => BaseRow): BaseRow[] {
  const missing = target - countGhosts(rows)
  if (missing <= 0) return rows
  return [...rows, ...makeGhostRows(missing, makeBlankRow)]
}

/**
 * Patch that materializes a ghost on its first real edit (typing / paste /
 * fill / enum pick): it becomes a plain NEW dirty row — exactly what Add-row
 * produces — and the topup then spawns a fresh ghost below. Empty object for
 * real rows, so spreading it into the grid's write path is a no-op for them
 * (legacy behavior byte-identical).
 */
export function materializeGhostPatch(row: BaseRow): Partial<BaseRow> {
  return row._ghost ? { _ghost: false, _isNew: true, _dirty: true } : {}
}

/**
 * How many rows a paste block of height `blockH` starting at display index
 * `startRi` needs BEYOND the current `displayLen` rows (0 = it already fits).
 * Drives paste-beyond-end auto-grow when the ghost canvas is enabled.
 */
export function pasteGrowCount(displayLen: number, startRi: number, blockH: number): number {
  return Math.max(0, startRi + blockH - displayLen)
}
