/**
 * `NexusGrid plain` — the height rule, pure so it is tested in Node (bid page polish round 2, run 3: a one- or two-row
 * table inside a detail kept AG's 150px auto-height band under its rows).
 *
 * The grid is exactly its header + rows (+ pinned rows and a horizontal scrollbar when AG shows them) + its 1px frame
 * top and bottom, measured after AG sizes the rows; never taller than `max` (it scrolls inside beyond it) and never
 * shorter than `min` (room for the "No rows" overlay).
 */
export function plainGridHeight(parts: { header: number; rows: number; extra?: number; frame?: number; min: number; max: number }): number {
  const want = Math.ceil(parts.header + parts.rows + (parts.extra ?? 0) + (parts.frame ?? 2))
  return Math.min(parts.max, Math.max(parts.min, want))
}

/** Before AG has drawn: header + one row height per row (or the overlay's room with none), capped. */
export function plainFirstGuess(header: number, rowHeight: number, rows: number, max: number): number {
  return plainGridHeight({ header, rows: rows * rowHeight, min: rows === 0 ? header + 2 * rowHeight + 2 : 0, max })
}
