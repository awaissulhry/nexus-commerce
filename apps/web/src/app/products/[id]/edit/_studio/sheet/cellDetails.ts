/**
 * Cell details — the ONE window both scopes of the product sheet open (2026-10-04, shared Cell details).
 *
 * The window, its menu item (right-click and Shift+F10) and its toolbar ⋯ item belong to the shared control
 * (`useSheetControl`); a scope supplies only how a cell is described (`CellDetailsSource`). Before, the window was
 * written inside the channel adapter and the Shared scope had none.
 *
 * Owner 2026-10-04: at most ONE action — the cell menu's own action for that cell (Reset to inherited, or a channel's
 * Keep / Reset / Follow Shared). An action is offered only where a real writer performs exactly what it says.
 */

export const CELL_DETAILS_COPY = {
  item: 'Cell details…',
  itemDescription: 'Select a cell to inspect its full value, source and validation.',
  noCell: 'Select an attribute cell first, then open Cell details.',
  close: 'Close',
} as const

export interface CellDetailsAction {
  label: string
  description: string
  run: () => void
}

export interface CellDetailsContent {
  /** `${column label}: ${SKU}` */
  title: string
  /** The value as the scope shows it (`cellDetailsValue` for a raw value). */
  value: string
  /** The explanation, composed into one text (`composeCellTooltip`), as the channel window always drew it. */
  notes: string
  /** At most one: the cell menu's own action for this cell. */
  action?: CellDetailsAction
}

/** What a scope tells the shared control. */
export interface CellDetailsSource<Row> {
  /**
   * Whether a column opens Cell details. `true`: the menu item shows and ⋯ opens it. `{ refusal }`: no menu item, and ⋯
   * says the refusal (e.g. photos: "Photos have their own editor: press Enter on the cell."). `false`: no menu item, and
   * ⋯ says `CELL_DETAILS_COPY.noCell`.
   */
  explains: (colId: string) => boolean | { refusal: string }
  /** The window's content for one cell, or null when the cell cannot be described (⋯ then says `noCell`). */
  describe: (row: Row, colId: string) => CellDetailsContent | null
}

/** A raw value as the window shows it — the channel window's rule since it existed. */
export function cellDetailsValue(value: unknown): string {
  return value == null || value === '' ? 'Empty' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}
