/**
 * "checked 2 min ago" — the age of a readiness check in short words. The exact time goes in the hover title
 * (`absoluteTime`). Pure: `now` is a parameter, so every boundary is a test.
 */
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const age = now - at
  // A clock a little ahead of ours is "just now", not "in 3 seconds".
  if (age < 45_000) return 'just now'
  if (age < 90_000) return '1 min ago'
  if (age < 45 * MIN) return `${Math.round(age / MIN)} min ago`
  if (age < 90 * MIN) return '1 h ago'
  if (age < 22 * HOUR) return `${Math.round(age / HOUR)} h ago`
  if (age < 36 * HOUR) return 'yesterday'
  if (age < 26 * DAY) return `${Math.round(age / DAY)} days ago`
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The exact time, for a title attribute. */
export function absoluteTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : undefined
}
