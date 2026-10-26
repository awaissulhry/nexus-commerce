import { describe, expect, it } from 'vitest'
import { LEGACY_LISTINGS_OPTIONS, withLegacyListingOptions } from './legacyListingOptions'
import { parseReadinessQuery, serializeReadinessQuery } from './readinessQuery'

// Step 8 (the legacy exit) of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md: the old Listings page's options,
// read by this page in its own words.
const mapped = (search: string) => Object.fromEntries(withLegacyListingOptions(new URLSearchParams(search)))
const parsed = (search: string) => parseReadinessQuery(search)

describe('the old page’s options, in this page’s words', () => {
  it('leaves an address without old options alone (the same object)', () => {
    const params = new URLSearchParams('q=GAL&live=active&page=2')
    expect(withLegacyListingOptions(params)).toBe(params)
  })

  it('search → q, unless the address names q itself', () => {
    expect(mapped('search=GAL-1')).toEqual({ q: 'GAL-1' })
    expect(mapped('search=GAL-1&q=OWN')).toEqual({ q: 'OWN' })
    expect(parsed('search=GAL%201%2FA').q).toBe('GAL 1/A')
  })

  it('listingStatus → the channel states, and ERROR / SUPPRESSED → the flags', () => {
    expect(parsed('listingStatus=ACTIVE').live).toEqual(['active'])
    expect(parsed('listingStatus=INACTIVE').live).toEqual(['paused'])
    expect(parsed('listingStatus=DRAFT').live).toEqual(['draft', 'not_listed'])
    expect(parsed('listingStatus=ENDED').live).toEqual(['ended'])
    expect(parsed('listingStatus=ERROR')).toMatchObject({ live: [], flags: ['error'] })
    expect(parsed('listingStatus=SUPPRESSED')).toMatchObject({ live: [], flags: ['suppressed'] })
    // A comma list, repeated values and any letter case, as the old page sent them.
    expect(parsed('listingStatus=active,ended').live).toEqual(['active', 'ended'])
    expect(parsed('listingStatus=ACTIVE&listingStatus=INACTIVE').live).toEqual(['active', 'paused'])
    // No equivalent: dropped, never sent on.
    expect(mapped('listingStatus=PENDING')).toEqual({})
  })

  it('hasError=true → flags=error; anything else is no filter', () => {
    expect(mapped('hasError=true')).toEqual({ flags: 'error' })
    expect(mapped('hasError=false')).toEqual({})
  })

  it('syncStatus: FAILED → error, PENDING / SYNCING → out of sync, IDLE / IN_SYNC → none', () => {
    expect(parsed('syncStatus=FAILED').flags).toEqual(['error'])
    expect(parsed('syncStatus=PENDING').flags).toEqual(['outOfSync'])
    expect(parsed('syncStatus=SYNCING').flags).toEqual(['outOfSync'])
    expect(parsed('syncStatus=FAILED,PENDING').flags).toEqual(['error', 'outOfSync'])
    expect(mapped('syncStatus=IDLE,IN_SYNC')).toEqual({})
  })

  it('published=true → Active, published=false → Not listed (draft and not listed)', () => {
    expect(parsed('published=true').live).toEqual(['active'])
    expect(parsed('published=false').live).toEqual(['draft', 'not_listed'])
    expect(mapped('published=maybe')).toEqual({})
  })

  it('lowStock=true → flags=lowStock', () => {
    expect(parsed('lowStock=true').flags).toEqual(['lowStock'])
    expect(mapped('lowStock=1')).toEqual({})
  })

  it('the old states and flags add up with the address’s own, once each, in this page’s order', () => {
    const q = parsed('flags=suppressed&listingStatus=ERROR&hasError=true&lowStock=true&live=ended&published=true')
    expect(q.flags).toEqual(['error', 'suppressed', 'lowStock'])
    expect(q.live).toEqual(['active', 'ended'])
  })

  it('drawer=<listingId> → listing=<listingId> (the Listing window), unless the address names listing itself', () => {
    expect(mapped('drawer=cl_123')).toEqual({ listing: 'cl_123' })
    expect(mapped('drawer=cl_123&listing=cl_own')).toEqual({ listing: 'cl_own' })
  })

  it('lens=health → the Problems view; the other lenses are this page or not carried over', () => {
    expect(parsed('lens=health').view).toBe('problems')
    for (const lens of ['grid', 'matrix', 'drafts', 'performance']) expect(mapped(`lens=${lens}`)).toEqual({})
    // One family's own page has no Problems view (this page's rule).
    expect(parsed('lens=health&parent=root-1').view).toBe('products')
  })

  it('sortBy / sortDir → sort / dir where this page has the order (descending unless asc), else dropped', () => {
    expect(parsed('sortBy=name&sortDir=asc')).toMatchObject({ sort: 'name', dir: 'asc' })
    expect(parsed('sortBy=price')).toMatchObject({ sort: 'price', dir: 'desc' })
    expect(parsed('sortBy=quantity&sortDir=desc')).toMatchObject({ sort: 'stock', dir: 'desc' })
    expect(parsed('sortBy=lastSyncedAt')).toMatchObject({ sort: 'synced', dir: 'desc' })
    for (const key of ['updatedAt', 'channel', 'marketplace', 'junk']) expect(mapped(`sortBy=${key}&sortDir=asc`)).toEqual({})
    expect(mapped('sortDir=asc')).toEqual({})
    // The address's own order wins.
    expect(parsed('sortBy=price&sort=name&dir=asc')).toMatchObject({ sort: 'name', dir: 'asc' })
  })

  it('keeps every option both pages read, and a store page’s lock still wins', () => {
    expect(mapped('search=GAL&page=3&pageSize=100&channel=EBAY&marketplace=DE')).toEqual({ q: 'GAL', page: '3', pageSize: '100', channel: 'EBAY', marketplace: 'DE' })
    const q = parseReadinessQuery('search=GAL&channel=EBAY&marketplace=DE&listingStatus=ERROR', { channel: 'AMAZON', marketplace: 'IT' })
    expect(q).toMatchObject({ q: 'GAL', channel: 'AMAZON', marketplace: 'IT', flags: ['error'] })
  })

  it('the page writes the address back in its own words only: no old option survives a visit', () => {
    const everything = 'search=GAL&listingStatus=ACTIVE,ERROR&hasError=true&syncStatus=PENDING&published=true&lowStock=true'
      + '&drawer=cl_1&lens=health&sortBy=price&sortDir=asc'
    const written = new URLSearchParams(serializeReadinessQuery(parseReadinessQuery(everything)))
    for (const key of LEGACY_LISTINGS_OPTIONS) expect(written.has(key)).toBe(false)
    expect(Object.fromEntries(written)).toMatchObject({ q: 'GAL', live: 'active', flags: 'error,outOfSync,lowStock', view: 'problems' })
  })

  it('the stored links of the old Home page land where they meant', () => {
    // AlertsPanel / QuickActions before step 8: failed listings, drafts.
    expect(parsed('listingStatus=ERROR')).toMatchObject({ flags: ['error'], live: [] })
    expect(parsed('listingStatus=DRAFT')).toMatchObject({ live: ['draft', 'not_listed'], flags: [] })
  })
})
