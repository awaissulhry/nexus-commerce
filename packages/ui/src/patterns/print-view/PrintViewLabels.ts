/**
 * `PrintView`'s words (B-W2b-09). English by default; a host passes the words it translates.
 */
export interface PrintViewLabels {
  /** The strip's button. */
  print: string
  /** The strip's way back when the app gives no words. */
  back: string
  /** "Printed by Maria Rossi on 31 Oct 2026, 10:42". */
  printedBy: (person: string, when: string) => string
  /** "Printed on 31 Oct 2026, 10:42" (no person). */
  printedOn: (when: string) => string
  /** The filters line: "Filters: Status: Open · Site: Bologna". */
  filters: (list: string) => string
  /** One filter: "Status: Open". */
  filter: (label: string, value: string) => string
  /** Between filters. */
  join: string
  /** No filter is on: the page prints every row. */
  noFilters: string
  /** The strip's name for a screen reader. */
  strip: string
}

export const PRINT_VIEW_LABELS: PrintViewLabels = {
  print: 'Print',
  back: 'Back',
  printedBy: (person, when) => `Printed by ${person} on ${when}`,
  printedOn: (when) => `Printed on ${when}`,
  filters: (list) => `Filters: ${list}`,
  filter: (label, value) => `${label}: ${value}`,
  join: ' · ',
  noFilters: 'No filters: every row',
  strip: 'Print',
}
