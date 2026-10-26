/**
 * Reviews area — the words every Reviews page uses for themes, moods, triage statuses, channels with their markets,
 * and star counts. One place, so a theme or a status reads the same on the Overview, the Inbox and the Insights pages.
 * Pure (no React), tested in reviewWords.vitest.test.ts.
 */
import { channelLabel } from '@/app/listings/_readiness/marketChips'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'

/** Review themes (ReviewSentiment.categories), in the words the boards use. */
export const THEME_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit & sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}

/** A theme key in words; an unknown key is shown as it is. */
export function themeWord(key: string): string {
  return THEME_LABEL[key] ?? key
}

/** Review mood (ReviewSentiment.label). */
export const MOOD_WORD: Record<string, string> = {
  POSITIVE: 'Positive',
  NEUTRAL: 'Neutral',
  NEGATIVE: 'Negative',
}

/** Triage status (Review.triageStatus). A review with no status yet is New. */
export const STATUS_WORD: Record<string, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  RESPONDED: 'Responded',
  RESOLVED: 'Resolved',
  IGNORED: 'Ignored',
}

/** A triage status in words; none yet reads New. */
export function statusWord(status: string | null | undefined): string {
  return status ? STATUS_WORD[status] ?? status : STATUS_WORD.NEW
}

/**
 * A channel with its market: "Amazon Italy" (long, the default) or "Amazon IT" (short, for a grid cell). No market →
 * the channel alone ("Shopify"). An unknown market code is shown as its code.
 */
export function channelMarketWords(channel: string, market?: string | null, form: 'long' | 'short' = 'long'): string {
  const name = channelLabel(channel)
  const code = market?.trim().toUpperCase()
  if (!code) return name
  return `${name} ${form === 'short' ? code : COUNTRY_NAMES[code] ?? code}`
}

/** "1 star", "4 stars", "4.5 stars"; no rating → "No rating". */
export function starsWord(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'No rating'
  const value = Math.round(n * 10) / 10
  return `${value.toLocaleString('en')} ${value === 1 ? 'star' : 'stars'}`
}
