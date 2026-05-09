/**
 * Shared relative-time formatter for the /fulfillment/stock tree.
 *
 * Replaces the per-file copies that hardcoded "Xs ago" / "Xm ago"
 * etc. — those broke i18n for Italian operators reading the cycle-
 * count list, transfer log, reservation list, MCF dashboard, etc.
 *
 * Caller passes the translation function (`t` from useTranslations).
 * Returns a localized "Xs ago" string, falling back to the browser
 * locale's date for anything older than 30 days.
 */

type TFn = (k: string, vars?: Record<string, string | number>) => string

export function formatRelative(iso: string, t: TFn): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return t('time.now')
  const s = Math.floor(ms / 1000)
  if (s < 60) return t('time.secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('time.daysAgo', { n: d })
  return new Date(iso).toLocaleDateString()
}
