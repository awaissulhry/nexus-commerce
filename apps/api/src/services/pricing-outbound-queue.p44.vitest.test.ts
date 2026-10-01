/**
 * P4.4d → 2026-10-01 — `/pricing`'s "Push price" (`pushPriceUpdate`) reaches EVERY channel through the ONE channel
 * price door, and the one outbound queue behind it, instead of a sender of its own.
 *
 * What is asserted here (the door itself is mocked; `pim/price-door-push.vitest.test.ts` runs the real one): the push
 * names exactly ONE listing — refused rather than guessed when the coordinate is ambiguous or missing — and asks the
 * door to SEND the price that listing carries (`resend`, named reason `pricing-push`); the door's own refusal is the
 * answer's; and nothing is sent from this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, snapshot: vi.fn(), listings: vi.fn(), door: vi.fn(), allowed: vi.fn() }
})
vi.mock('./pim/channel-price-write.service.js', () => ({ writeChannelPrices: m.door }))
vi.mock('@nexus/shared/push-lock', () => ({ assertPushAllowed: m.allowed }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))

import { pushPriceUpdate } from './pricing-outbound.service.js'

const prisma = {
  pricingSnapshot: { findFirst: m.snapshot },
  channelListing: { findMany: m.listings },
} as never

const LISTING = { id: 'cl-1', productId: 'p-1', channelConnectionId: 'ebay-a', region: 'EU', externalListingId: '1234' }

describe('Push price: every channel goes through the price door', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.snapshot.mockResolvedValue({ currency: 'EUR' })
    m.listings.mockResolvedValue([LISTING])
    m.allowed.mockReturnValue(null)
    m.door.mockResolvedValue({ results: [{ listingId: 'cl-1', outcome: 'applied', queueId: 'q-1', sentPrice: 49.9, sentCurrency: 'EUR' }] })
  })
  const push = (over: Record<string, unknown> = {}) =>
    pushPriceUpdate(prisma, { sku: 'SKU-1', channel: 'EBAY', marketplace: 'IT', ...over } as never)

  it('asks the door to SEND the price the ONE listing carries, with a named reason; the answer is queued, not sent', async () => {
    const result = await push()
    expect(result).toMatchObject({ ok: true, queued: true, queueId: 'q-1', channel: 'EBAY', pushedPrice: 49.9, currency: 'EUR' })
    expect(m.door).toHaveBeenCalledOnce()
    expect(m.door.mock.calls[0][0]).toEqual({
      targets: [{ listingId: 'cl-1', resend: true, unguardedReason: 'pricing-push' }],
      actor: 'pricing-push', source: 'MANUAL_OVERRIDE', reason: 'Push price (/pricing)',
    })
  })

  it('🔴 the answer\'s currency is the one the door queued the price in (the listing market\'s), never the engine snapshot\'s', async () => {
    m.door.mockResolvedValue({ results: [{ listingId: 'cl-1', outcome: 'applied', queueId: 'q-1', sentPrice: 25, sentCurrency: 'GBP' }] })
    await expect(push({ marketplace: 'UK' })).resolves.toMatchObject({ ok: true, pushedPrice: 25, currency: 'GBP' })
    expect(m.snapshot).not.toHaveBeenCalled()
    // A market with no currency configured: said as none, not guessed.
    m.door.mockResolvedValue({ results: [{ listingId: 'cl-1', outcome: 'applied', queueId: 'q-1', sentPrice: 25, sentCurrency: null }] })
    await expect(push()).resolves.toMatchObject({ ok: true, currency: null })
  })

  it.each([['AMAZON'], ['SHOPIFY'], ['WOOCOMMERCE'], ['ETSY']])('%s takes the same road (Amazon too: no direct send)', async (channel) => {
    await expect(push({ channel })).resolves.toMatchObject({ ok: true, queued: true, channel })
    expect(m.door.mock.calls[0][0].targets).toEqual([{ listingId: 'cl-1', resend: true, unguardedReason: 'pricing-push' }])
  })

  it('the door\'s refusal is the answer, in its own words', async () => {
    m.door.mockResolvedValue({ results: [{ listingId: 'cl-1', outcome: 'refused', reason: 'SKU-1 on EBAY IT: nothing was sent — this listing\'s sync is paused. Resume it to send its price.' }] })
    const result = await push()
    expect(result).toMatchObject({ ok: false, pushedPrice: null })
    expect(result.error).toContain('sync is paused')
  })

  it('an unknown channel is refused with a plain sentence', async () => {
    await expect(push({ channel: 'TIKTOK' })).resolves.toMatchObject({ ok: false })
    expect(m.door).not.toHaveBeenCalled()
  })

  it('no listing: refused, and nothing is queued', async () => {
    m.listings.mockResolvedValue([])
    const result = await push()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No EBAY IT listing for SKU-1')
    expect(m.door).not.toHaveBeenCalled()
  })

  it('🔴 TWO listings: refused, never resolved by picking one', async () => {
    m.listings.mockResolvedValue([LISTING, { ...LISTING, id: 'cl-2', channelConnectionId: 'ebay-b' }])
    const result = await push()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('More than one')
    expect(m.door).not.toHaveBeenCalled()
  })

  it('a named account narrows the search rather than filtering after it', async () => {
    await push({ channelConnectionId: 'ebay-b' })
    expect(m.listings.mock.calls[0][0].where).toMatchObject({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'ebay-b' })
  })

  it('a locked listing is refused with the push lock\'s own sentence, before the door', async () => {
    m.allowed.mockReturnValue({ code: 'PRESENCE_HELD', sentence: 'This listing is held.' })
    const result = await push()
    expect(result).toMatchObject({ ok: false, refusal: { code: 'PRESENCE_HELD' } })
    expect(result.error).toBe('This listing is held.')
    expect(m.door).not.toHaveBeenCalled()
  })

  it('no snapshot is no longer a refusal: the price is the listing\'s, so the push goes on — and the currency is still known, the market\'s from the door (it was null)', async () => {
    m.snapshot.mockResolvedValue(null)
    await expect(push()).resolves.toMatchObject({ ok: true, queued: true, pushedPrice: 49.9, currency: 'EUR' })
  })

  it('no outbound call is ever made from here', () => {
    expect(m.outbound).not.toHaveBeenCalled()
  })
})

describe('no second sender: Push price has no channel call of its own', () => {
  it('the push names the door and no transport', () => {
    const source = readFileSync(new URL('./pricing-outbound.service.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('writeChannelPrices(')         // the stripper left the file
    // P1.1 holds channel sends outside the gateway at 0. A send here would need its own exemption, and its own idea of
    // the currency, the push lock and the market — the drift the door and that ratchet exist to stop.
    expect(code).not.toMatch(/ReviseInventoryStatus|patchListingPrice|patchPurchasableOffer|amazonSpApiClient/)
    expect(code).not.toMatch(/callTradingApi|ebayTransport|fetch\(|createOutboundRow|outboundSyncQueue/)
  })
})
