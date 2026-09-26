import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ marketplaces: vi.fn(), groupBy: vi.fn(), fields: vi.fn() }))
// P3b S4 — the column cache key carries the dictionary version (`dictionary-version.ts`).
vi.mock('../../db.js', () => ({ default: { marketplace: { findMany: db.marketplaces }, channelListing: { groupBy: db.groupBy }, $queryRaw: async () => [{ v: 'test-dictionary' }] } }))
vi.mock('./field-registry.service.js', () => ({ getAvailableFields: db.fields }))
// An EMPTY but well-formed spec. The coordinates are what this file is about, so the specs must
// be present enough not to crash and quiet enough to contribute no columns of their own.
const emptySpec = () => ({ absent: false, fetchedAt: null, fields: [], groups: [], coverage: {}, unrecognised: [] })
vi.mock('./channel-specs/index.js', () => ({
  loadAmazonSpec: vi.fn(async () => emptySpec()),
  loadAmazonEnglishLabels: vi.fn(async () => new Map()),
  loadEbaySpec: vi.fn(async () => emptySpec()),
}))
vi.mock('./channel-specs/store.js', () => ({ etsyProductSpec: vi.fn(() => emptySpec()) }))
import { clearSheetColumnCache, getSheetColumns } from './sheet-columns.service.js'

/**
 * PLAN Step 2.4 (with 15.4) — *"Shared means shared."*
 *
 * 🔴 WHAT THIS GUARDS. The presence query had **no `where` clause at all**: one aggregate over the
 * whole `ChannelListing` table decided which coordinates the Shared scope declares. The Owner's
 * own words for the result: *"a schema that changes when someone else sells something."*
 *
 * Measured on the scale fixture before the change: that query is **6 ms at 3,000 listings and
 * 154 ms at 30,000**, against a whole cold column build of 148 ms. It WAS the page.
 *
 * 🔴 AND IT FED TWO DIFFERENT FACTS. `availableMarkets` — the operator's market switcher — came
 * from the same rows. Narrowing both would have shrunk the market dropdown to whatever the current
 * page happens to sell on. The tests below pin that it did NOT.
 */

const MARKETPLACES = [
  { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', isActive: true, language: 'de', languages: ['de'] },
  { channel: 'EBAY', code: 'DE', name: 'eBay Germany', isActive: true, language: 'de', languages: ['de'] },
]

/** `listings` is what the WHOLE catalogue holds; `mine` is what the products in view hold. */
function catalogue(listings: Array<{ channel: string; marketplace: string }>, mine: Array<{ channel: string; marketplace: string }>) {
  db.marketplaces.mockResolvedValue(MARKETPLACES)
  db.fields.mockResolvedValue([])
  db.groupBy.mockImplementation(async (args: { by: string[]; where?: { productId?: { in: string[] } } }) => {
    if (args.by.length === 1) return [...new Set(listings.map(l => l.marketplace))].map(marketplace => ({ marketplace }))
    return args.where?.productId ? mine : listings
  })
}

beforeEach(() => { clearSheetColumnCache(); for (const m of Object.values(db)) m.mockReset() })

describe('Step 2.4 — the Shared scope is about THESE products', () => {
  it('🔴 a product with no Amazon listing does not get Amazon coordinates from somebody else', async () => {
    // The catalogue sells on both. These products sell only on eBay.
    catalogue([{ channel: 'AMAZON', marketplace: 'DE' }, { channel: 'EBAY', marketplace: 'DE' }], [{ channel: 'EBAY', marketplace: 'DE' }])
    const set = await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p1'] })
    expect(set.coordinates.map(c => c.label)).toEqual(['eBay · DE'])
    // 🔴 R4 — the absence is STATED, not left to look like a missing feature.
    expect(set.coordinatesNotListed).toEqual(['Amazon · DE'])
  })

  it('🔴 POSITIVE CONTROL — the same products WITH an Amazon listing do get the coordinate', async () => {
    // A run that finds nothing must be shown capable of finding something.
    catalogue([{ channel: 'AMAZON', marketplace: 'DE' }, { channel: 'EBAY', marketplace: 'DE' }],
      [{ channel: 'AMAZON', marketplace: 'DE' }, { channel: 'EBAY', marketplace: 'DE' }])
    const set = await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p1'] })
    expect(set.coordinates.map(c => c.label)).toEqual(['Amazon · DE', 'eBay · DE'])
    expect(set.coordinatesNotListed).toEqual([])
  })

  it('🔴 the market switcher keeps the WHOLE catalogue, not this page', async () => {
    db.marketplaces.mockResolvedValue(MARKETPLACES)
    db.fields.mockResolvedValue([])
    db.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by.length === 1
        ? [{ marketplace: 'DE' }, { marketplace: 'IT' }, { marketplace: 'FR' }]   // catalogue-wide
        : [{ channel: 'EBAY', marketplace: 'DE' }])                                 // this page only
    const set = await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p1'] })
    // Narrowing the coordinates must not narrow the operator's market list.
    expect(set.availableMarkets).toEqual(['DE', 'FR', 'IT'])
    expect(set.coordinates.map(c => c.label)).toEqual(['eBay · DE'])
  })

  it('🔴 the presence query is NARROWED — the un-narrowed one was the whole cost of the page', async () => {
    catalogue([{ channel: 'AMAZON', marketplace: 'DE' }], [{ channel: 'AMAZON', marketplace: 'DE' }])
    await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p1', 'p2', 'p1'] })
    const presence = db.groupBy.mock.calls.find(c => c[0].by.length === 2)![0]
    expect(presence.where).toEqual({ productId: { in: ['p1', 'p2'] } })   // de-duplicated
  })

  it('with NO productIds the presence check keeps its old catalogue-wide behaviour', async () => {
    // A caller that has no product list must be unchanged, never silently narrowed to nothing.
    catalogue([{ channel: 'AMAZON', marketplace: 'DE' }, { channel: 'EBAY', marketplace: 'DE' }], [])
    const set = await getSheetColumns({ market: 'DE', productTypes: [] })
    expect(set.coordinates.map(c => c.label)).toEqual(['Amazon · DE', 'eBay · DE'])
    expect(db.groupBy.mock.calls.find(c => c[0].by.length === 2)![0].where).toBeUndefined()
    // 🔴 Empty because nothing was narrowed — which is a different fact from "nothing excluded".
    expect(set.coordinatesNotListed).toEqual([])
  })

  it('productIds is part of the cache key — two product sets must not share one column set', async () => {
    catalogue([{ channel: 'AMAZON', marketplace: 'DE' }, { channel: 'EBAY', marketplace: 'DE' }], [{ channel: 'EBAY', marketplace: 'DE' }])
    const first = await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p1'] })
    db.groupBy.mockImplementation(async (args: { by: string[]; where?: unknown }) =>
      args.by.length === 1 ? [{ marketplace: 'DE' }] : [{ channel: 'AMAZON', marketplace: 'DE' }])
    const second = await getSheetColumns({ market: 'DE', productTypes: [], productIds: ['p2'] })
    expect(first.coordinates.map(c => c.label)).toEqual(['eBay · DE'])
    expect(second.coordinates.map(c => c.label)).toEqual(['Amazon · DE'])
  })
})
