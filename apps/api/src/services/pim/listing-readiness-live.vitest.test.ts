/**
 * Listings live layer, step 3 — the pure parts: the join rule (GB = UK, '' = no alias, orphans), one listing's state and
 * flags, a row's summary on one destination (Mixed, the Shopify root's status, the Amazon parent ASIN, an eBay parent
 * that ended, GB/UK twins, aliases never added), the live tiles, the search terms and the extra destinations' words.
 * No database.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
// The listing-action engine's state reader is the one the live layer reuses; its queues stay out of a pure test.
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import type { ListingDeletion } from '@nexus/shared/listing-actions'
import {
  buildLive, canonicalDestinationKey, currencyMap, differsOf, extraDestination, foldStates, inLiveScope, liveDestinationKey, liveFlagsOf,
  liveMarketCode, liveTilesOf, searchTerms, summarizeLive, unmatchedNote, type LiveListingRow, type LiveProduct,
} from './listing-readiness-live.service.js'
import { destinationSellingStates, OLD_CLOSE_PAUSE_REASON } from '../listings/listing-action.service.js'

const key = (channel: string | null, market: string | null = null, accountId: string | null = null, aliasId: string | null = null) => JSON.stringify([channel, market, accountId, aliasId])
const AMAZON_IT = key('AMAZON', 'IT', 'a1'), AMAZON_UK = key('AMAZON', 'UK', 'a1'), SHOPIFY = key('SHOPIFY', 'GLOBAL', 's1'), EBAY_IT = key('EBAY', 'IT', 'e1')
let n = 0
const listing = (productId: string, extra: Partial<LiveListingRow> = {}): LiveListingRow => ({
  id: `l${++n}`, productId, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'a1', aliasKey: '',
  externalListingId: `B0${productId.toUpperCase()}`, externalParentId: null, listingStatus: 'ACTIVE', isPublished: true,
  offerClosedAt: null, offerCloseReason: null, offerActive: true, fulfillmentMethod: null, platformAttributes: {},
  price: null, salePrice: null, quantity: null, followMasterQuantity: true, quantityOverride: null,
  syncStatus: 'IDLE', lastSyncStatus: null, lastSyncError: null, lastSyncedAt: null, syncPaused: false, syncLocked: false,
  publishAction: null, publishActionAt: null, errors: 0, warnings: 0, suppressionOpen: false, driftCount: 0, ...extra,
})
const product = (id: string, parentId: string | null = null, extra: Partial<LiveProduct> = {}): LiveProduct =>
  ({ id, sku: id.toUpperCase(), parentId, isParent: !parentId && id === 'root', lowStockThreshold: 10, fulfillmentMethod: null, ...extra })
const FAMILY = [product('root'), product('v1', 'root'), product('v2', 'root'), product('v3', 'root'), product('solo')]
const currencies = currencyMap([{ channel: 'AMAZON', code: 'IT', currency: 'EUR' }, { channel: 'AMAZON', code: 'UK', currency: 'GBP' }, { channel: 'SHOPIFY', code: 'GLOBAL', currency: 'EUR' }])
const facts = (extra: { oldPauses?: Set<string>; deletions?: Map<string, ListingDeletion> } = {}) =>
  ({ oldPauses: extra.oldPauses ?? new Set<string>(), deletions: extra.deletions ?? new Map(), currencies, readAt: new Date('2026-10-25T10:00:00Z'), sellingStates: destinationSellingStates })
const live = (rows: LiveListingRow[], extra?: Parameters<typeof facts>[0], products = FAMILY) => buildLive(products, rows, facts(extra))

describe('the join rule', () => {
  it('a listing belongs to the readiness coordinate: GB reads UK, the primary listing ("") is a null alias', () => {
    expect(liveDestinationKey({ channel: 'AMAZON', marketplace: 'GB', channelConnectionId: 'a1', aliasKey: '' })).toBe(AMAZON_UK)
    expect(liveDestinationKey({ channel: 'amazon', marketplace: 'it', channelConnectionId: 'a1', aliasKey: '' })).toBe(AMAZON_IT)
    expect(liveDestinationKey({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'e1', aliasKey: 'al1' })).toBe(key('EBAY', 'IT', 'e1', 'al1'))
    expect(canonicalDestinationKey(key('AMAZON', 'GB', 'a1'))).toBe(AMAZON_UK)
    expect(canonicalDestinationKey(key(null))).toBe(key(null))
    expect(liveMarketCode('gb')).toBe('UK')
  })
  it('orphans keep their own coordinate: no account, no market', () => {
    expect(liveDestinationKey({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: null, aliasKey: '' })).toBe(key('EBAY', 'IT', null))
    expect(liveDestinationKey({ channel: 'EBAY', marketplace: 'DEFAULT', channelConnectionId: 'e1', aliasKey: '' })).toBe(key('EBAY', 'DEFAULT', 'e1'))
  })
  it('the page filters narrow listings as they narrow readiness (GB matches a UK filter; Shared has no listing)', () => {
    const row = listing('v1', { marketplace: 'GB' })
    expect(inLiveScope(row, {})).toBe(true)
    expect(inLiveScope(row, { marketplace: 'UK' })).toBe(true)
    expect(inLiveScope(row, { marketplace: 'IT' })).toBe(false)
    expect(inLiveScope(row, { channel: 'SHARED' })).toBe(false)
    expect(inLiveScope(row, { channel: 'EBAY' })).toBe(false)
    expect(inLiveScope(row, { accountId: 'a2' })).toBe(false)
    expect(inLiveScope(row, { listingIds: [row.id] })).toBe(true)
    expect(inLiveScope(row, { listingIds: ['other'] })).toBe(false)
  })
  it('a twin (GB and UK listings of one product) lands twice on one destination; buildLive groups by the canonical key', () => {
    const read = live([listing('v1', { marketplace: 'GB' }), listing('v1', { marketplace: 'UK' })])
    expect(read.get('v1')!.get(AMAZON_UK)!.length).toBe(2)
  })
})

describe('one listing', () => {
  it('reads the product sheet\'s state and words, with price, currency, link and fulfilment', () => {
    const read = live([listing('v1', { price: 49.9, quantity: 4, fulfillmentMethod: 'FBA' })])
    expect(read.get('v1')!.get(AMAZON_IT)![0]).toMatchObject({ state: 'active', reason: null, externalId: 'B0V1', url: 'https://www.amazon.it/dp/B0V1',
      price: 49.9, currency: 'EUR', quantity: 4, fulfillment: 'FBA', syncStatus: null, suppressed: false, outOfSync: [], held: false })
    const draft = live([listing('v2', { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })]).get('v2')!.get(AMAZON_IT)![0]
    expect(draft).toMatchObject({ state: 'draft', url: null })
    const ended = live([listing('v2', { listingStatus: 'ENDED' })]).get('v2')!.get(AMAZON_IT)![0]
    expect(ended.state).toBe('not_listed')
  })
  it('a Nexus delete reads Not listed; an older Claude close reads Inactive (eBay); held and out-of-sync are said', () => {
    const deleted = listing('v1', { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    const deletion: ListingDeletion = { at: '2026-10-04T10:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0V1', relistChosenAt: null }
    expect(live([deleted], { deletions: new Map([[deleted.id, deletion]]) }).get('v1')!.get(AMAZON_IT)![0].state).toBe('not_listed')
    const pinned = listing('v2', { channel: 'EBAY', channelConnectionId: 'e1', followMasterQuantity: false, quantity: 0 })
    const read = live([pinned], { oldPauses: new Set([pinned.id]) }).get('v2')!.get(EBAY_IT)![0]
    expect(read).toMatchObject({ state: 'paused', reason: OLD_CLOSE_PAUSE_REASON, url: `https://www.ebay.it/itm/${pinned.externalListingId}` })
    const failing = live([listing('v3', { lastSyncStatus: 'FAILED', driftCount: 2, syncPaused: true })]).get('v3')!.get(AMAZON_IT)![0]
    expect(failing).toMatchObject({ syncStatus: 'FAILED', outOfSync: ['channel-differs', 'push-failed'], held: true })
  })
  it('flags: error (channel error, failed push, listing in error), suppressed, out of sync, low stock (active only)', () => {
    const base = { state: 'active' as const, quantity: 3, channelErrorCount: 0, suppressed: false, outOfSync: [] }
    expect(liveFlagsOf(base, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual(['lowStock'])
    expect(liveFlagsOf({ ...base, quantity: 11 }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual([])
    expect(liveFlagsOf({ ...base, state: 'paused' }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual([])
    expect(liveFlagsOf({ ...base, quantity: null }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual([])
    expect(liveFlagsOf({ ...base, quantity: 50, channelErrorCount: 1 }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual(['error'])
    expect(liveFlagsOf({ ...base, quantity: 50, outOfSync: ['push-failed'] }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual(['error', 'outOfSync'])
    expect(liveFlagsOf({ ...base, quantity: 50, outOfSync: ['channel-differs'] }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual(['outOfSync'])
    expect(liveFlagsOf({ ...base, quantity: 50 }, { listingStatus: 'error', lowStockThreshold: 10 })).toEqual(['error'])
    expect(liveFlagsOf({ ...base, quantity: 50, suppressed: true }, { listingStatus: 'ACTIVE', lowStockThreshold: 10 })).toEqual(['suppressed'])
    const suppressedByStatus = live([listing('v1', { listingStatus: 'SUPPRESSED' })]).get('v1')!.get(AMAZON_IT)![0]
    expect(suppressedByStatus.suppressed).toBe(true)
  })
})

describe('a row on one destination', () => {
  const FAMILY_IDS = ['root', 'v1', 'v2', 'v3']
  it('18 Active · 2 Not listed is Mixed: the variations count, the parent gives the ASIN and the link', () => {
    const read = live([listing('root', { externalListingId: 'B0PARENT' }), listing('v1', { price: 40, quantity: 2, externalParentId: 'B0PARENT' }),
      listing('v2', { price: 45, quantity: 3, externalParentId: 'B0PARENT', errors: 2, suppressionOpen: true })])
    const summary = summarizeLive(FAMILY_IDS, AMAZON_IT, read)
    // byState counts listings; the variation with no listing is in notListed only.
    expect(summary.byState).toEqual({ active: 2 })
    expect(summary).toMatchObject({ state: 'mixed', listed: 2, notListed: 1, externalId: 'B0PARENT',
      url: 'https://www.amazon.it/dp/B0PARENT', priceMin: 40, priceMax: 45, currency: 'EUR', quantity: 5, channelErrorCount: 2, suppressedCount: 1, duplicates: 0 })
    // Every variation active: Active.
    const all = live([listing('v1'), listing('v2'), listing('v3')])
    expect(summarizeLive(FAMILY_IDS, AMAZON_IT, all)).toMatchObject({ state: 'active', listed: 3, notListed: 0, byState: { active: 3 } })
    // No parent listing: the variations' common parent ASIN names the family.
    const noParent = live([listing('v1', { externalParentId: 'B0PARENT' }), listing('v2', { externalParentId: 'B0PARENT' })])
    expect(summarizeLive(FAMILY_IDS, AMAZON_IT, noParent).externalId).toBe('B0PARENT')
    // Nothing here: Not listed.
    expect(summarizeLive(FAMILY_IDS, AMAZON_IT, live([]))).toMatchObject({ state: 'not_listed', listed: 0, notListed: 3, byState: {}, externalId: null, url: null, quantity: null })
    // Overlaps stay as they come: a failed push is out of sync AND a failed push.
    const failed = live([listing('v1', { lastSyncStatus: 'FAILED' }), listing('v2', { driftCount: 1 })])
    expect(summarizeLive(FAMILY_IDS, AMAZON_IT, failed)).toMatchObject({ outOfSyncCount: 2, syncFailedCount: 1 })
  })
  it('a parent whose own eBay listing ended reads Ended, whatever its variations still say', () => {
    const ebay = { channel: 'EBAY', channelConnectionId: 'e1', externalListingId: '225500001111' }
    const read = live([listing('root', { ...ebay, listingStatus: 'ENDED' }), listing('v1', ebay), listing('v2', ebay), listing('v3', ebay)])
    expect(summarizeLive(FAMILY_IDS, EBAY_IT, read)).toMatchObject({ state: 'ended', byState: { active: 3 }, externalId: '225500001111' })
  })
  it('Shopify: the variants share the root listing\'s status (Archived → Ended; Draft → Inactive)', () => {
    const shopify = { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 's1' }
    const archived = live([listing('root', { ...shopify, externalListingId: 'gid://p/1', platformAttributes: { status: 'ARCHIVED' } }),
      listing('v1', { ...shopify, externalListingId: 'gid://v/1', platformAttributes: { status: 'ACTIVE' } }), listing('v2', { ...shopify, externalListingId: 'gid://v/2' })])
    expect(archived.get('v1')!.get(SHOPIFY)![0].state).toBe('ended')
    expect(summarizeLive(['root', 'v1', 'v2'], SHOPIFY, archived)).toMatchObject({ state: 'ended', url: null, externalId: 'gid://p/1' })
    const draft = live([listing('root', { ...shopify, externalListingId: 'gid://p/1', platformAttributes: { status: 'DRAFT' } }), listing('v1', { ...shopify, externalListingId: 'gid://v/1' })])
    expect(draft.get('v1')!.get(SHOPIFY)![0]).toMatchObject({ state: 'paused', reason: expect.stringContaining('Draft in Shopify') })
  })
  it('an alias listing is another destination: never added to the primary listing\'s price or stock', () => {
    const read = live([listing('v1', { quantity: 4, price: 40 }), listing('v1', { aliasKey: 'al1', quantity: 50, price: 10 })])
    expect(summarizeLive(['v1'], AMAZON_IT, read)).toMatchObject({ quantity: 4, priceMin: 40, priceMax: 40 })
    expect(summarizeLive(['v1'], key('AMAZON', 'IT', 'a1', 'al1'), read)).toMatchObject({ quantity: 50, priceMin: 10 })
  })
  it('GB and UK twins: counted as duplicates, their stock not added (Nexus does not pick one)', () => {
    const read = live([listing('v1', { marketplace: 'GB', quantity: 3 }), listing('v1', { marketplace: 'UK', quantity: 3 }), listing('v2', { marketplace: 'UK', quantity: 1 })])
    const summary = summarizeLive(['root', 'v1', 'v2', 'v3'], AMAZON_UK, read)
    expect(summary).toMatchObject({ duplicates: 1, quantity: null, listed: 2, notListed: 1, currency: 'GBP' })
    expect(summary.byState).toEqual({ active: 3 })
  })
  it('a single product, or a member row, is its own listing; the Shared destination has no live layer', () => {
    const read = live([listing('solo', { lastSyncedAt: new Date('2026-10-20T00:00:00Z') })])
    expect(summarizeLive(['solo'], AMAZON_IT, read)).toMatchObject({ state: 'active', listed: 1, notListed: 0, externalId: 'B0SOLO', lastSyncedAt: '2026-10-20T00:00:00.000Z' })
    expect(summarizeLive(['root'], AMAZON_IT, live([listing('root', { externalListingId: 'B0PARENT' })]))).toMatchObject({ state: 'active', listed: 1, externalId: 'B0PARENT' })
    // A member row without a listing here: Not listed, one product not listed, no listing by state.
    expect(summarizeLive(['v3'], AMAZON_IT, read)).toEqual(expect.objectContaining({ state: 'not_listed', listed: 0, notListed: 1, byState: {}, externalId: null, duplicates: 0 }))
    // A deleted listing is still a listing: counted by its state (Not listed), not in notListed.
    const deleted = listing('v2', { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    const gone = live([deleted], { deletions: new Map([[deleted.id, { at: '2026-10-04T10:00:00.000Z', where: 'Amazon · IT', oldReference: null, relistChosenAt: null }]]) })
    expect(summarizeLive(['v2'], AMAZON_IT, gone)).toMatchObject({ state: 'not_listed', listed: 1, notListed: 0, byState: { not_listed: 1 } })
  })
  it('folds products: one state, Mixed when they differ, Draft and Not listed alike', () => {
    expect(foldStates([])).toBe('not_listed')
    expect(foldStates(['active', 'active'])).toBe('active')
    expect(foldStates(['active', 'paused'])).toBe('mixed')
    expect(foldStates(['active', 'not_listed'])).toBe('mixed')
    expect(foldStates(['draft', 'not_listed'])).toBe('draft')
    expect(foldStates(['not_listed'])).toBe('not_listed')
  })
})

describe('the live tiles', () => {
  it('come from the page\'s SQL in one row; unmatched listings are their own count', () => {
    const counts = { listings: 4, active: 2, paused: 1, draft: 0, ended: 0, unknown: 0, notListed: 2, error: 1, suppressed: 1, outOfSync: 1, lowStock: 1 }
    expect(liveTilesOf({ ...counts, unmatched: 1 })).toEqual({ counts, unmatched: 1 })
  })
})

describe('search terms', () => {
  it('splits on spaces, commas and new lines; each term once, the first spelling kept', () => {
    expect(searchTerms(' GAL-001, gal-002\nGAL-001\r\n\tB0ABC123 ,, ')).toEqual(['GAL-001', 'gal-002', 'B0ABC123'])
    expect(searchTerms('')).toEqual([])
    expect(searchTerms(undefined)).toEqual([])
  })
})

describe('extra destinations', () => {
  const footprint = new Map([[AMAZON_IT, AMAZON_IT]])
  const factsOf = { aliases: new Map([['al-old', { status: 'ARCHIVED', label: 'Old title' }], ['al-new', { status: 'ACTIVE', label: 'New' }]]),
    stores: new Map([['a1', { active: true, name: 'Xavia' }], ['a-old', { active: false, name: 'Old store' }]]) }
  it('say why Nexus does not check readiness there', () => {
    expect(unmatchedNote(AMAZON_IT, footprint, factsOf)).toBeNull()
    expect(unmatchedNote(key('EBAY', 'IT', null), footprint, factsOf)).toMatch(/No account is recorded/)
    expect(unmatchedNote(key('EBAY', 'DEFAULT', 'e1'), footprint, factsOf)).toMatch(/No market is recorded/)
    expect(unmatchedNote(key('AMAZON', 'IT', 'a1', 'al-old'), footprint, factsOf)).toMatch(/customization is archived/)
    expect(unmatchedNote(key('AMAZON', 'IT', 'a-old'), footprint, factsOf)).toMatch(/not connected any more/)
    expect(unmatchedNote(key('AMAZON', 'NL', 'a1'), footprint, factsOf)).toMatch(/does not check readiness for this account on this market/)
  })
  it('are named like chips: channel, market, customization, store', () => {
    expect(extraDestination(key('AMAZON', 'IT', 'a1', 'al-old'), footprint, factsOf)).toMatchObject({ key: key('AMAZON', 'IT', 'a1', 'al-old'), channel: 'AMAZON',
      marketplace: 'IT', accountId: 'a1', aliasKey: 'al-old', label: 'Amazon IT · Old title · Xavia', note: expect.stringMatching(/archived/) })
    expect(extraDestination(key('EBAY', 'DEFAULT', 'e1'), footprint, factsOf).label).toBe('eBay · Store …e1')
    expect(extraDestination(AMAZON_IT, footprint, factsOf)).not.toHaveProperty('note')
  })
})

describe('what differs', () => {
  it('reads ChannelDrift entries in words; a clean row says nothing', () => {
    expect(differsOf(1, [{ field: 'price', ours: 49.9, theirs: '45.00', source: 'amazon-merchant-listings-report', checkedAt: '2026-10-24T03:00:00.000Z' }, { bad: true }]))
      .toEqual([{ field: 'price', nexus: '49.9', channel: '45.00', foundAt: '2026-10-24T03:00:00.000Z' }])
    expect(differsOf(0, [{ field: 'price', ours: 1, theirs: 2 }])).toEqual([])
  })
})

describe('the live filters (accepted now, applied by the SQL summary)', () => {
  it('keep known states and flags, drop unknown ones, never refuse', async () => {
    const { familiesQuery } = await import('./listing-readiness-families.service.js')
    expect(familiesQuery({ live: 'active,paused,bogus', flags: 'error,lowStock,nope' })).toMatchObject({ liveStates: ['active', 'paused'], liveFlags: ['error', 'lowStock'] })
    const none = familiesQuery({ live: 'bogus', flags: '' })
    expect(none).not.toHaveProperty('liveStates')
    expect(none).not.toHaveProperty('liveFlags')
  })
  it('a search may be a pasted list: up to 500 terms and 4,000 characters', async () => {
    const { familiesQuery } = await import('./listing-readiness-families.service.js')
    const many = Array.from({ length: 500 }, (_, k) => `S${k}`).join(' ')
    expect(familiesQuery({ q: many }).q).toBe(many)
    expect(() => familiesQuery({ q: `${many} S500` })).toThrow(/up to 500 terms/)
    expect(() => familiesQuery({ q: 'x'.repeat(4001) })).toThrow(/Invalid search/)
  })
})
