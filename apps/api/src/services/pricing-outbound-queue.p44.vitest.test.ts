/**
 * P4.4d — the pricing dispatcher reaches eBay (and Shopify, and Woo) through the
 * ONE outbound queue instead of growing a second sender.
 *
 * What is asserted: the row it writes NAMES its listing and its account, carries
 * `price` (the key the dispatcher reads), and is refused rather than guessed
 * when the coordinate is ambiguous or the listing is locked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, snapshot: vi.fn(), listings: vi.fn(), createRow: vi.fn(), allowed: vi.fn() }
})
vi.mock('./outbound-rows.js', () => ({ createOutboundRow: m.createRow }))
vi.mock('@nexus/shared/push-lock', () => ({ assertPushAllowed: m.allowed }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => null }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: {} }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))

const { pushPriceUpdate } = await import('./pricing-outbound.service.js')

const prisma = {
  pricingSnapshot: { findFirst: m.snapshot },
  channelListing: { findMany: m.listings },
} as never

const LISTING = { id: 'cl-1', productId: 'p-1', channelConnectionId: 'ebay-a', region: 'EU', externalListingId: '1234' }

describe('P4.4d: eBay prices go through the one queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.snapshot.mockResolvedValue({ computedPrice: '49.90', currency: 'EUR' })
    m.listings.mockResolvedValue([LISTING])
    m.allowed.mockReturnValue(null)
    m.createRow.mockResolvedValue({ id: 'q-1' })
  })
  const push = (over: Record<string, unknown> = {}) =>
    pushPriceUpdate(prisma, { sku: 'SKU-1', channel: 'EBAY', marketplace: 'IT', ...over } as never)

  it('queues a row that NAMES its listing and its account, carrying `price`', async () => {
    const result = await push()
    expect(result).toMatchObject({ ok: true, queued: true, queueId: 'q-1', channel: 'EBAY', pushedPrice: 49.9, currency: 'EUR' })
    const data = m.createRow.mock.calls[0][1].data
    // P4.4b — without the listing the whole chain behind it is off, and the
    // engine would refuse the row outright.
    expect(data).toMatchObject({
      channelListingId: 'cl-1', channelConnectionId: 'ebay-a', productId: 'p-1',
      targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', externalListingId: '1234',
    })
    // The dispatcher reads `payload.price`, never `newPrice` (P4.4b's repricer defect).
    expect(data.payload).toMatchObject({ price: 49.9, source: 'PRICING_SNAPSHOT_PUSH' })
    expect(data.payload.newPrice).toBeUndefined()
  })

  it.each([['SHOPIFY'], ['WOOCOMMERCE']])('%s takes the same road', async (channel) => {
    await expect(push({ channel })).resolves.toMatchObject({ ok: true, queued: true, channel })
  })

  it('🔴 Etsy takes the same road: its sender exists (P4.6e) and D6 was overridden 2026-09-21', async () => {
    const result = await push({ channel: 'ETSY', marketplace: 'GLOBAL' })
    expect(result).toMatchObject({ ok: true, queued: true, queueId: 'q-1', channel: 'ETSY' })
    expect(m.createRow.mock.calls[0][1].data).toMatchObject({ channelListingId: 'cl-1', targetChannel: 'ETSY', syncType: 'PRICE_UPDATE', payload: { price: 49.9 } })
  })

  it('an unknown channel is refused with a plain sentence', async () => {
    await expect(push({ channel: 'TIKTOK' })).resolves.toMatchObject({ ok: false })
    expect(m.createRow).not.toHaveBeenCalled()
  })

  it('no listing: refused, and nothing is queued', async () => {
    m.listings.mockResolvedValue([])
    const result = await push()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No EBAY IT listing for SKU-1')
    expect(m.createRow).not.toHaveBeenCalled()
  })

  it('🔴 TWO listings: refused, never resolved by picking one', async () => {
    m.listings.mockResolvedValue([LISTING, { ...LISTING, id: 'cl-2', channelConnectionId: 'ebay-b' }])
    const result = await push()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('More than one')
    expect(m.createRow).not.toHaveBeenCalled()
  })

  it('a named account narrows the search rather than filtering after it', async () => {
    await push({ channelConnectionId: 'ebay-b' })
    expect(m.listings.mock.calls[0][0].where).toMatchObject({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'ebay-b' })
  })

  it('a locked listing is refused with the push lock\'s own sentence', async () => {
    m.allowed.mockReturnValue({ code: 'PRESENCE_HELD', sentence: 'This listing is held.' })
    const result = await push()
    expect(result).toMatchObject({ ok: false, refusal: { code: 'PRESENCE_HELD' } })
    expect(result.error).toBe('This listing is held.')
    expect(m.createRow).not.toHaveBeenCalled()
  })

  it('no snapshot: refused before any listing read', async () => {
    m.snapshot.mockResolvedValue(null)
    await expect(push()).resolves.toMatchObject({ ok: false, pushedPrice: null })
    expect(m.listings).not.toHaveBeenCalled()
  })

  it('no outbound call is ever made from here', () => {
    expect(m.outbound).not.toHaveBeenCalled()
  })
})

describe('P4.4d: no second eBay sender was built', () => {
  it('the dispatcher makes no eBay call of its own', () => {
    const source = readFileSync(new URL('./pricing-outbound.service.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('queuePriceUpdate')            // the stripper left the file
    // P1.1 holds channel sends outside the gateway at 0. A ReviseInventoryStatus
    // here would need its own exemption, and its own idea of the currency, the
    // push lock and the market — which is the drift that ratchet exists to stop.
    expect(code).not.toMatch(/ReviseInventoryStatus/)
    expect(code).not.toMatch(/callTradingApi|ebayTransport|fetch\(/)
    expect(code).not.toMatch(/NOT_IMPLEMENTED/)
  })
})
