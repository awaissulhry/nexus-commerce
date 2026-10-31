import type { ElapsedWords } from './floorElapsedModel'

/**
 * `FloorElapsed`'s words (B-W2b-28). English by default; a host passes the words it translates. A word with a number in
 * it is a function: the host writes its own plural forms.
 */
export interface FloorElapsedLabels extends ElapsedWords {
  /** Shown beside a frozen time. */
  paused: string
  /** Shown beside a countdown past zero. */
  overWord: string
  /** The unit after the hours in `minutes` precision ("7 h 42 min"). */
  hourUnit: string
  /** The unit after the minutes in `minutes` precision. */
  minuteUnit: string
}

export const FLOOR_ELAPSED_LABELS: FloorElapsedLabels = {
  minutes: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
  hours: (n) => (n === 1 ? '1 hour' : `${n} hours`),
  underMinute: 'under a minute',
  join: (hours, minutes) => `${hours} ${minutes}`,
  over: (time) => `${time} over`,
  paused: 'Paused',
  overWord: 'Over',
  hourUnit: 'h',
  minuteUnit: 'min',
}
