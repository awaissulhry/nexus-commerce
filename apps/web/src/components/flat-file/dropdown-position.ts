/**
 * UFX P7 (item 2) — pure position math for the portaled EnumDropdown.
 *
 * The dropdown used to render inline (absolute, top-full) inside the grid's
 * overflow container, so on bottom rows it was clipped. It now portals to
 * document.body and positions off the CELL's viewport rect:
 *   - opens below the cell by default;
 *   - FLIPS above when there isn't room below AND there is more room above;
 *   - clamps into the viewport on both axes (a flip that still overflows is
 *     pinned inside rather than cut off);
 *   - is at least MIN_DROPDOWN_WIDTH wide and never narrower than the cell
 *     (the old `w-56 min-w-full` behavior).
 *
 * Kept free of React/DOM so flip/clamp behavior is unit-testable.
 */

/** Matches the old Tailwind `w-56` (14rem). */
export const MIN_DROPDOWN_WIDTH = 224

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  width: number
}

export interface DropdownPosition {
  left: number
  top: number
  width: number
  /** True when the menu opens upward (bottom edge sits on the cell's top). */
  openUp: boolean
}

export function computeDropdownPosition(opts: {
  cell: AnchorRect
  /** Measured menu size (offsetWidth/offsetHeight of the rendered menu). */
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  /** Viewport edge inset (default 8). */
  margin?: number
}): DropdownPosition {
  const { cell, menuHeight, viewportWidth, viewportHeight } = opts
  const margin = opts.margin ?? 8

  const width = Math.max(MIN_DROPDOWN_WIDTH, cell.width)

  const spaceBelow = viewportHeight - margin - cell.bottom
  const spaceAbove = cell.top - margin
  const openUp = menuHeight > spaceBelow && spaceAbove > spaceBelow

  let top = openUp ? cell.top - menuHeight : cell.bottom
  // Clamp inside the viewport (covers "doesn't fit either way").
  top = Math.min(top, viewportHeight - margin - menuHeight)
  top = Math.max(top, margin)

  let left = cell.left
  left = Math.min(left, viewportWidth - margin - width)
  left = Math.max(left, margin)

  return { left, top, width, openUp }
}
