/**
 * The ASIN filler: what it reads, what it writes, and what it refuses to touch. Amazon is a mock; no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  listings: [] as any[],
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  read: vi.fn(),
  clients: vi.fn(),
  sellerId: vi.fn(),
  region: vi.fn(),
  marketplaceId: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { channelListing: { findMany: m.findMany, findFirst: m.findFirst, updateMany: m.updateMany } } }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({
  AmazonSpApiClient: class { constructor(account: unknown) { m.clients(account) } getListingsItem(options: unknown) { return m.read(options) } },
}))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: m.sellerId, getAmazonRegion: m.region }))
vi.mock('../categories/marketplace-ids.js', () => ({ configuredAmazonMarketplaceId: m.marketplaceId }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: m.refresh } }))

import { fillAmazonListingAsins, pendingAsinListingIds, sellerSkuOf, summaryStatus, unfilledAmazonListingIds, ASIN_SWEEP_WINDOW_MS } from './listing-asin-fill.service.js'

const listing = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, productId: `product-${id}`, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', aliasKey: '',
  externalListingId: null, isPublished: true, listingStatus: 'ACTIVE', platformAttributes: null, flatFileSnapshot: null,
  offers: [], product: { sku: `SKU-${id}` }, ...overrides,
})
const found = (asin: string, status: unknown = ['BUYABLE', 'DISCOVERABLE']) =>
  ({ success: true, sku: 'x', asin, status, rawResponse: { sku: 'x', summaries: [{ marketplaceId: 'APJ6JRA9NG5V4', asin, status }] } })
const absent = { success: true, sku: 'x', asin: null, status: null }

beforeEach(() => {
  vi.resetAllMocks()
  m.listings = []
  m.findMany.mockImplementation(async ({ where }: any) => m.listings.filter(row => where.id.in.includes(row.id) && row.channel === where.channel))
  m.updateMany.mockResolvedValue({ count: 1 })
  m.sellerId.mockResolvedValue('SELLER-A')
  m.region.mockResolvedValue('eu')
  m.marketplaceId.mockResolvedValue('APJ6JRA9NG5V4')
  m.refresh.mockResolvedValue(undefined)
})

describe('fillAmazonListingAsins', () => {
  it('fills the ASIN of a published row, with Amazon status, through the row own account and seller SKU', async () => {
    m.listings = [listing('a', { offers: [{ sku: 'SELLER-SKU-A', isActive: true }] })]
    m.read.mockResolvedValue(found('B0FILLED01'))
    const report = await fillAmazonListingAsins(['a'])
    expect(report.rows).toEqual([{ id: 'a', sku: 'SELLER-SKU-A', marketplace: 'IT', outcome: 'filled', asin: 'B0FILLED01', status: 'BUYABLE' }])
    expect(report.counts).toEqual({ filled: 1, not_visible_yet: 0, already_had_asin: 0, error: 0 })
    expect(m.clients).toHaveBeenCalledWith({ id: 'account-a', region: 'eu' })
    expect(m.sellerId).toHaveBeenCalledWith('account-a')
    expect(m.read).toHaveBeenCalledWith({ sellerId: 'SELLER-A', sku: 'SELLER-SKU-A', marketplaceId: 'APJ6JRA9NG5V4', includedData: ['summaries'] })
    expect(m.refresh).toHaveBeenCalledWith(['product-a'])
  })

  it('scopes the write to the row coordinate and to a missing ASIN, so an existing ASIN is never replaced', async () => {
    m.listings = [listing('a', { aliasKey: 'alias-2', platformAttributes: { sellerSku: 'ALIAS-SKU' } })]
    m.read.mockResolvedValue(found('B0FILLED01'))
    await fillAmazonListingAsins(['a'])
    expect(m.updateMany).toHaveBeenCalledOnce()
    expect(m.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'a', channel: 'AMAZON', channelConnectionId: 'account-a', marketplace: 'IT', aliasKey: 'alias-2', externalListingId: null },
      data: { externalListingId: 'B0FILLED01', version: { increment: 1 }, listingStatus: 'BUYABLE' },
    })
  })

  it('publishes a row still marked DRAFT that Amazon holds, ACTIVE when Amazon reports no status', async () => {
    m.listings = [listing('a', { listingStatus: 'DRAFT', isPublished: true }), listing('b', { listingStatus: 'DRAFT', isPublished: false })]
    m.read.mockResolvedValueOnce(found('B0DRAFT001', [])).mockResolvedValueOnce(found('B0DRAFT002', ['DISCOVERABLE']))
    await fillAmazonListingAsins(['a', 'b'])
    const data = Object.fromEntries(m.updateMany.mock.calls.map(([args]: any) => [args.where.id, args.data]))
    expect(data.a).toEqual({ externalListingId: 'B0DRAFT001', version: { increment: 1 }, isPublished: true, listingStatus: 'ACTIVE' })
    expect(data.b).toEqual({ externalListingId: 'B0DRAFT002', version: { increment: 1 }, isPublished: true, listingStatus: 'DISCOVERABLE' })
  })

  it.each([
    ['an ended, unpublished row', { listingStatus: 'ENDED', isPublished: false }],
    ['an ended row still marked published', { listingStatus: 'ENDED', isPublished: true }],
    ['an inactive row', { listingStatus: 'INACTIVE', isPublished: true }],
  ])('gives %s its ASIN only — a read never lifts its status or lock', async (_why, facts) => {
    m.listings = [listing('a', facts)]
    m.read.mockResolvedValue(found('B0ENDED001'))
    await fillAmazonListingAsins(['a'])
    expect(m.updateMany.mock.calls[0][0].data).toEqual({ externalListingId: 'B0ENDED001', version: { increment: 1 } })
  })

  it('reports a 404 as not visible yet and changes nothing', async () => {
    m.listings = [listing('a')]
    m.read.mockResolvedValue(absent)
    const report = await fillAmazonListingAsins(['a'])
    expect(report.rows[0]).toMatchObject({ id: 'a', outcome: 'not_visible_yet', sku: 'SKU-a' })
    expect(m.updateMany).not.toHaveBeenCalled()
    expect(m.refresh).not.toHaveBeenCalled()
  })

  it('does not read Amazon for a row that already has its ASIN', async () => {
    m.listings = [listing('a', { externalListingId: 'B0HAD00001' })]
    const report = await fillAmazonListingAsins(['a'])
    expect(report.rows[0]).toMatchObject({ outcome: 'already_had_asin', asin: 'B0HAD00001' })
    expect(m.read).not.toHaveBeenCalled()
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it('reports a lost race as already had, never as filled', async () => {
    m.listings = [listing('a')]
    m.read.mockResolvedValue(found('B0MINE0001'))
    m.updateMany.mockResolvedValue({ count: 0 })
    m.findFirst.mockResolvedValue({ externalListingId: 'B0THEIRS01' })
    const report = await fillAmazonListingAsins(['a'])
    expect(report.rows[0]).toMatchObject({ outcome: 'already_had_asin', asin: 'B0THEIRS01' })
    expect(m.refresh).not.toHaveBeenCalled()
  })

  it('dry run reads Amazon and reports the same outcome, and writes nothing', async () => {
    m.listings = [listing('a'), listing('b')]
    m.read.mockResolvedValueOnce(found('B0DRY00001')).mockResolvedValueOnce(absent)
    const report = await fillAmazonListingAsins(['a', 'b'], { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.rows.map(r => [r.id, r.outcome, r.asin])).toEqual([['a', 'filled', 'B0DRY00001'], ['b', 'not_visible_yet', undefined]])
    expect(m.read).toHaveBeenCalledTimes(2)
    expect(m.updateMany).not.toHaveBeenCalled()
    expect(m.refresh).not.toHaveBeenCalled()
  })

  it('refuses rows it cannot read, without calling Amazon', async () => {
    m.listings = [
      listing('no-account', { channelConnectionId: null }),
      listing('two-offers', { offers: [{ sku: 'ONE', isActive: true }, { sku: 'TWO', isActive: true }] }),
      listing('alias', { aliasKey: 'alias-2' }),
      listing('ebay', { channel: 'EBAY' }),
    ]
    const report = await fillAmazonListingAsins(['no-account', 'two-offers', 'alias', 'ebay', 'missing'])
    expect(report.rows.map(r => [r.id, r.outcome])).toEqual([
      ['no-account', 'error'], ['two-offers', 'error'], ['alias', 'error'], ['ebay', 'error'], ['missing', 'error'],
    ])
    expect(report.rows[0].reason).toContain('no Amazon account')
    expect(report.rows[4].reason).toContain('No Amazon listing')
    expect(m.read).not.toHaveBeenCalled()
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it('reports an Amazon refusal per row and keeps going', async () => {
    m.listings = [listing('a'), listing('b')]
    m.read.mockResolvedValueOnce({ success: false, sku: 'x', asin: null, status: null, error: 'Access denied' }).mockResolvedValueOnce(found('B0NEXT0001'))
    const report = await fillAmazonListingAsins(['a', 'b'])
    expect(report.rows.map(r => [r.id, r.outcome])).toEqual([['a', 'error'], ['b', 'filled']])
    expect(report.rows[0].reason).toBe('Access denied')
  })

  it('reads a few rows at a time, not all at once', async () => {
    m.listings = Array.from({ length: 8 }, (_, i) => listing(`r${i}`))
    let active = 0
    let peak = 0
    m.read.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return absent })
    await fillAmazonListingAsins(m.listings.map(row => row.id))
    expect(m.read).toHaveBeenCalledTimes(8)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('refuses more than 200 rows in one call', async () => {
    await expect(fillAmazonListingAsins(Array.from({ length: 201 }, (_, i) => `id-${i}`))).rejects.toThrow('At most 200')
  })
})

describe('the rules it shares', () => {
  it('resolves the seller SKU the way Publish does', () => {
    const base = { aliasKey: '', offers: [], platformAttributes: null, flatFileSnapshot: null, product: { sku: 'PRODUCT' } }
    expect(sellerSkuOf(base)).toEqual({ sku: 'PRODUCT' })
    expect(sellerSkuOf({ ...base, offers: [{ sku: 'OFFER', isActive: true }, { sku: 'OLD', isActive: false }] })).toEqual({ sku: 'OFFER' })
    expect(sellerSkuOf({ ...base, flatFileSnapshot: { item_sku: 'FLAT' } })).toEqual({ sku: 'FLAT' })
    expect(sellerSkuOf({ ...base, offers: [{ sku: 'OFFER', isActive: true }], platformAttributes: { sellerSku: 'OTHER' } })).toHaveProperty('reason')
  })

  it('stores the status Amazon reports: the first entry, as-is', () => {
    expect(summaryStatus(found('B0', ['BUYABLE', 'DISCOVERABLE']))).toBe('BUYABLE')
    expect(summaryStatus(found('B0', ['DISCOVERABLE']))).toBe('DISCOVERABLE')
    expect(summaryStatus(found('B0', []))).toBeNull()
    expect(summaryStatus({ rawResponse: { summaries: [{ itemStatus: 'Active' }] } })).toBe('Active')
  })

  it('selects the operator default set and the sweep set without widening either', async () => {
    m.findMany.mockResolvedValue([{ id: 'x' }])
    expect(await unfilledAmazonListingIds()).toEqual(['x'])
    expect(m.findMany.mock.calls[0][0]).toMatchObject({
      where: { channel: 'AMAZON', externalListingId: null, product: { deletedAt: null }, OR: [{ isPublished: true }, { listingStatus: { not: 'DRAFT' } }] }, take: 200,
    })
    const now = Date.UTC(2026, 8, 27)
    expect(await pendingAsinListingIds(now)).toEqual(['x'])
    expect(m.findMany.mock.calls[1][0]).toMatchObject({
      where: { channel: 'AMAZON', externalListingId: null, isPublished: true, listingStatus: { in: ['ACTIVE', 'BUYABLE', 'DISCOVERABLE'] },
        channelConnectionId: { not: null }, updatedAt: { gte: new Date(now - ASIN_SWEEP_WINDOW_MS) } }, take: 50,
    })
  })
})
