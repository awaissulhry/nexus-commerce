/**
 * `GridCardList`'s words (B-W2b-09, D3). English by default; a host passes the words it translates (`labels={ds.cardList}`).
 */
export interface CardListLabels {
  /** Turns select mode on. */
  select: string
  /** Turns select mode off (and clears the selection). */
  done: string
  /** The header box's name. */
  selectAll: string
  /** "3 selected". */
  selected: (count: number) => string
  /** A card's box: "Select PO-0042". */
  selectOne: (name: string) => string
  /** Select held: nothing on the page may be selected. */
  nothingToSelect: string
  /** The sort control's name. */
  sortBy: string
  /** The list's own order (no column sort). */
  listOrder: string
  /** A sort choice: "Due date, oldest first" is the app's; the DS writes "Due date ↑" / "Due date ↓". */
  ascending: (column: string) => string
  descending: (column: string) => string
  /** While the first page is read. */
  reading: string
}

export const CARD_LIST_LABELS: CardListLabels = {
  select: 'Select',
  done: 'Done',
  selectAll: 'Select all',
  selected: (count) => `${count} selected`,
  selectOne: (name) => `Select ${name}`,
  nothingToSelect: 'Nothing here can be selected',
  sortBy: 'Sort by',
  listOrder: 'List order',
  ascending: (column) => `${column} ↑`,
  descending: (column) => `${column} ↓`,
  reading: 'Reading…',
}
