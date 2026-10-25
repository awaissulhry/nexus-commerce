/**
 * Listings — one store, or one market of a store (2026-10-24, docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
 *
 * The menu's store pages (`/listings/amazon`, `/listings/amazon/it`, `/listings/ebay`, `/listings/ebay/de`,
 * `/listings/shopify`, `/listings/etsy`) are the Listings page with a lock: the path names the store (and the market), no filter, saved
 * view or link moves the page away from it, and every link the page writes keeps it. The old store pages are
 * `/listings/legacy/<store>[/<market>]`; Etsy never had one (2026-10-25: its page is new).
 *
 * Pure — no React, no fetch — so every mapping is a test.
 */
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'

export type ReadinessStore = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'

export interface ReadinessLock {
  channel: ReadinessStore
  /** Upper case (`IT`, `UK`); `''` = every market of the store. Shopify and Etsy have no market pages, so never one here. */
  marketplace: string
}

const STORE_WORDS: Record<ReadinessStore, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }
export const storeWord = (channel: ReadinessStore): string => STORE_WORDS[channel]
export const marketWord = (code: string): string => COUNTRY_NAMES[code] ?? code

/**
 * A market in an address: two letters, upper case. `GB` is the UK: the readiness index and the menu say `UK`, and the
 * "See all markets" window links the codes older eBay listings carry, `GB` among them.
 */
export function marketOfSegment(segment: string): string | null {
  if (!/^[a-z]{2}$/i.test(segment)) return null
  const code = segment.toUpperCase()
  return code === 'GB' ? 'UK' : code
}

const STORE_PATH = /^\/listings\/(amazon|ebay|shopify|etsy)(?:\/([^/]+))?$/

/**
 * The Listings page a path shows: a lock, `null` for `/listings` itself, `undefined` for any other page
 * (`/listings/legacy…`, `/listings/publish-status`, `/listings/ebay/campaigns`, …). The path is the business-free one
 * (`@/lib/workspaces/navigation`'s `usePathname`).
 */
export function readinessLockFromPath(pathname: string): ReadinessLock | null | undefined {
  if (pathname === '/listings') return null
  const match = STORE_PATH.exec(pathname)
  if (!match) return undefined
  const channel = match[1].toUpperCase() as ReadinessStore
  if (match[2] === undefined) return { channel, marketplace: '' }
  if (channel === 'SHOPIFY' || channel === 'ETSY') return undefined
  const marketplace = marketOfSegment(match[2])
  return marketplace ? { channel, marketplace } : undefined
}

/** The filters a lock fixes. Shopify's Market is fixed too: it has one. */
export function lockedKeys(lock: ReadinessLock | null): ReadonlyArray<'channel' | 'marketplace'> {
  if (!lock) return []
  return lock.marketplace || lock.channel === 'SHOPIFY' ? ['channel', 'marketplace'] : ['channel']
}

/** The page's own path: `/listings`, `/listings/amazon`, `/listings/amazon/it`. */
export function readinessPath(lock: ReadinessLock | null): string {
  if (!lock) return '/listings'
  const store = `/listings/${lock.channel.toLowerCase()}`
  return lock.marketplace ? `${store}/${lock.marketplace.toLowerCase()}` : store
}

/**
 * The old page for the same store and market (`/listings/legacy/amazon/it`); the old Listings page with no lock. Etsy
 * never had an old page of its own: the old Listings page, Etsy only.
 */
export function legacyPath(lock: ReadinessLock | null): string {
  if (lock?.channel === 'ETSY') return `/listings/legacy?${new URLSearchParams({ channel: 'ETSY' })}`
  return lock ? readinessPath(lock).replace(/^\/listings/, '/listings/legacy') : '/listings/legacy'
}

/** The header: the page's title and the crumbs above it, each a link (the title is the page itself). */
export interface ScopeWords {
  title: string
  crumbs: Array<{ label: string; href: string }>
}
export function scopeWords(lock: ReadinessLock | null): ScopeWords {
  if (!lock) return { title: 'Listings', crumbs: [] }
  const store = storeWord(lock.channel)
  if (!lock.marketplace) return { title: store, crumbs: [{ label: 'Listings', href: '/listings' }] }
  return {
    title: `${store} ${marketWord(lock.marketplace)}`,
    crumbs: [{ label: 'Listings', href: '/listings' }, { label: store, href: readinessPath({ channel: lock.channel, marketplace: '' }) }],
  }
}

/** The browser tab: "Amazon Italy · Listings". */
export const scopeTitle = (lock: ReadinessLock | null): string => (lock ? `${scopeWords(lock).title} · Listings` : 'Listings')

/**
 * "on N markets": one per store and market. An account or an alias is its own destination (its own chip), not a
 * market of its own — eBay IT with an alias is one market.
 */
export function marketCount(destinations: ReadonlyArray<{ channel: string; marketplace: string }>): number {
  return new Set(destinations.filter((d) => d.channel !== 'SHARED').map((d) => `${d.channel}:${d.marketplace}`)).size
}

/**
 * What Amazon's defect report says is suppressed (`GET /api/listings/amazon/overview` → `activeSuppressions`, at most
 * 50 rows): how many listings, and how many on each market, in menu order. A listing with two defects is one listing.
 */
export function suppressedListings(rows: ReadonlyArray<{ listingId: string; listing: { marketplace: string } }>, limit = 50): {
  count: number
  /** The answer was cut at `limit` rows: there may be more. */
  more: boolean
  markets: Array<{ code: string; count: number }>
} {
  const byMarket = new Map<string, Set<string>>()
  for (const row of rows) {
    const code = row.listing.marketplace.toUpperCase()
    byMarket.set(code, (byMarket.get(code) ?? new Set()).add(row.listingId))
  }
  const markets = [...byMarket].map(([code, ids]) => ({ code, count: ids.size })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
  return { count: new Set(rows.map((r) => r.listingId)).size, more: rows.length >= limit, markets }
}

/* ── Links to a listing's live state: the old pages ─────────────────────────────────────────────────────────────── */

/** A SKU's listings on one store, live status and all: the old Listings page, every market of that store. */
export const legacySkuHref = (channel: string, sku: string): string =>
  `/listings/legacy?${new URLSearchParams({ channel: channel.toUpperCase(), search: sku })}`

/**
 * One store's listings on one market, live status and all. Amazon and eBay have an old page per market
 * (`/listings/legacy/amazon/it`); every other store opens the old Listings page with the same filters. The market is
 * the listing's own code (the old pages read listings, not the readiness index), so `GB` stays `GB`.
 */
export function legacyMarketHref(channel: string, marketplace: string): string {
  const store = channel.toLowerCase()
  if ((store === 'amazon' || store === 'ebay') && marketplace) return `/listings/legacy/${store}/${encodeURIComponent(marketplace.toLowerCase())}`
  return `/listings/legacy?${new URLSearchParams({ channel, marketplace })}`
}
