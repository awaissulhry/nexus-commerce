/**
 * `Countdown`'s words (B-W2b-04). English by default; the props `label` and `doneLabel` still win over `in` and `now`.
 * The time left is counted by `countdownTicker.ts` ("14 s", "3 min", "3 h", "2 d"); its unit letters are said here.
 */
export interface CountdownLabels {
  /** The words around the time left: "in 14 s". */
  in: (left: string) => string
  /** Shown from zero on. */
  now: string
  /** The unit letters after the number. */
  second: string
  minute: string
  hour: string
  day: string
}

export const COUNTDOWN_LABELS: CountdownLabels = {
  in: (left) => `in ${left}`,
  now: 'now',
  second: 's',
  minute: 'min',
  hour: 'h',
  day: 'd',
}

const UNIT = /^(\d+) (s|min|h|d)$/
const UNIT_KEY = { s: 'second', min: 'minute', h: 'hour', d: 'day' } as const

/** The ticker's time left ("3 h", "2 d") with its unit in these words ("2 g" for an Italian host). */
export function countdownWords(text: string, words: Pick<CountdownLabels, 'second' | 'minute' | 'hour' | 'day'>): string {
  const m = UNIT.exec(text)
  return m ? `${m[1]} ${words[UNIT_KEY[m[2] as keyof typeof UNIT_KEY]]}` : text
}
