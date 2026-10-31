/**
 * The words of `ReviewChangesModal` and its body `ReviewChangesPanel` (B-W2b-04). English by default; the props
 * `title`, `saveLabel`, `ackLabel`, `doneVerb` and `doneLine` still win where they apply. The verbs the Done line counts
 * under ("saved", "archived") are the host's: `doneVerb` and each result's `verb`, in the person's language.
 */
export interface ReviewChangesLabels {
  /** The title (when no `title` is passed): "Review 3 changes". */
  title: (count: number) => string
  /** Save (when no `saveLabel` is passed): "Save 3 changes". */
  save: (count: number) => string
  /** Save while saving, without a count. */
  saving: string
  /** Save while saving, with one: "Saving 2 of 3…". */
  savingOf: (done: number, count: number) => string
  cancel: string
  /** The Done screen's title and button; also a Result that would only repeat the New column. */
  done: string
  undo: string
  undoing: string
  /** Why Save is held, by cause. */
  heldReading: string
  heldFailed: string
  heldSaving: string
  heldSaved: string
  heldNothing: string
  heldProblem: string
  heldProblems: string
  heldTick: string
  /** The tick for a change that lets automation do more (when no `ackLabel` is passed). */
  ack: (raises: number) => string
  /** The table's columns. */
  where: string
  what: string
  now: string
  /** The "New" column: the value Save writes. */
  next: string
  result: string
  note: string
  /** Said for the → between Now and New (screen reader only). */
  to: string
  /** The Note of a change that lets automation do more and has no note of its own. */
  raiseNote: string
  /** The Done line: "3 saved". */
  counted: (count: number, verb: string) => string
  /** The Done line's failures: "1 not saved". */
  notCounted: (count: number, verb: string) => string
  /** The Done line when nothing went through: "Nothing saved". */
  nothing: (verb: string) => string
  /** …and how many did not: "2 changes not saved". */
  changesNot: (count: number, verb: string) => string
  /** The table's name once done: "What was saved". */
  whatWas: (verb: string) => string
  /** The line while today's values are re-read. */
  reading: string
  /** The failed re-read's banner. */
  failedTitle: string
  failedBody: string
  tryAgain: string
  /** Values that changed since the draft was made. */
  conflictsTitle: string
  conflict: (label: string, was: string, now: string) => string
  /** Problems that hold Save. */
  problemsTitle: string
  /** The dialog's close button. */
  close: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const REVIEW_CHANGES_LABELS: ReviewChangesLabels = {
  title: (count) => `Review ${plural(count, 'change')}`,
  save: (count) => `Save ${plural(count, 'change')}`,
  saving: 'Saving…',
  savingOf: (done, count) => `Saving ${done} of ${count}…`,
  cancel: 'Cancel',
  done: 'Done',
  undo: 'Undo',
  undoing: 'Undoing…',
  heldReading: 'Reading today\'s values first',
  heldFailed: 'Today\'s values could not be read',
  heldSaving: 'Saving',
  heldSaved: 'Already saved',
  heldNothing: 'Nothing to save',
  heldProblem: 'Fix the problem first',
  heldProblems: 'Fix the problems first',
  heldTick: 'Tick the box first',
  ack: (raises) => raises === 1
    ? 'I understand this change lets automation do more, from its next run.'
    : `I understand these ${raises} changes let automation do more, from their next run.`,
  where: 'Where',
  what: 'What',
  now: 'Now',
  next: 'New',
  result: 'Result',
  note: 'Note',
  to: ' to ',
  raiseNote: 'Lets automation do more',
  counted: (count, verb) => `${count} ${verb}`,
  notCounted: (count, verb) => `${count} not ${verb}`,
  nothing: (verb) => `Nothing ${verb}`,
  changesNot: (count, verb) => `${plural(count, 'change')} not ${verb}`,
  whatWas: (verb) => `What was ${verb}`,
  reading: 'Reading today\'s values, so “Now” is true. Save waits for it.',
  failedTitle: 'Save is held',
  failedBody: 'Nexus reads them again before it saves, so it never overwrites a value it has not shown you.',
  tryAgain: 'Try again',
  conflictsTitle: 'Changed since you opened this page',
  conflict: (label, was, now) => `${label}: was ${was}, now ${now}`,
  problemsTitle: 'Fix these before you save',
  close: 'Close',
}
