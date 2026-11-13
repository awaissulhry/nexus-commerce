/**
 * `WorkspaceSubheader`'s words (B-W2b-F41): the toggle, collapse and close buttons' names and the parent rows' words.
 * English by default; a word with the navigation's or a row's name in it is a function.
 */
export interface WorkspaceSubheaderLabels {
  /** The button that opens the navigation (and a folded column's): "Expand reviews navigation". Gets `navigationLabel` as given. */
  expand: (navigation: string) => string
  /** The column's fold button and the plain drawer's close button: "Collapse reviews navigation". */
  collapse: (navigation: string) => string
  /** A pinned subheader's drawer close button: "Close Reviews navigation". */
  close: (navigation: string) => string
  /** The rows under a parent row when the row names none (`childrenLabel`): "items". */
  rowsNoun: string
  /** A parent row's chevron while its rows are hidden: "Show Amazon markets". */
  showRows: (label: string, noun: string) => string
  /** A parent row's chevron while its rows are shown: "Hide Amazon markets". */
  hideRows: (label: string, noun: string) => string
  /** The name of the list under a parent row: "Amazon markets". */
  rows: (label: string, noun: string) => string
  /** Beside the dot of a closed parent that holds the current page: "(the current page is in Amazon)". */
  currentInside: (label: string) => string
}

export const WORKSPACE_SUBHEADER_LABELS: WorkspaceSubheaderLabels = {
  expand: (navigation) => `Expand ${navigation.toLowerCase()}`,
  collapse: (navigation) => `Collapse ${navigation.toLowerCase()}`,
  close: (navigation) => `Close ${navigation}`,
  rowsNoun: 'items',
  showRows: (label, noun) => `Show ${label} ${noun}`,
  hideRows: (label, noun) => `Hide ${label} ${noun}`,
  rows: (label, noun) => `${label} ${noun}`,
  currentInside: (label) => `(the current page is in ${label})`,
}
