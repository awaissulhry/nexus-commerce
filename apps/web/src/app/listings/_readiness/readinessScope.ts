/**
 * Listings — one store, or one market of a store (2026-10-24, docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
 *
 * The menu's store pages (`/listings/amazon`, `/listings/amazon/it`, `/listings/ebay`, `/listings/ebay/de`,
 * `/listings/shopify`, `/listings/etsy`) are the Listings page with a lock: the path names the store (and the market), no filter, saved
 * view or link moves the page away from it, and every link the page writes keeps it. The old pages
 * (`/listings/legacy[/<store>[/<market>]]`) are gone since the legacy exit (step 8 of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md); their addresses send here (`next.config.js`).
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
 * (`/listings/publish-status`, `/listings/ebay/campaigns`, …). The path is the business-free one
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

/* ── Links to a listing's live state: this page ──────────────────────────────────────────────────────────────────── */

/** The store page of a channel (`/listings/amazon`); `null` for a channel with no page of its own (WooCommerce, …). */
function storePagePath(channel: string): string | null {
  const store = channel.toUpperCase() as ReadinessStore
  return (Object.keys(STORE_WORDS) as ReadinessStore[]).includes(store) ? readinessPath({ channel: store, marketplace: '' }) : null
}

/**
 * A SKU's listings: this page searched for the SKU, on its store's page (every market of it) when the store has one,
 * else on `/listings`. The search finds the family that holds the SKU.
 */
export function listingsSkuHref(channel: string | null, sku: string): string {
  return `${(channel && storePagePath(channel)) || '/listings'}?${new URLSearchParams({ q: sku })}`
}

/**
 * One store's listings on one market. Amazon and eBay have a page per market (`/listings/amazon/it`; a listing's `GB`
 * is the page's `uk`); Shopify and Etsy have one page; any other store is `/listings` with the same filters. A market
 * that is not two letters (`DEFAULT`, `GLOBAL`) opens the store's page.
 */
export function listingsMarketHref(channel: string, marketplace: string): string {
  const store = channel.toUpperCase()
  const page = storePagePath(store)
  const market = marketOfSegment(marketplace)
  if (page && (store === 'AMAZON' || store === 'EBAY') && market) return readinessPath({ channel: store, marketplace: market })
  if (page) return page
  const params = new URLSearchParams({ channel: store })
  if (marketplace) params.set('marketplace', market ?? marketplace.toUpperCase())
  return `/listings?${params}`
}

/** One listing: this page with the Listing window open on it (`?listing=<id>`, step 5). */
export const listingWindowHref = (listingId: string): string => `/listings?${new URLSearchParams({ listing: listingId })}`
