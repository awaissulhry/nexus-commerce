import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY_LISTINGS_OPTIONS } from './_readiness/legacyListingOptions'
import { parseReadinessQuery, serializeReadinessQuery } from './_readiness/readinessQuery'

/**
 * 2026-10-24 — the Listings swap (docs/listings/LISTINGS-SWAP-2026-10-24.md): `/listings` is the readiness page, and
 * the readiness page's old address lands on it. 2026-10-26 — the legacy exit (step 8 of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): the old Listings pages are gone, every old address lands on
 * the new page that does its job, and the new page reads the old page's options, inside the business they were
 * opened in.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..')
const APP = join(WEB_ROOT, 'src', 'app')

interface NextRedirect { source: string; destination: string; permanent?: boolean; has?: Array<{ type: string; key: string; value?: string }> }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/** The Listings pages: `/listings` and the store pages. */
const LISTINGS_PAGES = ['/listings', '/listings/amazon', '/listings/amazon/:market', '/listings/ebay', '/listings/ebay/:market', '/listings/shopify', '/listings/etsy']
const LEGACY_EXIT: Array<[string, string]> = [
  ['/listings/legacy', '/listings'],
  ['/listings/legacy/:store', '/listings/:store'],
  ['/listings/legacy/:store/:market', '/listings/:store/:market'],
]

describe('the Listings page', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('/listings renders the new page; the readiness folder has no page left; the old page is gone', () => {
    expect(readFileSync(join(APP, 'listings', 'page.tsx'), 'utf8')).toContain('<ReadinessPage lock={null} />')
    expect(readFileSync(join(APP, 'listings', '_readiness', 'ReadinessPage.tsx'), 'utf8')).toContain('<ListingReadinessClient lock={lock} />')
    expect(existsSync(join(APP, 'listings', '_readiness', 'page.tsx'))).toBe(false)
    expect(existsSync(join(APP, 'products', 'listing-readiness'))).toBe(false)
    expect(existsSync(join(APP, 'listings', 'legacy'))).toBe(false)
    expect(existsSync(join(APP, 'listings', 'ListingsWorkspace.tsx'))).toBe(false)
  })

  it('the readiness page’s old address goes to /listings for good, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const plain = redirects.find((r) => r.source === '/products/listing-readiness' && !r.has)
    expect(plain).toMatchObject({ destination: '/listings', permanent: true })
    expect(redirects.find((r) => r.source === '/w/:workspaceId/products/listing-readiness')?.destination).toBe('/w/:workspaceId/listings')
  })

  it('no rule sends a Listings page anywhere: the old options are read by the page itself', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const sources = new Set(LISTINGS_PAGES.flatMap((page) => [page, `/w/:workspaceId${page}`]))
    const taken = redirects.filter((r) => sources.has(r.source.replace(/\(\[a-zA-Z\]\{2\}\)$/, '')))
    expect(taken).toEqual([])
    // The page reads each old option in its own words (legacyListingOptions.vitest.test.ts has every mapping) and
    // writes its address back without any of them.
    expect(parseReadinessQuery('search=GAL').q).toBe('GAL')
    expect(parseReadinessQuery('listingStatus=ERROR').flags).toEqual(['error'])
    expect(parseReadinessQuery('lens=health').view).toBe('problems')
    for (const key of LEGACY_LISTINGS_OPTIONS) {
      const written = new URLSearchParams(serializeReadinessQuery(parseReadinessQuery(`${key}=true`)))
      expect(written.has(key)).toBe(false)
    }
  })

  it('/listings/legacy[/<store>[/<market>]] goes to the new page for good, query kept, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    for (const [source, destination] of LEGACY_EXIT) {
      const plain = redirects.filter((r) => r.source === source)
      expect(plain).toEqual([{ source, destination, permanent: true }])
      const inBusiness = redirects.filter((r) => r.source === `/w/:workspaceId${source}`)
      expect(inBusiness).toEqual([{ source: `/w/:workspaceId${source}`, destination: `/w/:workspaceId${destination}`, permanent: true }])
    }
    // Nothing else names the old pages.
    expect(redirects.filter((r) => r.destination.includes('/listings/legacy'))).toEqual([])
    expect(redirects.filter((r) => r.source.includes('/listings/legacy'))).toHaveLength(LEGACY_EXIT.length * 2)
  })
})

/**
 * 2026-10-24 — the store pages (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md). `/listings/amazon[/<market>]`,
 * `/listings/ebay[/<market>]`, `/listings/shopify` and `/listings/etsy` are the Listings page with a lock; their old
 * clients are gone with the legacy exit. The eBay tool pages stay.
 */
const STORE_PAGES = [
  { path: ['amazon'], lock: "{ channel: 'AMAZON', marketplace: '' }" },
  { path: ['amazon', '[market]'], lock: "marketLock('AMAZON', params)" },
  { path: ['ebay'], lock: "{ channel: 'EBAY', marketplace: '' }" },
  { path: ['ebay', '[market]'], lock: "marketLock('EBAY', params)" },
  { path: ['shopify'], lock: "{ channel: 'SHOPIFY', marketplace: '' }" },
  { path: ['etsy'], lock: "{ channel: 'ETSY', marketplace: '' }" },
]
const page = (parts: string[]) => readFileSync(join(APP, 'listings', ...parts, 'page.tsx'), 'utf8')

describe('the store pages', () => {
  it('each store page is the Listings page with its lock; the old store clients are gone', () => {
    for (const p of STORE_PAGES) {
      const text = page(p.path)
      expect(text).toContain('<ReadinessPage lock=')
      expect(text).toContain(p.lock)
    }
    for (const client of ['amazon/AmazonListingsClient.tsx', 'ebay/EbayListingsClient.tsx', 'shopify/ShopifyListingsClient.tsx']) {
      expect(existsSync(join(APP, 'listings', client))).toBe(false)
    }
    for (const tool of ['campaigns', 'gaps', 'markdowns']) expect(existsSync(join(APP, 'listings', 'ebay', tool, 'page.tsx'))).toBe(true)
  })

  it('no redirect takes a store page or the eBay tool pages', async () => {
    const redirects = await loadRedirects()
    expect(redirects.filter((r) => /^\/listings\/(amazon|ebay|shopify|etsy)/.test(r.source))).toEqual([])
  })

  it('the app frame gives every store page the Listings page’s own rail', () => {
    const shell = readFileSync(join(WEB_ROOT, 'src', 'components', 'layout', 'AppShell.tsx'), 'utf8')
    expect(shell).toContain('readinessLockFromPath(pathname) !== undefined')
  })
})
