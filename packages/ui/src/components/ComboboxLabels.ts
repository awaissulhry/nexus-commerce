/** `Combobox`'s words (B-W2b-04). English by default; `placeholder` still wins over `search`. */
export interface ComboboxLabels {
  /** The field's empty text (when no `placeholder` is passed). */
  search: string
  /** The list when nothing matches what was typed. */
  noMatches: string
}

export const COMBOBOX_LABELS: ComboboxLabels = { search: 'Search…', noMatches: 'No matches' }
