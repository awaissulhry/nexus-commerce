/**
 * PES.1 — the pure half of the View-bar chip contract.
 *
 * `types.ts` holds the shapes and stays declaration-only; these are the derivations every consumer
 * would otherwise write for itself. Pure and import-free, so they are testable without a browser
 * and so a producer computing a chip does not need React to do it.
 */

import type { ViewChip, ViewChipCells } from './types'

export const EMPTY_VIEW_CHIP_CELLS: ViewChipCells = { byRow: {} }

/** Rows a chip affects — the keys of `byRow`. */
export function viewChipRows(cells: ViewChipCells): string[] {
  return Object.keys(cells.byRow).filter((id) => cells.byRow[id].length > 0)
}

/** The same unit as Required and the column views; cell totals stay explicit in the detail. */
export function viewChipColumnCountLabel(chip: ViewChip): string | null {
  if (chip.count === null) return null
  if (chip.noun && chip.noun !== 'columns') return String(chip.count)
  const columns = viewChipColumns(chip.cells).length
  return `${columns} ${columns === 1 ? 'column' : 'columns'}`
}

export function viewChipSummary(chip: ViewChip): string {
  if (chip.count === null) return chip.note ?? 'Not counted yet'
  if (chip.noun && chip.noun !== 'columns') return `${chip.count} ${chip.count === 1 ? (chip.noun === 'axes' ? 'axis' : chip.noun.slice(0, -1)) : chip.noun}`
  const rows = viewChipRows(chip.cells).length
  const cells = Object.values(chip.cells.byRow).reduce((n, keys) => n + new Set(keys).size, 0)
  return `${cells} affected ${cells === 1 ? 'cell' : 'cells'} across ${viewChipColumnCountLabel(chip)} and ${rows} ${rows === 1 ? 'row' : 'rows'}`
}

/** Columns a chip affects — the union of the values, first-seen order, de-duplicated. */
export function viewChipColumns(cells: ViewChipCells): string[] {
  const seen = new Set<string>()
  for (const cols of Object.values(cells.byRow)) for (const c of cols) seen.add(c)
  return [...seen]
}

/** Is this cell one of the chip's? For a renderer marking the actual cells, not the rectangle. */
export function viewChipHasCell(cells: ViewChipCells, rowId: string, colId: string): boolean {
  return cells.byRow[rowId]?.includes(colId) ?? false
}

/**
 * Should this chip be on screen at all?
 *
 * A chip that has never been counted (`count: null`) STAYS — it is the thing telling the operator
 * that a count is pending or unavailable, and hiding it would silently answer "none". Only a real,
 * measured zero can hide, and only when the producer asked for that.
 */
export function isViewChipVisible(chip: ViewChip, activeId?: string | null): boolean {
  // A selected filter stays selected at zero, with a visible way to clear it.
  if (chip.id === activeId) return true
  if (chip.count === null) return true
  if (chip.count === 0) return chip.hideWhenZero !== false ? false : true
  return true
}

/**
 * What the chip's count reads as.
 *
 * 🔴 `null` never renders as `0`. The two are different claims — "not counted" versus "counted,
 * none" — and collapsing them is the same class of lie as a 0% readiness chip on a scope nobody
 * scored (feedback_100_percent_honest_ui).
 */
export function viewChipCountLabel(chip: ViewChip): string | null {
  return chip.count === null ? null : String(chip.count)
}

/**
 * Does this chip wear an alarm glyph? (§6.2 / DS1-11.)
 *
 * 🔴 The bar used to render an `AlertTriangle` for EVERY chip in its `.map()`, so PES.8's
 * "✦ AI drafts (12)" — a count of *available work* — wore an alarm. A warning glyph on a
 * non-warning is a **false positive**, which costs more than a missing one: it teaches operators
 * that the alarm means nothing, and then the real alarms mean nothing too.
 *
 * Two lanes asked that the fix wait for §6.3's move of the warning component, so that the glyph
 * became a property of the chip's KIND rather than of whichever component draws the bar. That
 * condition is met without the move: `ViewChip.tone` is already in the contract and already
 * produced — the master's `missing-required` is `warning`, the channel's three are
 * `danger`/`warning`/`danger`, and `ai-drafts` deliberately sets none. So the kind was always
 * there; only the renderer was ignoring it.
 *
 * `info` and `neutral` are NOT alarms. An untoned chip is not an alarm either — a producer that has
 * not said its chip is a warning has not said it is one, and the renderer must not decide for it.
 */
export function viewChipIsAlarm(chip: ViewChip): boolean {
  return chip.tone === 'warning' || chip.tone === 'danger'
}
