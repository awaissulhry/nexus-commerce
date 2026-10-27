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

/** The row-label column's width when the caller names none (px): a weekday ("Mon") fits. */
export const HEAT_LABEL_WIDTH = 36

/**
 * The row-label column's width (Reviews Insights, 2026-10-26): the caller's px, whole, between 24 and 240 (a theme name
 * such as "Fit & sizing" needs about 120); none, or not a number → 36.
 */
export function heatLabelWidth(px: number | null | undefined): number {
  if (px == null || !Number.isFinite(px)) return HEAT_LABEL_WIDTH
  return Math.min(240, Math.max(24, Math.round(px)))
}

/** A cell that can be pressed: one with a measurement. A null cell (no measurement) has nothing to open. */
export function isHeatPressable(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(value)
}

/** The first pressable cell, reading row by row — the one Tab lands on; none → null. */
export function firstHeatCell(data: ReadonlyArray<ReadonlyArray<number | null>>): { row: number; col: number } | null {
  for (let r = 0; r < data.length; r++) for (let c = 0; c < data[r].length; c++) if (isHeatPressable(data[r][c])) return { row: r, col: c }
  return null
}

/**
 * Where an arrow key moves the focus between pressable cells (one Tab stop for the whole map, the arrows inside it):
 * ←/→ the nearest pressable cell in the row, ↑/↓ the nearest pressable cell in the column, Home/End the first/last
 * pressable cell of the row. Nowhere to go (an edge, or a key it does not use) → null: the focus stays.
 */
export function heatMove(
  data: ReadonlyArray<ReadonlyArray<number | null>>,
  row: number,
  col: number,
  key: string,
): { row: number; col: number } | null {
  const ok = (r: number, c: number) => r >= 0 && r < data.length && c >= 0 && c < (data[r]?.length ?? 0) && isHeatPressable(data[r][c])
  const scan = (dr: number, dc: number) => {
    for (let r = row + dr, c = col + dc; r >= 0 && r < data.length && c >= 0 && c < (data[r]?.length ?? 0); r += dr, c += dc) if (ok(r, c)) return { row: r, col: c }
    return null
  }
  if (key === 'ArrowRight') return scan(0, 1)
  if (key === 'ArrowLeft') return scan(0, -1)
  if (key === 'ArrowDown') return scan(1, 0)
  if (key === 'ArrowUp') return scan(-1, 0)
  const cells = (data[row] ?? []).map((_, c) => c).filter((c) => ok(row, c))
  if (key === 'Home') return cells.length && cells[0] !== col ? { row, col: cells[0] } : null
  if (key === 'End') return cells.length && cells[cells.length - 1] !== col ? { row, col: cells[cells.length - 1] } : null
  return null
}
