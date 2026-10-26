/**
 * Heatmap — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * A cell is keyed `"row:col"`. A MARKED cell is outlined (the send-hour grid marks the hour each day sends at); the mark
 * is drawn on top of the shade, so it never hides the value. A cell's words are the caller's (`cellWords`) or the
 * heatmap's own: "Mon · 14:00: 12", "Sun · 03:00: no data".
 */

export function heatKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function isHeatMarked(marked: ReadonlySet<string> | null | undefined, row: number, col: number): boolean {
  return marked != null && marked.has(heatKey(row, col))
}

/** The largest measured value — nulls are no measurement and never flatten the ramp; at least 1. */
export function heatMax(data: ReadonlyArray<ReadonlyArray<number | null>>): number {
  let max = 1
  for (const row of data) for (const v of row) if (v != null && Number.isFinite(v) && v > max) max = v
  return max
}

/** The shade's opacity: 0.05 for zero up to 1 at the largest value. */
export function heatAlpha(value: number, max: number): number {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return Number((0.05 + ratio * 0.95).toFixed(3))
}

/** The default words of a cell: "Mon · 14:00: 12" (no column name: "Fit: 9"); a null cell says `emptyLabel`. */
export function heatCellWords(
  rowLabel: string,
  colName: string,
  value: number | null,
  format?: (v: number) => string,
  emptyLabel = 'no data',
): string {
  const shown = value == null ? emptyLabel : format ? format(value) : String(value)
  return `${rowLabel}${colName ? ` · ${colName}` : ''}: ${shown}`
}
