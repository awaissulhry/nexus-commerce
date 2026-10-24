import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILTER_KEYS, SELECTOR_KINDS } from './_readiness/readinessQuery'

/**
 * 2026-10-24 — the Listings swap (docs/listings/LISTINGS-SWAP-2026-10-24.md). `/listings` is the readiness page; the
 * old page is `/listings/legacy`. The readiness page's old address and every old-page-only link land on a page that
 * does what the link asked for, inside the business they were opened in.
 */
const WEB_ROOT = join(__dirname, '..', '..', '..')
const APP = join(WEB_ROOT, 'src', 'app')

interface NextRedirect { source: string; destination: string; permanent?: boolean; has?: Array<{ type: string; key: string; value?: string }> }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/** The options the old page reads from its address. */
const oldPageOptions = (): string[] => {
  const src = readFileSync(join(APP, 'listings', 'ListingsWorkspace.tsx'), 'utf8')
  return [...new Set([...src.matchAll(/searchParams\??\.(?:get|has)\('([A-Za-z]+)'\)/g)].map((m) => m[1]!))]
}
/** The options the new page reads (`parseReadinessQuery`): its selections, its filters and its own words. */
const NEW_PAGE_OPTIONS = new Set<string>([...SELECTOR_KINDS, ...FILTER_KEYS, 'market', 'state', 'q', 'parent', 'page', 'pageSize'])

const legacyRules = (redirects: NextRedirect[], source = '/listings') =>
  redirects.filter((r) => r.source === source && r.has?.length === 1 && r.has[0]!.type === 'query')

describe('the Listings swap', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('/listings renders the new page and /listings/legacy the old one; the readiness folder has no page left', () => {
    expect(readFileSync(join(APP, 'listings', 'page.tsx'), 'utf8')).toContain('ListingReadinessClient')
    expect(readFileSync(join(APP, 'listings', 'legacy', 'page.tsx'), 'utf8')).toContain('ListingsWorkspace')
    expect(existsSync(join(APP, 'listings', '_readiness', 'page.tsx'))).toBe(false)
    expect(existsSync(join(APP, 'products', 'listing-readiness'))).toBe(false)
  })

  it('the readiness page’s old address goes to /listings for good, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const plain = redirects.find((r) => r.source === '/products/listing-readiness' && !r.has)
    expect(plain).toMatchObject({ destination: '/listings', permanent: true })
    expect(redirects.find((r) => r.source === '/w/:workspaceId/products/listing-readiness')?.destination).toBe('/w/:workspaceId/listings')
  })

  it('every option only the old page reads sends /listings to /listings/legacy, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    const onlyOld = oldPageOptions().filter((key) => !NEW_PAGE_OPTIONS.has(key))
    expect(onlyOld).toEqual(expect.arrayContaining(['listingStatus', 'search', 'lens', 'drawer']))
    const plain = legacyRules(redirects)
    const inBusiness = legacyRules(redirects, '/w/:workspaceId/listings')
    expect(plain.map((r) => r.has![0]!.key).sort()).toEqual([...onlyOld].sort())
    for (const rule of plain) expect(rule).toMatchObject({ destination: '/listings/legacy', permanent: false })
    for (const rule of inBusiness) expect(rule.destination).toBe('/w/:workspaceId/listings/legacy')
    expect(inBusiness).toHaveLength(plain.length)
  })

  it('no rule takes an option the new page reads', async () => {
    const keys = legacyRules(await loadRedirects()).map((r) => r.has![0]!.key)
    for (const key of keys) expect(NEW_PAGE_OPTIONS.has(key)).toBe(false)
  })
})
