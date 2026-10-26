/**
 * Reviews › channel pages — one channel, or one market of it (build spec §3.5, PR F; the Listings path-lock pattern,
 * `listings/_readiness/readinessScope.ts`). `/marketing/reviews/amazon`, `/marketing/reviews/amazon/it`,
 * `/marketing/reviews/ebay`, `/marketing/reviews/ebay/de`: the path names the channel (and the market); the page has no
 * channel or market filter, and every link it writes to the Inbox, Requests or Insights carries the lock
 * (`?channel=&market=`). Shopify and Etsy pages come in Phase 3.
 *
 * Pure — no React, no fetch — so every mapping is a test (reviewsScope.vitest.test.ts).
 */
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'

export type ReviewsChannel = 'AMAZON' | 'EBAY'
export const REVIEWS_CHANNELS: readonly ReviewsChannel[] = ['AMAZON', 'EBAY']

export interface ReviewsLock {
  channel: ReviewsChannel
  /** Upper case (`IT`, `UK`); `''` = every market of the channel. */
  marketplace: string
}

const CHANNEL_WORDS: Record<ReviewsChannel, string> = { AMAZON: 'Amazon', EBAY: 'eBay' }
export const channelWord = (channel: ReviewsChannel): string => CHANNEL_WORDS[channel]
export const marketWord = (code: string): string => COUNTRY_NAMES[code] ?? code

/** A market in an address: two letters, upper case; `GB` is the UK (as on the Listings pages). Anything else → null. */
export function marketOfSegment(segment: string | null | undefined): string | null {
  if (!segment || !/^[a-z]{2}$/i.test(segment)) return null
  const code = segment.toUpperCase()
  return code === 'GB' ? 'UK' : code
}

/** `/marketing/reviews/<channel>/<market>`: the lock, or null when the market is not two letters (the page 404s). */
export function lockOf(channel: ReviewsChannel, segment: string): ReviewsLock | null {
  const marketplace = marketOfSegment(segment)
  return marketplace ? { channel, marketplace } : null
}

const CHANNEL_PATH = /^\/marketing\/reviews\/(amazon|ebay)(?:\/([^/]+))?$/

/** The channel page a (business-free) path shows, or undefined for any other page. */
export function reviewsLockFromPath(pathname: string): ReviewsLock | undefined {
  const match = CHANNEL_PATH.exec(pathname.split(/[?#]/)[0].replace(/\/+$/, ''))
  if (!match) return undefined
  const channel = match[1].toUpperCase() as ReviewsChannel
  if (match[2] === undefined) return { channel, marketplace: '' }
  return lockOf(channel, match[2]) ?? undefined
}

/** The filters a lock fixes: the channel always, the market on a market page. */
export function lockedKeys(lock: ReviewsLock): ReadonlyArray<'channel' | 'market'> {
  return lock.marketplace ? ['channel', 'market'] : ['channel']
}

/** The page's own path: `/marketing/reviews/amazon`, `/marketing/reviews/amazon/it`. */
export function channelPath(lock: ReviewsLock): string {
  const base = `/marketing/reviews/${lock.channel.toLowerCase()}`
  return lock.marketplace ? `${base}/${lock.marketplace.toLowerCase()}` : base
}

/** What a link from the page carries: the channel, and the market on a market page. */
export function lockParams(lock: ReviewsLock): { channel: ReviewsChannel; market: string | null } {
  return { channel: lock.channel, market: lock.marketplace || null }
}

/** The page's title: "Amazon Italy", "eBay". */
export function scopeTitleWords(lock: ReviewsLock): string {
  return lock.marketplace ? `${channelWord(lock.channel)} ${marketWord(lock.marketplace)}` : channelWord(lock.channel)
}

/** The browser tab: "Amazon Italy · Reviews". */
export const scopeTitle = (lock: ReviewsLock): string => `${scopeTitleWords(lock)} · Reviews`
