/**
 * `OptionList`'s and `MultiSelect`'s words (B-W2b-F41). English by default; `searchPlaceholder`, `emptyLabel` and
 * `placeholder` still win over them.
 */
export interface OptionListLabels {
  /** The search box's empty text: "Search…". */
  search: string
  /** The search box's name: "Search options". */
  searchOptions: string
  /** The row that picks every option: "Select all". */
  selectAll: string
  /** The list when nothing matches what was typed. */
  noMatches: string
  /** A row that may not be unpicked, on hover: "At least 1 must stay selected". */
  atLeast: (count: number) => string
}

/** `MultiSelect`'s words: the list's, and the trigger's. */
export interface MultiSelectLabels extends OptionListLabels {
  /** The trigger with nothing picked (when no `placeholder` is passed) and with every option picked: "All". */
  all: string
  /** The trigger with some options picked (when no `formatLabel` is passed): "3 selected". */
  selected: (count: number) => string
}

export const OPTION_LIST_LABELS: OptionListLabels = {
  search: 'Search…',
  searchOptions: 'Search options',
  selectAll: 'Select all',
  noMatches: 'No matches',
  atLeast: (count) => `At least ${count} must stay selected`,
}

export const MULTI_SELECT_LABELS: MultiSelectLabels = {
  ...OPTION_LIST_LABELS,
  all: 'All',
  selected: (count) => `${count} selected`,
}
