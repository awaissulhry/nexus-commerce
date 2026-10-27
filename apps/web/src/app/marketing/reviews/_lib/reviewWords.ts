/**
 * Reviews area — the words every Reviews page uses for themes, moods, triage statuses, channels with their markets,
 * and star counts. One place, so a theme or a status reads the same on the Overview, the Inbox and the Insights pages.
 * Pure (no React), tested in reviewWords.vitest.test.ts.
 */
import { channelLabel } from '@/app/listings/_readiness/marketChips'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'

/**
 * Nexus e-mails no eBay buyer (Owner, 2026-10-27): eBay's rules restrict contacting buyers outside eBay, and eBay asks
 * its buyers for feedback itself. The API's words (review-queue-words.ts EBAY_RULE_WORDS / EBAY_ASKS_WORDS).
 */
export const EBAY_NOT_EMAILED = 'eBay buyers are not e-mailed — eBay asks its buyers for feedback itself, so no rule can e-mail them.'
export const EBAY_ASKS_WORDS = 'Not sent — eBay asks the buyer for feedback itself'

/** A review rate no review can follow yet: the API's words start with this (review-rate.service.ts). */
export const NOT_MEASURABLE = 'Not measurable'

/**
 * Whether a review rate is "Not measurable" (requests went out, but no review that could follow them is in Nexus): the
 * rate is null and the API said why. The tile, table and grid then say "Not measurable", never "0.0%" or a bare "—"
 * (live audit A02); "—" stays for "nothing sent".
 */
export function rateNotMeasurable(rate: number | null | undefined, why: string | null | undefined): boolean {
  return rate == null && !!why && why.startsWith(NOT_MEASURABLE)
}

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
  const code = marketCodeOf(market)
  if (!code) return name
  return `${name} ${form === 'short' ? code : COUNTRY_NAMES[code] ?? code}`
}

/**
 * A stored market as a two-letter code: some channels store their own site names ("EBAY-IT", "EBAY_DE"; eBay's account-
 * wide "EBAY-GLOBAL" is no market at all). Live audit D01: "eBay EBAY-GLOBAL" on the order tab. Anything else as it is.
 */
export function marketCodeOf(market: string | null | undefined): string | null {
  const code = market?.trim().toUpperCase() ?? ''
  if (!code) return null
  const site = /^(?:EBAY|AMAZON|ETSY|SHOPIFY)[-_ ]([A-Z]+)$/.exec(code)
  if (site) return site[1] === 'GLOBAL' || site[1] === 'ALL' ? null : site[1] === 'GB' ? 'UK' : site[1]
  return code === 'GLOBAL' ? null : code
}

/** A stored product-type code in words: "OUTERWEAR" → "Outerwear", "AUTO_ACCESSORY" → "Auto accessory" (live audit D01). */
export function productTypeWords(code: string | null | undefined): string {
  const words = (code ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/** "1 star", "4 stars", "4.5 stars"; no rating → "No rating". */
export function starsWord(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'No rating'
  const value = Math.round(n * 10) / 10
  return `${value.toLocaleString('en')} ${value === 1 ? 'star' : 'stars'}`
}

/**
 * eBay feedback in words (stored as 5 = positive, 3 = neutral, 1 = negative): eBay counts positive, neutral and negative
 * feedback, never stars, so no page draws eBay feedback as stars (live audit B02).
 */
export function feedbackWords(rating: number | null): { text: string; tone: 'success' | 'neutral' | 'danger' } {
  if (rating == null) return { text: 'Feedback', tone: 'neutral' }
  if (rating >= 4) return { text: 'Positive feedback', tone: 'success' }
  if (rating <= 2) return { text: 'Negative feedback', tone: 'danger' }
  return { text: 'Neutral feedback', tone: 'neutral' }
}

/** Whether a channel's ratings are feedback types, not stars (eBay). */
export function ratedAsFeedback(channel: string | null | undefined): boolean {
  return (channel ?? '').toUpperCase() === 'EBAY'
}
