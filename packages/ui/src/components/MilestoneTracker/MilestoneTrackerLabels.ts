import type { MilestoneShownState } from './milestoneTrackerModel'

/**
 * `MilestoneTracker`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a number
 * or a date in it is a function: the host writes its own plural forms. Step names and dates come written from the page.
 */
export interface MilestoneTrackerLabels {
  /** The list's name for a screen reader. */
  list: string
  /** Each step's state, said beside its mark. */
  states: Record<MilestoneShownState, string>
  /** A step done on a day: "Done · 3 Nov". */
  doneOn: (date: string) => string
  /** A step partly done: "Partly · 5 Nov". */
  partlyOn: (date: string) => string
  /** An estimate, never a promise: "Usually by 12 Nov". */
  usually: (date: string) => string
  /** "Step 3 of 6". */
  stepOf: (step: number, total: number) => string
  /** The promise date: "Promised for 14 Nov". */
  promised: (date: string) => string
  /** The promise moved: "Date moved 2 times" (opens the history). */
  moved: (count: number) => string
  /** The history's heading. */
  history: string
  /** One move: "3 Nov: 10 Nov → 14 Nov". */
  move: (on: string, from: string, to: string) => string
  /** The first date set: "3 Nov: set to 10 Nov". */
  set: (on: string, to: string) => string
}

export const MILESTONE_TRACKER_LABELS: MilestoneTrackerLabels = {
  list: 'Progress',
  states: { done: 'Done', partly: 'Partly', current: 'Now', todo: 'To come', skipped: 'Skipped' },
  doneOn: (date) => `Done · ${date}`,
  partlyOn: (date) => `Partly · ${date}`,
  usually: (date) => `Usually by ${date}`,
  stepOf: (step, total) => `Step ${step} of ${total}`,
  promised: (date) => `Promised for ${date}`,
  moved: (count) => (count === 1 ? 'Date moved once' : `Date moved ${count} times`),
  history: 'How the date moved',
  move: (on, from, to) => `${on}: ${from} → ${to}`,
  set: (on, to) => `${on}: set to ${to}`,
}
