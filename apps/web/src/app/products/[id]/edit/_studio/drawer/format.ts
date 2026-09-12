/**
 * PES.4 — shared display formatters for the drawer panes.
 *
 * Small, but shared deliberately: a second copy of `when()` in a second pane is how two surfaces
 * end up printing the same instant two ways, and it is the same duplication #307 was about at a
 * larger scale. One definition, so History and Listings cannot disagree about what a timestamp
 * looks like.
 */

/** An instant, in the viewer's locale. Returns the raw string unchanged if it will not parse. */
export function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * How long ago, in words — "7 weeks ago".
 *
 * Uses `Intl.RelativeTimeFormat` rather than a hand-rolled ladder so the wording is the platform's
 * in every locale. Future instants read "in 3 minutes" rather than being clamped to "just now": a
 * timestamp ahead of the clock means clock skew or a bad row, and hiding that would make a broken
 * value look like a fresh one.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const delta = t - now
  const abs = Math.abs(delta)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < MINUTE) return rtf.format(Math.round(delta / 1000), 'second')
  if (abs < HOUR) return rtf.format(Math.round(delta / MINUTE), 'minute')
  if (abs < DAY) return rtf.format(Math.round(delta / HOUR), 'hour')
  if (abs < WEEK) return rtf.format(Math.round(delta / DAY), 'day')
  // 13 weeks, not 4 (#347). Weeks are the right unit for sync staleness — "7 weeks ago" says how
  // stale, where "2 months ago" rounds the answer away. Verified at the boundary: a 3-month gap
  // still reads "3 months ago", not "13 weeks ago".
  if (abs < 13 * WEEK) return rtf.format(Math.round(delta / WEEK), 'week')
  if (abs < 365 * DAY) return rtf.format(Math.round(delta / (30 * DAY)), 'month')
  return rtf.format(Math.round(delta / (365 * DAY)), 'year')
}

/**
 * The over-cap sentence, naming the source that imposed the cap (DS1-25 / #426).
 *
 * 🔴 "over the channel cap" was hardcoded on both drawer surfaces while the reading carried
 * `capFrom` all along. On a master scope there is no channel at all, so the phrase asserted a
 * source that did not exist; on a channel scope it named the wrong granularity — the binding cap
 * comes from a specific marketplace ("Amazon · DE"), not from "the channel" in general.
 *
 * Where `capFrom` is absent, it says **source not stated** rather than inventing one. DS.1's
 * wording, kept verbatim so the three surfaces (validator, mark, drawer) read alike. Absent does
 * not occur on any scope measured so far — which is exactly why it must not fall back to a
 * plausible guess: the first time it happens, nobody will be looking.
 */
export function overCapNote(capFrom: string | null | undefined): string {
  return capFrom ? ` — over the ${capFrom} cap` : ' — over the cap (source not stated)'
}
