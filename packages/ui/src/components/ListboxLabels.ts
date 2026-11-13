/**
 * `Listbox`'s and `ListboxPanel`'s words (B-W2b-F41). English by default; `placeholder`, `searchPlaceholder` and
 * `actionsLabel` still win over them.
 */
export interface ListboxLabels {
  /** The trigger with nothing chosen (when no `placeholder` is passed): "Select…". `Listbox` only. */
  select: string
  /** The search box's empty text: "Search…". */
  search: string
  /** The search box's name: "Search options". */
  searchOptions: string
  /** The list when nothing matches. */
  noMatches: string
  /** The row that takes the typed text as a value of its own (`allowCustom`): `Use "Nero"`. */
  useTyped: (text: string) => string
  /** The actions' group name for a screen reader: "Actions". */
  actions: string
}

export const LISTBOX_LABELS: ListboxLabels = {
  select: 'Select…',
  search: 'Search…',
  searchOptions: 'Search options',
  noMatches: 'No matches',
  useTyped: (text) => `Use "${text}"`,
  actions: 'Actions',
}
