/**
 * GDS — the UNSAVED row (2026-10-05, Add rows): a row the person ADDED to a sheet and has not saved. It lives in the page
 * only, until its first value creates the real record, and its data says so with `unsaved: true` (the product sheet's
 * empty rows, `newRows/newRowsGrid.ts`). No React here: the CSV export reads it too.
 */

/**
 * Its row state. Apply with `rowClassRules: { [UNSAVED_ROW_CLASS]: (p) => isUnsavedRowData(p.data) }`; the row's identity
 * cell carries the words ("Not saved", a `warning` Pill). Draws a DASHED warning bar at the row's start edge — the
 * inactive row's solid bar (`nds-row-inactive`) means a listing that does not sell; dashes mean "not stored yet" — and
 * mutes the row's other cells (a cell opts out with `nds-cell-full-strength`, as on a quiet row). Never a whole-row tint
 * (Owner, 2026-10-04).
 */
export const UNSAVED_ROW_CLASS = 'nds-row-unsaved'

/** A row whose data is not a stored record yet: never exported, counted or selected as one. */
export function isUnsavedRowData(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { unsaved?: unknown }).unsaved === true
}
