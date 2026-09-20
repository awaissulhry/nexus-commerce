/**
 * P0.1 (docs/channel-connections/build/P0.1.md) — no dry run or sandbox write
 * reaches a live channel. Each writer below is exercised in every non-live mode
 * with a fetch spy that must stay untouched, plus a live positive control where
 * the writer has one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// P1.2 — Trading calls go through the channel gateway; its account check and ledger are stood in.
vi.mock('../services/gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../services/gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))

const s = vi.hoisted(() => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  return { fetch, db: vi.fn() }
})
// Any database touch means the refusal came too late.
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => new Proxy({}, { get: () => s.db }) }) }))

import { ebayHostOf, ebayWriteRefusal, assertEbayWriteAllowed, EbayWriteRefusedError } from './ebay-publish-gate.service.js'
import { assertShopifyWriteAllowed, ShopifyWriteRefusedError } from './shopify-publish-gate.service.js'
import { callTradingApi, TRADING_LISTING_WRITES } from './ebay-trading-api.service.js'
import { EtsyService } from './marketplaces/etsy.service.js'
import { publishEbayImagesViaInventory } from './images/ebay-inventory-image-publish.service.js'

const MODE_KEYS = ['NEXUS_ENABLE_EBAY_PUBLISH', 'EBAY_PUBLISH_MODE', 'EBAY_SANDBOX', 'NEXUS_ENABLE_SHOPIFY_PUBLISH', 'SHOPIFY_PUBLISH_MODE', 'NEXUS_EBAY_REAL_API']
function ebayMode(mode: 'gated' | 'dry-run' | 'sandbox' | 'live') {
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', mode === 'gated' ? '' : 'true')
  vi.stubEnv('EBAY_PUBLISH_MODE', mode === 'gated' ? '' : mode)
}
function shopifyMode(mode: 'gated' | 'dry-run' | 'live') {
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', mode === 'gated' ? '' : 'true')
  vi.stubEnv('SHOPIFY_PUBLISH_MODE', mode === 'gated' ? '' : mode)
}
const ok = (body: string) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body || '{}') })

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of MODE_KEYS) vi.stubEnv(key, '')
  s.db.mockImplementation(() => { throw new Error('DATABASE_TOUCHED') })
  s.fetch.mockResolvedValue(ok('{}'))
})
afterEach(() => vi.unstubAllEnvs())

describe('the eBay write rule', () => {
  it('classifies hosts; an unknown or broken URL counts as production', () => {
    expect(ebayHostOf('https://api.sandbox.ebay.com/sell')).toBe('sandbox')
    expect(ebayHostOf('https://api.sandbox.ebay.com/ws/api.dll')).toBe('sandbox')
    expect(ebayHostOf('https://api.ebay.com')).toBe('production')
    expect(ebayHostOf('https://fixture.invalid')).toBe('production')
    expect(ebayHostOf('')).toBe('production')
  })
  it.each([
    ['gated', 'production', 'turned off'], ['gated', 'sandbox', 'turned off'],
    ['dry-run', 'production', 'dry-run'], ['dry-run', 'sandbox', 'dry-run'],
    ['sandbox', 'production', 'has no sandbox'], ['live', 'sandbox', 'points at the eBay sandbox'],
  ] as const)('%s + %s host is refused (%s)', (mode, host, words) => {
    ebayMode(mode)
    expect(ebayWriteRefusal(host)).toContain(words)
    expect(ebayWriteRefusal(host)).toContain('Nothing was sent to eBay.')
    expect(() => assertEbayWriteAllowed(host)).toThrow(EbayWriteRefusedError)
  })
  it.each([['live', 'production'], ['sandbox', 'sandbox']] as const)('%s + %s host is allowed', (mode, host) => {
    ebayMode(mode)
    expect(ebayWriteRefusal(host)).toBeNull()
  })
})

describe('the Shopify write rule', () => {
  it.each(['gated', 'dry-run'] as const)('%s is refused', mode => {
    shopifyMode(mode)
    expect(() => assertShopifyWriteAllowed()).toThrow(ShopifyWriteRefusedError)
    expect(() => assertShopifyWriteAllowed()).toThrow('Nothing was sent to Shopify.')
  })
  it('live is allowed', () => { shopifyMode('live'); expect(() => assertShopifyWriteAllowed()).not.toThrow() })
})

describe('callTradingApi — every Trading listing write follows the publish mode', () => {
  const ctx = { oauthToken: 'fixture', siteId: '101', connectionId: 'conn-1' }
  beforeEach(() => { vi.stubEnv('NEXUS_EBAY_REAL_API', 'true'); s.fetch.mockResolvedValue(ok('<R><Ack>Success</Ack><ItemID>1</ItemID></R>')) })

  it.each([...TRADING_LISTING_WRITES].flatMap(call => (['gated', 'dry-run', 'sandbox'] as const).map(mode => [call, mode] as const)))(
    '%s in %s mode (production endpoint) sends nothing', async (call, mode) => {
      ebayMode(mode)
      await expect(callTradingApi(call, '<x/>', ctx)).rejects.toThrow('Nothing was sent to eBay')
      expect(s.fetch).not.toHaveBeenCalled()
    })
  it('positive control: live mode sends a listing write to production', async () => {
    ebayMode('live')
    await callTradingApi('ReviseFixedPriceItem', '<x/>', ctx)
    expect(s.fetch).toHaveBeenCalledOnce(); expect(s.fetch.mock.calls[0][0]).toBe('https://api.ebay.com/ws/api.dll')
  })
  it('sandbox mode with EBAY_SANDBOX=true sends to the sandbox endpoint', async () => {
    ebayMode('sandbox'); vi.stubEnv('EBAY_SANDBOX', 'true')
    await callTradingApi('ReviseFixedPriceItem', '<x/>', ctx)
    expect(s.fetch.mock.calls[0][0]).toBe('https://api.sandbox.ebay.com/ws/api.dll')
  })
  it.each(['GetItem', 'VerifyAddFixedPriceItem', 'GetNotificationPreferences'])('%s is a read and is not gated', async call => {
    ebayMode('dry-run')
    await callTradingApi(call, '<x/>', ctx)
    expect(s.fetch).toHaveBeenCalledOnce()
  })
  it('the local rehearsal (NEXUS_EBAY_REAL_API off, not production) still fakes success with no call', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'false'); vi.stubEnv('NODE_ENV', 'test'); ebayMode('dry-run')
    expect((await callTradingApi('AddFixedPriceItem', '<x/>', ctx)).itemId).toBe('DRYRUN-AddFixedPriceItem')
    expect(s.fetch).not.toHaveBeenCalled()
  })
})

// P1.6 — the old Shopify REST and GraphQL clients are deleted. What replaced their gate is the
// gateway rule in services/gateway/shopify-writes.p14.vitest.test.ts: a Shopify change leaves only on
// the 2026-07 GraphQL API with a named account.

describe('old Etsy client', () => {
  it.each(['gated', 'live'] as const)('the stock PATCH is refused even when Shopify/eBay are %s (Etsy is read-only)', async mode => {
    ebayMode(mode); shopifyMode(mode === 'gated' ? 'gated' : 'live')
    const etsy = new EtsyService({ accessToken: 'fixture', shopId: 'shop' } as any)
    await expect(etsy.updateVariationQuantity(1, 2, 3)).rejects.toThrow('Etsy is read-only in Nexus. Nothing was sent to Etsy.')
    expect(s.fetch).not.toHaveBeenCalled()
  })
})

describe('eBay image publish', () => {
  it.each(['gated', 'dry-run', 'sandbox'] as const)('%s mode refuses before any database read, job row or call', async mode => {
    ebayMode(mode)
    const result = await publishEbayImagesViaInventory('product', 'IT')
    expect(result).toMatchObject({ success: false, pictureCount: 0, colorSetCount: 0 })
    expect(result.message).toContain('Nothing was sent to eBay')
    expect(result.error).toBe(result.message)
    expect(result.jobId).toBeUndefined()
    expect(s.db).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled()
  })
  it('positive control: live mode passes the gate and reaches the database', async () => {
    ebayMode('live')
    await expect(publishEbayImagesViaInventory('product', 'IT')).rejects.toThrow('DATABASE_TOUCHED')
  })
})
