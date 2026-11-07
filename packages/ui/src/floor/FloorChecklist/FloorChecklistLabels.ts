import type { ChecklistGroupState, FloorChecklistWords } from './floorChecklistModel'

/**
 * `FloorChecklist`'s words (B-W2b-78). English by default; a host passes the words it translates. A word with a name or
 * a number in it is a function. The reason tiles' own words come through `reasonWords` (the ReasonGrid's).
 */
export interface FloorChecklistLabels extends FloorChecklistWords {
  /** The group strip's name for a screen reader. */
  groups: string
  /** Each group's state, said beside its name. */
  states: Record<ChecklistGroupState, string>
  /** A check's answer. */
  passed: string
  failed: string
  notChecked: string
  /** "Failed: Label missing". */
  failedBecause: (reason: string) => string
  /** A failed check with a photo. */
  withPhoto: string
  /** A check that may be left. */
  optional: string
  pass: string
  fail: string
  /** "Group passes": every check not answered yet passes. */
  groupPasses: string
  /** Why Group passes is held: nothing left to answer. */
  groupAnswered: string
  /** "2 of 4 groups done". */
  progress: (done: number, total: number) => string
  /** "3 of 5 checked". */
  checked: (answered: number, total: number) => string
  /** "1 failed". */
  failedCount: (count: number) => string
  /** The fail step's question: "What is wrong with “Care label”?". */
  whatIsWrong: (item: string) => string
  /** The reason tiles' name. */
  reasons: string
  /** The photo step's question: "Take a photo of “Care label”". */
  photo: (item: string) => string
  /** The photo step when a photo is a must. */
  photoNeeded: string
  /** Leave the photo out (when it is not a must). */
  skipPhoto: string
  back: string
  cancel: string
  /** Said once after a tap: "Care label: passed". */
  announcePass: (item: string) => string
  announceFail: (item: string) => string
  /** "Labels: 4 checks passed". */
  announceGroup: (group: string, count: number) => string
}

export const FLOOR_CHECKLIST_LABELS: FloorChecklistLabels = {
  groups: 'Groups',
  states: { open: 'Not started', partly: 'In progress', passed: 'Passed', failed: 'Failed' },
  passed: 'Passed',
  failed: 'Failed',
  notChecked: 'Not checked',
  failedBecause: (reason) => `Failed: ${reason}`,
  withPhoto: 'with photo',
  optional: 'Optional',
  pass: 'Pass',
  fail: 'Fail',
  groupPasses: 'Group passes',
  groupAnswered: 'Every check in this group is answered',
  progress: (done, total) => `${done} of ${total} groups done`,
  checked: (answered, total) => `${answered} of ${total} checked`,
  failedCount: (count) => `${count} failed`,
  whatIsWrong: (item) => `What is wrong with “${item}”?`,
  reasons: 'Reasons',
  photo: (item) => `Take a photo of “${item}”`,
  photoNeeded: 'This reason needs a photo',
  skipPhoto: 'No photo',
  back: 'Back',
  cancel: 'Cancel',
  announcePass: (item) => `${item}: passed`,
  announceFail: (item) => `${item}: failed`,
  announceGroup: (group, count) => (count === 1 ? `${group}: 1 check passed` : `${group}: ${count} checks passed`),
  left: (count, names) => `${count === 1 ? '1 required check left' : `${count} required checks left`}: ${names.join(', ')}`,
  none: 'No checks are listed',
}
