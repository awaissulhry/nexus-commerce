/**
 * NAF.SB.ACT.S4R — the day a row belongs to, and the clock printed on it, must
 * describe the SAME local instant.
 *
 * They did not. `dayKey` was `new Date(iso).toISOString().slice(0, 10)` — a UTC
 * calendar date — while the row's clock came from `toLocaleTimeString`, a local
 * one. Measured in a browser at UTC+2 before this module existed:
 *
 *   2026-08-06T23:30:00Z  →  filed under "Thursday 6 August", printed "01:30"
 *
 * which is 7 August where the reader is sitting. Any event between 22:00 and
 * 24:00 UTC lands under a header that contradicts its own timestamp by a day.
 *
 * The fleet has never produced an event in that window, so nothing on screen is
 * wrong today and nothing in a screenshot would have shown it. It is a
 * well-documented bug class with exactly this root cause — ccusage #349,
 * litellm #29568 — and it appears the first night a run lands late.
 *
 * Extracted here because the fix is arithmetic, not appearance: a browser pass
 * cannot see a bug whose trigger does not exist in the data, but a test can.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The LOCAL calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Local on purpose, and it must stay local: this key picks the header that sits
 * directly above a clock rendered in the reader's own zone, and two halves of
 * one line may not disagree about which day it is.
 */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * `HH:MM` in the reader's zone — the other half of the pair above.
 *
 * Explicitly 24-hour, which is a product decision rather than a default. Left
 * to the locale it returns `01:30 AM` on an en-US machine: eight characters
 * with a suffix, in a gutter the eye is supposed to run straight down. A log
 * surface prints a 24-hour clock so every row is exactly five characters wide
 * and no row carries a word. (Caught by a unit test, not by looking — this
 * machine's browser renders `01:30` and would never have shown it.)
 */
export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

/**
 * "Today" · "Yesterday" · "Thursday 6 August".
 *
 * `now` is injectable so the boundary can be tested rather than waited for.
 * Both comparisons are on the same local basis as `dayKey`; when they were UTC
 * and the key was UTC they agreed with each other and disagreed with the clock,
 * which is the quietest way for this to be wrong.
 */
export function dayLabel(key: string, now: Date = new Date()): string {
  const todayKey = dayKey(now.toISOString())
  const yesterdayKey = dayKey(new Date(now.getTime() - 86_400_000).toISOString())
  if (key === todayKey) return 'Today'
  if (key === yesterdayKey) return 'Yesterday'
  // Parsed as LOCAL midnight (no trailing Z) so the label names the same day the
  // key does. `new Date('2026-08-07T00:00:00Z')` is 6 August in the Americas.
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/** "6 August" — for prose, where a weekday adds nothing. */
export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}
