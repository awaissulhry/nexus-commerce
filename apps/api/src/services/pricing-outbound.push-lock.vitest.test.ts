/**
 * Presence W1.5 → 2026-10-01 — "Push price" honours the push lock before it asks the price door for anything.
 *
 * Every lock (paused, a closed offer, a held/withdrawn/ended/discontinued/released presence) and the
 * `closedMarketSet` belt refuse the push with the lock's own code and sentence: the door is never asked, nothing is
 * queued, no channel is called, and nothing is written — the push no longer sends directly, so it has no IN_SYNC or
 * sync-status of its own to record (the dispatcher records what it sends). The real door: `pim/price-door-push`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ listings: [] as any[], closed: new Set<string>(), door: vi.fn(), update: vi.fn(), find: vi.fn(), patch: vi.fn() }))
vi.mock('./pim/channel-price-write.service.js', () => ({ writeChannelPrices: s.door }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchListingPrice: s.patch, patchPurchasableOffer: s.patch } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => s.closed }))
import { pushPriceUpdate } from './pricing-outbound.service.js'
const db = {
  pricingSnapshot: { findFirst: async () => ({ currency: 'EUR' }) },
  channelListing: { findMany: s.find, update: s.update },
} as any
const args = { sku: 'FIXTURE', channel: 'AMAZON', marketplace: 'IT' }
beforeEach(() => {
  vi.clearAllMocks(); s.closed = new Set()
  s.listings = [{ id: 'listing', productId: 'product', syncPaused: false, offerClosedAt: null, platformAttributes: { productType: 'OUTERWEAR' } }]
  s.find.mockImplementation(async () => s.listings)
  s.door.mockResolvedValue({ results: [{ listingId: 'listing', outcome: 'applied', queueId: 'q-1', sentPrice: 12 }] })
})
describe('Push price: the push lock answers first', () => {
  it.each([{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))])('refuses %j by name: no door, no channel call, nothing written', async lock => {
    Object.assign(s.listings[0], lock)
    const result = await pushPriceUpdate(db, args)
    expect(result).toMatchObject({ ok: false, pushedPrice: null, refusal: { code: expect.stringMatching(/^PUSH_/) } })
    expect(result.error).toBe(result.refusal!.sentence)
    expect(s.door).not.toHaveBeenCalled(); expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })
  it('uses closedMarketSet as a second check before a replacement offer', async () => {
    s.closed.add('product|IT')
    expect((await pushPriceUpdate(db, args)).refusal?.code).toBe('PUSH_OFFER_CLOSED')
    expect(s.door).not.toHaveBeenCalled(); expect(s.patch).not.toHaveBeenCalled()
  })
  it('positive control: an unlocked listing is queued through the door — no direct Amazon call, no IN_SYNC written here', async () => {
    expect(await pushPriceUpdate(db, args)).toMatchObject({ ok: true, queued: true, queueId: 'q-1', pushedPrice: 12 })
    expect(s.door).toHaveBeenCalledOnce()
    expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })
  it.each([0, 2])('refuses %i matches instead of selecting an arbitrary account/alias', async count => {
    s.listings = Array.from({ length: count }, () => s.listings[0])
    expect((await pushPriceUpdate(db, args)).ok).toBe(false)
    expect(s.door).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })
  it('honours explicit null attribution and alias without family SKU inference', async () => {
    await pushPriceUpdate(db, { ...args, channelConnectionId: null, aliasKey: '' })
    expect(s.find).toHaveBeenCalledWith({ where: { channel: 'AMAZON', marketplace: 'IT', product: { sku: 'FIXTURE' }, channelConnectionId: null, aliasKey: '' }, take: 2 })
  })
})
