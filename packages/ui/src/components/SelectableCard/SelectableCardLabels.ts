/**
 * `SelectableCard`'s words (B-W2b-09). English by default; a host passes the words it translates.
 */
export interface SelectableCardLabels {
  /** Said with a picked card's mark (a screen reader hears the state from `aria-pressed` / `aria-checked` too). */
  selected: string
}

export const SELECTABLE_CARD_LABELS: SelectableCardLabels = {
  selected: 'Selected',
}
