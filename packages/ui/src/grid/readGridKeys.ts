/**
 * The keyboard of a grid that READS (grid audit F6, step 5 — 2026-10-13). One rule for NexusGrid, the AG DataGrid and
 * WorkspaceGrid; `useReadGridKeys` applies it, and this file holds the decision, so every case is a test.
 *
 * Measured before (local stack, 2026-10-13): Tab walked every column header again and again (115 presses on /products
 * never left the grid), and where it reached the rows it stopped on every link and button of every row. The rule now:
 *  - the grid is ONE stop on the page: Tab enters it (AG puts the focus on the header), Tab or Shift+Tab leaves it;
 *  - the arrows move between header and cells (AG's own navigation);
 *  - Enter on a cell presses its one link or button; with several, Enter moves into the cell, Tab and Shift+Tab walk its
 *    controls and Esc goes back to the cell; on a cell with none, Enter opens the row as a click would;
 *  - Space presses a cell's one button; anywhere else Space stays AG's (it ticks the row);
 *  - a column that answers its own keys (`suppressKeyboardEvent` of its own — `entityLinksKeys`, `cellDetailKeys`, a
 *    switch) keeps them, and AG's selection cell keeps AG's;
 *  - a grid whose cells hold form fields (quantities typed row by row) is a FORM: Tab walks its fields, as before.
 * Grids that edit (the sheets, the Matrix, cell ranges) keep their spreadsheet keys; none of this applies to them.
 */

/** What a person can press inside a cell. AG's own row checkbox is not one: Space ticks the row. */
export const CELL_CONTROL = [
  'a[href]', 'button:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"]):not(.ag-checkbox-input)',
  '[role="button"]:not([aria-disabled="true"])', '[role="switch"]:not([aria-disabled="true"])', '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * A field a person types into or picks from — it owns its keys, and a grid holding one is a form. A checkbox is not one:
 * a row's tick box is in every selectable grid, and Space ticks it.
 */
export const FORM_FIELD = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  'select', 'textarea', '[contenteditable="true"]', '[role="combobox"]', '[role="textbox"]', '[role="spinbutton"]',
].join(', ')

/** A control Space presses (a link answers Enter only). */
export const BUTTON_LIKE = 'button, [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"]'

/** A tick box: Space ticks it, Enter does not (as everywhere in a browser). */
export const CHECKBOX = 'input[type="checkbox"], [role="checkbox"]'

/** AG's row-selection column. */
export const SELECTION_COLUMN = 'ag-Grid-SelectionColumn'

export interface ReadKeyFacts {
  key: string
  shift: boolean
  /** Ctrl, ⌘ or Alt held — never ours. */
  modifier: boolean
  composing: boolean
  /** An earlier handler took the key (a control's own Esc, a menu). */
  prevented: boolean
  /** Where the focus is: on a cell, on a control inside a cell, on a header, elsewhere in the grid. */
  on: 'cell' | 'control' | 'header' | 'other'
  /** The cell is AG's selection cell. */
  selectionCell: boolean
  /** The cell's column answers its own keys. */
  ownKeys: boolean
  /** The pressable controls in the focused cell, in order. */
  controls: number
  /** The focused control's place among them (`on === 'control'`), else -1. */
  index: number
  /** The cell's one control is a button (Space presses it). */
  buttonLike: boolean
  /** The cell's one control is a tick box (Enter leaves it alone). */
  checkbox: boolean
  /** Some cell of the grid holds a form field: the grid is a form and Tab walks its fields. */
  formGrid: boolean
  /** A click on a row does something (the page listens for it). */
  opensRows: boolean
}

export type ReadKeyAction =
  /** Focus the page's next (or previous) stop outside the grid. */
  | { do: 'leave'; back: boolean }
  /** Press the cell's one control. */
  | { do: 'press' }
  /** Move into the cell: focus its control number `to`. */
  | { do: 'control'; to: number }
  /** Back to the cell. */
  | { do: 'cell' }
  /** Open the row, as a click on the cell would. */
  | { do: 'open' }

export function readGridKey(f: ReadKeyFacts): ReadKeyAction | null {
  if (f.prevented || f.composing || f.modifier) return null
  // A control the cell does not list (AG's row checkbox, a span made focusable) counts as the cell.
  const on = f.on === 'control' && f.index < 0 ? 'cell' : f.on
  if (f.key === 'Tab') {
    if (f.formGrid) return null
    if (on === 'control') {
      if (!f.shift && f.index < f.controls - 1) return { do: 'control', to: f.index + 1 }
      if (f.shift && f.index > 0) return { do: 'control', to: f.index - 1 }
      if (f.shift) return { do: 'cell' }
    }
    return { do: 'leave', back: f.shift }
  }
  if (f.key === 'Escape') return on === 'control' ? { do: 'cell' } : null
  if (on !== 'cell' || f.ownKeys || f.selectionCell) return null
  if (f.key === 'Enter') {
    if (f.controls === 1) return f.checkbox ? null : { do: 'press' }
    if (f.controls > 1) return { do: 'control', to: 0 }
    return f.opensRows ? { do: 'open' } : null
  }
  if (f.key === ' ' && f.controls === 1 && f.buttonLike) return { do: 'press' }
  return null
}
