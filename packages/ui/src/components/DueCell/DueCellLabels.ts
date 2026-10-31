/**
 * `DueCell`'s words (B-W2b-28). English by default; a host passes the words it translates. A word with a number in it is
 * a function: the host writes its own plural forms.
 */
export interface DueCellLabels {
  /** Late: "Overdue by 3 days". */
  overdue: (days: number) => string
  /** Today. */
  today: string
  /** Soon: "Due in 12 days". */
  dueIn: (days: number) => string
  /** Later: "Valid until 12 Mar 2027". */
  validUntil: (date: string) => string
  /** Required, nothing on record. */
  needed: string
  /** Done, no date known. */
  done: string
  /** Done on a date: "Done 3 Nov 2026". */
  doneOn: (date: string) => string
  /** No date, nothing required. */
  none: string
}

export const DUE_CELL_LABELS: DueCellLabels = {
  overdue: (days) => (days === 1 ? 'Overdue by 1 day' : `Overdue by ${days} days`),
  today: 'Due today',
  dueIn: (days) => (days === 1 ? 'Due tomorrow' : `Due in ${days} days`),
  validUntil: (date) => `Valid until ${date}`,
  needed: 'Needed',
  done: 'Done',
  doneOn: (date) => `Done ${date}`,
  none: '—',
}
