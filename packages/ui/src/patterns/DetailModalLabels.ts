/**
 * `DetailModal`'s words (B-W2b-04): Prev / Next, the counter, the held reasons, the body's states. English by default.
 * `noun` names the rows when the host's `nav` names none; a host that names one passes it in its own language
 * ("regola"), and these words put it in a sentence.
 */
export interface DetailModalLabels {
  /** The rows' name when `nav.noun` is not given. */
  noun: string
  /** Prev's name: "Previous rule". */
  previous: (noun: string) => string
  /** Next's name: "Next rule". */
  next: (noun: string) => string
  /** The Prev / Next group's name: "Move between rules". */
  moveBetween: (noun: string) => string
  /** The counter: "3 of 12". */
  position: (place: number, total: number) => string
  /** Both held: the row is not in the table now. */
  notInTable: (noun: string) => string
  /** Prev held at the first row; `onPage` when more rows come before this page. */
  first: (noun: string, onPage: boolean) => string
  /** Next held at the last row; `onPage` when more rows come after this page. */
  last: (noun: string, onPage: boolean) => string
  /** The tab row's name (when no `tabsLabel` is passed). */
  tabs: string
  /** The body while the row is read. */
  reading: string
  /** The failed read's button. */
  tryAgain: string
  /** The dialog's close button. */
  close: string
}

export const DETAIL_MODAL_LABELS: DetailModalLabels = {
  noun: 'row',
  previous: (noun) => `Previous ${noun}`,
  next: (noun) => `Next ${noun}`,
  moveBetween: (noun) => `Move between ${noun}s`,
  position: (place, total) => `${place} of ${total}`,
  notInTable: (noun) => `This ${noun} is not in the table now`,
  first: (noun, onPage) => `This is the first ${noun}${onPage ? ' on this page' : ''}`,
  last: (noun, onPage) => `This is the last ${noun}${onPage ? ' on this page' : ''}`,
  tabs: 'Sections',
  reading: 'Reading…',
  tryAgain: 'Try again',
  close: 'Close',
}
