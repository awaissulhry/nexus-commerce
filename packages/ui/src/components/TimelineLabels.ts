import type { AsOfLabels } from './AsOfLabels'

/** `Timeline`'s words (B-W2b-04). English by default; each step's time speaks through `asOf`. */
export interface TimelineLabels {
  /** Read before a warning step's label (screen reader only), so the tone is never told by colour alone. */
  needsAttention: string
  /** Read before a danger step's label (screen reader only). */
  problem: string
  /** A step that has not happened yet. */
  notYet: string
  /** The words of each step's time, passed to `AsOf`. */
  asOf: Partial<AsOfLabels>
}

export const TIMELINE_LABELS: TimelineLabels = {
  needsAttention: 'Needs attention: ',
  problem: 'Problem: ',
  notYet: 'not yet',
  asOf: {},
}
