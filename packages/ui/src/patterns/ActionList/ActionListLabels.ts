/**
 * `ActionList`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a number or
 * a value in it is a function: the host writes its own plural forms.
 */
export interface ActionListLabels {
  /** Nothing waits. */
  empty: string
  /** A group's count beside its heading: "3 to do". */
  groupCount: (count: number) => string
  /** A request past its due: "Overdue since 3 Nov" (the date written by the app), or "Overdue". */
  overdue: (date?: string) => string
  /** The live countdown's words: "Due in 5 h" (the time left, in the Countdown's units). */
  dueIn: (left: string) => string
  /** The countdown at zero. */
  dueNow: string
  /** A request due later: "Due 12 Nov". */
  dueOn: (date: string) => string
  /** Takes back a request just marked done. */
  undo: string
  /** A verb that is running: what its held button says. */
  busy: string
}

export const ACTION_LIST_LABELS: ActionListLabels = {
  empty: 'Nothing waits for you.',
  groupCount: (count) => `${count} to do`,
  overdue: (date) => (date ? `Overdue since ${date}` : 'Overdue'),
  dueIn: (left) => `Due in ${left}`,
  dueNow: 'Due now',
  dueOn: (date) => `Due ${date}`,
  undo: 'Undo',
  busy: 'Working…',
}
