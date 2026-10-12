/**
 * AG.3 — what counts as "the operator clicked the ROW", shared by both engines.
 *
 * `onRowClick` usually opens a detail drawer. A click that landed on a checkbox, a link, a button
 * or a select is NOT a row click — those controls have their own behaviour, and firing the row
 * handler as well means selecting a row also navigates away from the grid you were selecting in.
 *
 * The selector is shared rather than written twice for the ordinary reason: the day someone adds
 * `textarea` or a `[role=button]` to one engine's list, the other must not keep opening drawers on
 * it. That is the same drift the design system already carries as a copy in apps/factory.
 */
export const INTERACTIVE_CHILD_SELECTOR = 'button, a, input, label, select'

/**
 * True when the click belongs to a control inside the row rather than to the row.
 *
 * Written against `Element` rather than the event so both call sites can pass what they have:
 * the hand-rolled grid has a React synthetic event's `target`, AG Grid hands over the underlying
 * browser event on `CellClickedEvent.event`.
 */
export function isInteractiveChild(target: EventTarget | null | undefined): boolean {
  const el = target as Element | null | undefined
  return typeof el?.closest === 'function' && el.closest(INTERACTIVE_CHILD_SELECTOR) !== null
}

/** The selection column's cells: AG's own (`ag-Grid-SelectionColumn`) and the DS DataGrid's (`__ck`). */
export const SELECTION_CELL_SELECTOR = '.ag-cell[col-id="ag-Grid-SelectionColumn"], .ag-cell[col-id="__ck"]'

/**
 * Grid audit F2 (2026-10-13) — a click that is NOT a row click, beyond the controls above:
 *  - one that ends a text selection inside the grid (a drag over words to copy them navigated away);
 *  - one in the selection column beside its checkbox (the cell is wider than the box).
 * A word selected by a DOUBLE-click cannot be told apart in time: its first click is an ordinary click.
 */
export function endsTextSelection(
  root: { contains(node: Node | null): boolean } | null | undefined,
  selection: { isCollapsed: boolean; anchorNode: Node | null; toString(): string } | null | undefined,
): boolean {
  return !!root && !!selection && !selection.isCollapsed && selection.toString().trim() !== '' && root.contains(selection.anchorNode)
}

export function inSelectionColumn(target: EventTarget | null | undefined): boolean {
  const el = target as Element | null | undefined
  return typeof el?.closest === 'function' && el.closest(SELECTION_CELL_SELECTOR) !== null
}

/** Not a row click: a control inside the row, the selection column, or the end of a text selection in this grid. */
export function notARowClick(target: EventTarget | null | undefined, root: { contains(node: Node | null): boolean } | null | undefined): boolean {
  return isInteractiveChild(target) || inSelectionColumn(target)
    || endsTextSelection(root, typeof window === 'undefined' ? null : window.getSelection())
}
