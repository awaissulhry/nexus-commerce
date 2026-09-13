import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ listings: [] as any[], closed: new Set<string>(), patch: vi.fn(), update: vi.fn(), override: vi.fn(), find: vi.fn() }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchListingPrice: s.patch } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => s.closed }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (key: any) => key }))
import { pushPriceUpdate } from './pricing-outbound.service.js'
const db = {
  pricingSnapshot: { findFirst: async () => ({ computedPrice: 12, currency: 'EUR', source: 'fixture' }) },
  marketplace: { findUnique: async () => ({ marketplaceId: 'IT', taxInclusive: true }) },
  channelListing: { findMany: s.find, update: s.update }, channelListingOverride: { create: s.override },
} as any
const args = { sku: 'FIXTURE', channel: 'AMAZON', marketplace: 'IT' }
beforeEach(() => {
  vi.clearAllMocks(); s.closed = new Set()
  s.listings = [{ id: 'listing', productId: 'product', syncPaused: false, offerClosedAt: null, platformAttributes: { productType: 'OUTERWEAR' } }]
  s.find.mockImplementation(async () => s.listings)
  s.patch.mockResolvedValue({ success: true })
})
describe('direct price push lock', () => {
  it.each([{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))])('records a refusal without a channel call or IN_SYNC for %j', async lock => {
    Object.assign(s.listings[0], lock)
    const result = await pushPriceUpdate(db, args)
    expect(result).toMatchObject({ ok: false, pushedPrice: null, refusal: { code: expect.stringMatching(/^PUSH_/) } })
    expect(s.patch).not.toHaveBeenCalled(); expect(s.override).not.toHaveBeenCalled()
    expect(s.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'listing' }, data: {
      lastSyncStatus: 'SKIPPED', syncStatus: 'FAILED', lastSyncError: `${result.refusal!.code}: ${result.refusal!.sentence}`,
    } })
  })
  it('uses closedMarketSet as a second check before a replacement offer', async () => {
    s.closed.add('product|IT')
    expect((await pushPriceUpdate(db, args)).refusal?.code).toBe('PUSH_OFFER_CLOSED')
    expect(s.patch).not.toHaveBeenCalled()
  })
  it('positive control sends an unlocked price and records confirmed sync', async () => {
    expect((await pushPriceUpdate(db, args)).ok).toBe(true)
    expect(s.patch).toHaveBeenCalledOnce(); expect(s.override).toHaveBeenCalledOnce()
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'IN_SYNC' }) }))
  })
  it('does not record confirmed sync on a dry run', async () => {
    s.patch.mockResolvedValue({ success: true, dryRun: true })
    await pushPriceUpdate(db, args)
    expect(s.override).not.toHaveBeenCalled()
    expect(s.update).toHaveBeenCalledWith({ where: { id: 'listing' }, data: { lastSyncStatus: 'DRY_RUN', lastSyncError: null } })
  })
  it.each([0, 2])('refuses %i matches instead of selecting an arbitrary account/alias', async count => {
    s.listings = Array.from({ length: count }, () => s.listings[0])
    expect((await pushPriceUpdate(db, args)).ok).toBe(false)
    expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })
  it('honours explicit null attribution and alias without family SKU inference', async () => {
    await pushPriceUpdate(db, { ...args, channelConnectionId: null, aliasKey: '' })
    expect(s.find).toHaveBeenCalledWith({ where: { channel: 'AMAZON', marketplace: 'IT', product: { sku: 'FIXTURE' }, channelConnectionId: null, aliasKey: '' }, take: 2 })
  })
})
