/**
 * `OrderedList`'s words (B-W2b-F41): the move buttons' and the grip's names and what a screen reader hears as an item
 * moves. English by default; `item` is the item's name (`itemLabel`).
 */
export interface OrderedListLabels {
  /** "Move Sewing up" */
  moveUp: (item: string) => string
  /** "Move Sewing down" */
  moveDown: (item: string) => string
  /** The keyboard grip (`keyboardGrip`): "Reorder Sewing; use arrow keys". */
  reorder: (item: string) => string
  /** After a move: "Sewing, position 2 of 5". */
  position: (item: string, place: number, total: number) => string
  /** While a live drag runs (`liveDrag`): "Sewing, moving to position 2 of 5". */
  moving: (item: string, place: number, total: number) => string
}

export const ORDERED_LIST_LABELS: OrderedListLabels = {
  moveUp: (item) => `Move ${item} up`,
  moveDown: (item) => `Move ${item} down`,
  reorder: (item) => `Reorder ${item}; use arrow keys`,
  position: (item, place, total) => `${item}, position ${place} of ${total}`,
  moving: (item, place, total) => `${item}, moving to position ${place} of ${total}`,
}
