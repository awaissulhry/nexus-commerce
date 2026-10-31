import type { CheckState } from './checkListModel'

/**
 * `CheckList`'s words (B-W2b-09; the design's CheckList / ReadinessChecklist). English by default; a host passes the
 * words it translates. A word with a number or a name in it is a function.
 */
export interface CheckListLabels {
  /** Each state's word, said beside its icon (never colour alone). */
  states: Record<CheckState, string>
  /** The summary when nothing holds: "All 7 checks pass". */
  allPass: (total: number) => string
  /** The summary when checks hold: "2 of 7 checks open" ("The check is open" when there is one check). */
  open: (open: number, total: number) => string
  /** The summary while checks run again. */
  checking: string
  /** The held primary's words: "Release · 2 checks open". */
  button: (action: string, open: number) => string
  /** The held primary's reason: "2 checks open: Lot released, Certificate valid". */
  held: (open: number, names: string) => string
  /** Joins the open checks' names in `held` ("A, B"). */
  join: (names: readonly string[]) => string
  /** No checks given. */
  none: string
}

export const CHECK_LIST_LABELS: CheckListLabels = {
  states: { pass: 'Done', warning: 'Warning', fail: 'Open', checking: 'Checking', skipped: 'Not needed', unknown: 'Unknown' },
  allPass: (total) => (total === 1 ? 'The check passes' : `All ${total} checks pass`),
  open: (open, total) => (total === 1 ? 'The check is open' : `${open} of ${total} checks open`),
  checking: 'Checking again…',
  button: (action, open) => `${action} · ${open} ${open === 1 ? 'check' : 'checks'} open`,
  held: (open, names) => `${open} ${open === 1 ? 'check' : 'checks'} open: ${names}`,
  join: (names) => names.join(', '),
  none: 'No checks',
}
