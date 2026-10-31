/**
 * FloorElapsed's rules (B-W2b-28, design part FloorElapsed): a count-up or count-down time at numeral size — a running
 * operation, an open help call, the time clocked in today, a break that ends.
 *
 * - **Up** (`since`): the time since a moment, plus `carriedMs` from earlier runs (a bundle handed back keeps its time).
 *   `paused` freezes it at `carriedMs`: the app passes the total so far.
 * - **Down** (`until`): the time left. Past zero it counts on as time OVER, said in words and in the danger tone —
 *   never a silent "0:00".
 * - The numeral: `m:ss` under an hour, `h:mm:ss` above (`seconds`), or hours and minutes with their units (`minutes`,
 *   the time clocked in). A screen reader hears minute-level words ("12 minutes"), so a live region changes once a
 *   minute, never every second.
 * - Tones rise with the time (`warnAfterMs`, `dangerAfterMs`); the part draws an icon and a word with every tone.
 */

export type ElapsedPrecision = 'seconds' | 'minutes'
export type ElapsedTone = 'neutral' | 'warning' | 'danger'

const S = 1000
const M = 60 * S

export interface ElapsedInput {
  /** Count up from this moment (epoch ms). */
  since?: number
  /** Count down to this moment (epoch ms). Wins over `since`. */
  until?: number
  /** Time already counted before `since` (earlier runs). */
  carriedMs?: number
  /** Frozen at `carriedMs` (up) or at the time left when paused (down: the app passes `carriedMs` = time left). */
  paused?: boolean
}

export interface ElapsedReading {
  /** Never negative. Down past zero: the time over. */
  ms: number
  /** A countdown that passed zero. */
  over: boolean
  /** Which way the numeral runs. */
  mode: 'up' | 'down'
}

const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** The time to show at `now`. A moment that is not a number reads as zero (the part shows "—" then). */
export function elapsedReading(input: ElapsedInput, now: number): ElapsedReading {
  const carried = finite(input.carriedMs) && input.carriedMs > 0 ? input.carriedMs : 0
  if (finite(input.until)) {
    if (input.paused) return { ms: carried, over: false, mode: 'down' }
    const left = input.until - now
    return left >= 0 ? { ms: left, over: false, mode: 'down' } : { ms: -left, over: true, mode: 'down' }
  }
  if (input.paused || !finite(input.since)) return { ms: carried, over: false, mode: 'up' }
  return { ms: carried + Math.max(0, now - input.since), over: false, mode: 'up' }
}

/** Whole hours, minutes and seconds. A countdown rounds its seconds UP, so it never reads 0:00 while time is left. */
export function elapsedParts(ms: number, mode: 'up' | 'down' = 'up'): { h: number; m: number; s: number } {
  const total = Math.max(0, mode === 'down' ? Math.ceil(ms / S) : Math.floor(ms / S))
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 }
}

const two = (n: number) => String(n).padStart(2, '0')

/** The clock form: "4:07", "12:30", "1:05:09". */
export function elapsedClock(ms: number, mode: 'up' | 'down' = 'up'): string {
  const { h, m, s } = elapsedParts(ms, mode)
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/** Hours and minutes for `minutes` precision: { h: 7, m: '42' } — the part writes each with its unit. */
export function elapsedHoursMinutes(ms: number): { h: number; m: string } {
  const minutes = Math.floor(Math.max(0, ms) / M)
  return { h: Math.floor(minutes / 60), m: two(minutes % 60) }
}

/** The `<time dateTime>` value: an ISO 8601 duration ("PT1H5M9S"). */
export function elapsedIsoDuration(ms: number, mode: 'up' | 'down' = 'up'): string {
  const { h, m, s } = elapsedParts(ms, mode)
  return `PT${h ? `${h}H` : ''}${h || m ? `${m}M` : ''}${s}S`
}

/** The whole minutes — the screen reader's step (its words change once a minute). */
export const elapsedMinute = (ms: number): number => Math.floor(Math.max(0, ms) / M)

export interface ElapsedWords {
  /** "1 minute" / "12 minutes". */
  minutes: (n: number) => string
  /** "1 hour" / "2 hours". */
  hours: (n: number) => string
  /** Under a minute. */
  underMinute: string
  /** Hours and minutes together: "1 hour 5 minutes". */
  join: (hours: string, minutes: string) => string
  /** A countdown past zero: "3 minutes over". */
  over: (time: string) => string
}

/** Minute-level words for a screen reader: "under a minute", "12 minutes", "1 hour 5 minutes", "2 minutes over". */
export function elapsedWords(reading: Pick<ElapsedReading, 'ms' | 'over'>, words: ElapsedWords): string {
  const minutes = elapsedMinute(reading.ms)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const time = minutes === 0 ? words.underMinute : h === 0 ? words.minutes(m) : m === 0 ? words.hours(h) : words.join(words.hours(h), words.minutes(m))
  return reading.over ? words.over(time) : time
}

export interface ElapsedThresholds {
  /** At or past this the tone is warning (a help call waiting 5 minutes). */
  warnAfterMs?: number
  /** At or past this the tone is danger. */
  dangerAfterMs?: number
}

/** The tone at a reading: a countdown past zero is danger; up counts rise through the thresholds. */
export function elapsedTone(reading: Pick<ElapsedReading, 'ms' | 'over' | 'mode'>, thresholds: ElapsedThresholds = {}): ElapsedTone {
  if (reading.over) return 'danger'
  if (reading.mode === 'down') return 'neutral'
  if (finite(thresholds.dangerAfterMs) && reading.ms >= thresholds.dangerAfterMs) return 'danger'
  if (finite(thresholds.warnAfterMs) && reading.ms >= thresholds.warnAfterMs) return 'warning'
  return 'neutral'
}

/** An ISO instant or epoch milliseconds as epoch ms; undefined when it is neither. */
export function elapsedMoment(at: string | number | null | undefined): number | undefined {
  if (at === null || at === undefined) return undefined
  const n = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(n) ? n : undefined
}
