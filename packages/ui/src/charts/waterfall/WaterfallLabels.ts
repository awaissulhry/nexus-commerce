/**
 * `Waterfall`'s words (B-W2b-09). English by default; a host passes the words it translates. Amounts come in already
 * written by the chart's `format` (the person's language and currency).
 */
export interface WaterfallLabels {
  /** A rise: "+ €12.00". */
  up: (amount: string) => string
  /** A fall: "− €3.00". */
  down: (amount: string) => string
  /** A step's name with its amount and the running total, for a screen reader: "Discount, − €3.00, now €45.00". */
  stepName: (label: string, amount: string, total: string) => string
  /** A total's name: "Net price, €45.00". */
  totalName: (label: string, amount: string) => string
  /** A step with a popover: its button's name. */
  open: (label: string) => string
  /** No steps. */
  empty: string
}

export const WATERFALL_LABELS: WaterfallLabels = {
  up: (amount) => `+ ${amount}`,
  down: (amount) => `− ${amount}`,
  stepName: (label, amount, total) => `${label}, ${amount}, now ${total}`,
  totalName: (label, amount) => `${label}, ${amount}`,
  open: (label) => `Show how ${label} is made`,
  empty: 'Nothing to show',
}
