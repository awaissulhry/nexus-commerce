import type { Sizing } from '../schema'

/**
 * owb-po3.2: the products table's columns are gone — the ONE lines table (`lib/order-lines`, Model · Material · Sizes · Pieces · own
 * columns · Your price) draws the draft's lines in both doors. What stays here is the office host's action shape (S2's
 * `OfficeDraftView` passes it through `DraftPage`'s `table`): `DraftPage` maps it onto the ONE table (`linesFromTable`) until the office
 * wires the table's own actions (`lines`). Do not add to it: new hosts use `OrderLinesActions`.
 */

/** A row's cell typed or picked: `rowId` null = the row "Add a line" drew (not saved yet). */
export interface ProductsTableActions {
  onProduct?: (rowId: string | null, value: { words: string } | { styleId: string }) => void
  onSizing?: (rowId: string | null, sizing: Sizing | null) => void
  onColour?: (rowId: string | null, value: { words: string } | { colourwayId: string }) => void
  onPieces?: (rowId: string) => void
  onOptions?: (rowId: string) => void
  onFiles?: (rowId: string) => void
  onRemove?: (rowId: string) => void
  onAdd?: () => void
  /** The empty row "Add a line" drew goes (nothing was saved). */
  onDropPending?: () => void
}
