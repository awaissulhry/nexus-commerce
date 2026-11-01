import type { DayWords } from './dayStripModel'

/**
 * `DayStrip`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface DayStripLabels extends DayWords {
  /** The heading of the day in words, when shown on screen. */
  textTitle: string
  /** The key's name for a screen reader. */
  legend: string
  /** The shift band in the key. */
  shiftKey: string
  /** The anomaly mark in the key. */
  anomalyKey: string
}

export const DAY_STRIP_LABELS: DayStripLabels = {
  kinds: { work: 'Worked', break: 'Break', absence: 'Absence', overtime: 'Overtime', idle: 'No scans' },
  events: {
    in: 'Clock-in',
    out: 'Clock-out',
    'auto-out': 'Automatic clock-out',
    manual: 'Manual entry',
    'forgot-badge': 'Forgot-badge PIN',
    other: 'Event',
  },
  shift: (from, to) => `Shift ${from}–${to}`,
  span: (what, from, to) => `${what} ${from}–${to}`,
  at: (what, time) => `${what} at ${time}`,
  flagged: 'flagged for a check',
  anomaly: 'Anomaly',
  textTitle: 'The day in words',
  legend: 'Key',
  shiftKey: 'Shift',
  anomalyKey: 'Anomaly',
}
