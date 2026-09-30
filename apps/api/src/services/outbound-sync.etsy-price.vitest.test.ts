/**
 * 2026-09-30 — an Etsy PRICE_UPDATE, end to end: `syncToEtsy` → `writeEtsyInventory` → the Etsy read and write clients
 * → the REAL channel gateway. Only the network is fake: `fetch` answers as Etsy would and records every request, so
 * what is asserted is the exact bytes that would have left for api.etsy.com, and the gateway's own ledger rows.
 *
 * The Owner's rules this file holds: only the target offering's price changes; every other product, offering and
 * quantity goes back byte-identical; a failed read sends nothing and is retried; the publish gate still answers
 * SKIPPED; nothing reaches a marketplace (`fetch` is the only way out and it is stubbed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  read: vi.fn(), market: vi.fn(), audit: vi.fn(), alerts: vi.fn(),
  requests: [] as Array<{ url: string; method: string; body: string | null; contentType: string | null }>,
  answers: [] as Array<{ status: number; body: unknown }>,
}))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findUnique: m.read, findMany: vi.fn(async () => []) },
  marketplace: { findFirst: m.market },
  product: { findUnique: vi.fn(async () => ({ minPrice: null, maxPrice: null })) },
  outboundSyncQueue: { update: vi.fn() },
} }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
// The gateway's two database touches, and the token: stand-ins, as in `etsy-publish-gate.p46`.
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((s) => s.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((s) => s.ledgerModule))
vi.mock('./cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'etsy-token') }))
// The shop identity and app key (a database read). Everything else in account.ts is real.
vi.mock('./etsy/account.js', async (original) => ({
  ...(await original<typeof import('./etsy/account.js')>()),
  etsyAccount: vi.fn(async (accountId: string) => ({ accountId, shopId: '42', apiKey: 'keystring:secret' })),
}))
vi.mock('./cx/channel-alerts.service.js', async (original) => ({
  ...(await original<typeof import('./cx/channel-alerts.service.js')>()),
  raiseChannelAlert: m.alerts,
}))

import { gatewayLedger } from '../test-support/gateway-stubs.js'
import { __rateTest } from './gateway/rate.js'
import { toInventoryWrite, type EtsyReadInventory } from './etsy/inventory.js'

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const service: any = new OutboundSyncService()

const LISTING_ID = '1234567890'
const INVENTORY_URL = `https://api.etsy.com/v3/application/listings/${LISTING_ID}/inventory`
const money = (amount: number, currency_code = 'EUR') => ({ amount, divisor: 100, currency_code })
const colour = (id: number, name: string) => ({ property_id: 200, property_name: 'Colour', scale_id: null, scale_name: null, value_ids: [id], values: [name] })

/** Etsy's GET answer: three colours priced by colour, one disabled, one deleted product that must not come back. */
const etsyInventory = (): EtsyReadInventory => ({
  products: [
    { product_id: 11, sku: 'TEST-RED', is_deleted: false, property_values: [colour(1, 'Red')],
      offerings: [{ offering_id: 91, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999), readiness_state_id: 7 }] },
    { product_id: 12, sku: 'TEST-BLU', is_deleted: false, property_values: [colour(2, 'Blue')],
      offerings: [{ offering_id: 92, quantity: 0, is_enabled: false, is_deleted: false, price: money(2450), readiness_state_id: null }] },
    { product_id: 13, sku: 'TEST-GRN', is_deleted: false, property_values: [colour(3, 'Green')],
      offerings: [{ offering_id: 93, quantity: 17, is_enabled: true, is_deleted: false, price: money(2100), readiness_state_id: 7 }] },
    { product_id: 14, sku: 'TEST-OLD', is_deleted: true, property_values: [colour(4, 'Old')],
      offerings: [{ offering_id: 94, quantity: 3, is_enabled: true, is_deleted: true, price: money(999), readiness_state_id: 7 }] },
  ],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
})
/** What Etsy holds after the PUT landed: the target price moved, nothing else. */
const afterPut = (sku: string, amount: number) => {
  const inv = etsyInventory()
  inv.products!.find((p) => p.sku === sku)!.offerings![0].price = money(amount)
  return inv
}

const listing = { id: 'cl-etsy-1', productId: 'p-1', channel: 'ETSY', marketplace: 'GLOBAL', syncPaused: false, listingStatus: 'ACTIVE', externalListingId: LISTING_ID, channelConnectionId: 'etsy-acct' }
const row = (over: Record<string, unknown> = {}) => ({
  id: 'q-etsy-1', channelListingId: listing.id, targetChannel: 'ETSY', syncType: 'PRICE_UPDATE', channelConnectionId: 'etsy-acct',
  product: { id: 'p-1', sku: 'TEST-GRN', etsySku: null },
  channelListing: listing,
  payload: { source: 'CHANNEL_PRICE_WRITE', marketplace: 'GLOBAL', price: 26, salePrice: null, salePriceStart: null, salePriceEnd: null },
  ...over,
})
const live = () => { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live') }
const puts = () => m.requests.filter((r) => r.method === 'PUT')
const gets = () => m.requests.filter((r) => r.method === 'GET')

beforeEach(() => {
  vi.clearAllMocks()
  __rateTest.useMemory(); gatewayLedger.length = 0
  m.requests = []; m.answers = []
  vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', ''); vi.stubEnv('ETSY_PUBLISH_MODE', '')
  m.read.mockResolvedValue(listing)
  m.market.mockResolvedValue({ currency: 'EUR' })
  // Every request is recorded; answers are served in order. An unplanned request fails the test loudly.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    m.requests.push({ url: String(url), method: String(init.method), body: init.body == null ? null : String(init.body), contentType: headers.get('content-type') })
    const next = m.answers.shift()
    if (!next) throw new Error(`Unexpected request: ${init.method} ${url}`)
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __rateTest.reset() })

describe('🔴 only the target offering\'s price changes', () => {
  it('the PUT is Etsy\'s own inventory with one price moved, and every other byte as Etsy stated it', async () => {
    live()
    m.answers.push({ status: 200, body: etsyInventory() }, { status: 200, body: {} }, { status: 200, body: afterPut('TEST-GRN', 2600) })
    const result = await service.syncToEtsy(row())

    expect(result).toMatchObject({ success: true, status: 'SUCCESS', message: `Etsy listing ${LISTING_ID} updated and confirmed.` })
    // Read → write → read back, all to the one inventory URL, and nothing else left.
    expect(m.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${INVENTORY_URL}`, `PUT ${INVENTORY_URL}`, `GET ${INVENTORY_URL}`])
    expect(puts()[0].contentType).toBe('application/json')

    const sent = JSON.parse(puts()[0].body!)
    const expected = toInventoryWrite(etsyInventory())
    expected.products[2].offerings[0].price = 26
    expect(sent).toEqual(expected)
    // The set claim, per product: the two products not being priced leave as the SAME BYTES Etsy's read produced
    // (one of them disabled with no stock, whose quantity 0 and is_enabled false must survive as they are).
    const asRead = toInventoryWrite(etsyInventory())
    expect(JSON.stringify(sent.products[0])).toBe(JSON.stringify(asRead.products[0]))
    expect(JSON.stringify(sent.products[1])).toBe(JSON.stringify(asRead.products[1]))
    // And the priced one: only its price differs.
    expect(sent.products[2]).toEqual({ ...asRead.products[2], offerings: [{ ...asRead.products[2].offerings[0], price: 26 }] })
    expect(JSON.stringify({ ...sent, products: null })).toBe(JSON.stringify({ ...asRead, products: null }))
    // 🔴 Quantities: every one exactly as Etsy stated it (the PUT is a full replace and must carry them).
    expect(sent.products.map((p: { offerings: Array<{ quantity: number }> }) => p.offerings[0].quantity)).toEqual([4, 0, 17])
    // The deleted product is not resurrected, and no read-only key goes back.
    expect(sent.products.map((p: { sku: string }) => p.sku)).toEqual(['TEST-RED', 'TEST-BLU', 'TEST-GRN'])
    expect(puts()[0].body).not.toMatch(/product_id|offering_id|is_deleted|scale_name/)
  }, 15_000)

  it('through the gateway: one ledger row per call, all ETSY, on the account the row names', async () => {
    live()
    m.answers.push({ status: 200, body: etsyInventory() }, { status: 200, body: {} }, { status: 200, body: afterPut('TEST-GRN', 2600) })
    await service.syncToEtsy(row())
    expect(gatewayLedger.map((l: any) => [l.channel, l.method, l.outcome, l.success])).toEqual([
      ['ETSY', 'GET', 'sent', true], ['ETSY', 'PUT', 'sent', true], ['ETSY', 'GET', 'sent', true],
    ])
    expect(new Set(gatewayLedger.map((l: any) => l.connectionId))).toEqual(new Set(['etsy-acct']))
  }, 15_000)

  it('a price Etsy already holds sends no PUT at all', async () => {
    live()
    m.answers.push({ status: 200, body: etsyInventory() })
    const result = await service.syncToEtsy(row({ payload: { price: 21 } }))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS', message: 'Etsy already holds these values; nothing was sent.' })
    expect(puts()).toEqual([])
  })
})

describe('🔴 a failed read sends nothing, and is retried', () => {
  it('Etsy unavailable on the read: FAILED, retryable, and no PUT', async () => {
    live()
    // The gateway retries a failed READ once itself (a read is safe to repeat); both answers fail.
    m.answers.push({ status: 503, body: { error: 'unavailable' } }, { status: 503, body: { error: 'unavailable' } })
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: false, status: 'FAILED', retryable: true })
    expect(result.message).toContain('HTTP 503')
    expect(puts()).toEqual([])
    expect(gets()).toHaveLength(2)
  }, 15_000)
})

describe('🔴 refusals: nothing sent, and not retried (the same inventory gives the same answer)', () => {
  it('Etsy prices this listing in another currency', async () => {
    live()
    const usd = etsyInventory(); for (const p of usd.products!) p.offerings![0].price = money(1999, 'USD')
    m.answers.push({ status: 200, body: usd })
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: false, status: 'FAILED', retryable: false })
    expect(result.message).toBe('Etsy prices this listing in USD, and Nexus holds this price in EUR. A price is never converted, so nothing was sent.')
    expect(puts()).toEqual([])
  })

  it('a listing whose one price is shared by every variation', async () => {
    live()
    const shared = etsyInventory(); shared.price_on_property = []
    for (const p of shared.products!) p.offerings![0].price = money(2000)
    m.answers.push({ status: 200, body: shared })
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: false, status: 'FAILED', retryable: false })
    expect(result.message).toContain('has one price for all its 3 variations')
    expect(puts()).toEqual([])
  })

  it('a SKU Etsy does not have on this listing', async () => {
    live()
    m.answers.push({ status: 200, body: etsyInventory() })
    const result = await service.syncToEtsy(row({ product: { id: 'p-1', sku: 'TEST-NOPE' } }))
    expect(result).toMatchObject({ success: false, status: 'FAILED', retryable: false })
    expect(result.message).toContain('Etsy has no product with SKU "TEST-NOPE"')
    expect(puts()).toEqual([])
  })

  it('no currency configured for the Etsy market: refused before any call', async () => {
    live()
    m.market.mockResolvedValue(null)
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'MARKET_CURRENCY_UNCONFIGURED', retryable: false })
    expect(result.message).toBe('No currency is configured for ETSY/GLOBAL. Set it on the marketplace before pricing there. The price was not written.')
    expect(m.requests).toEqual([])
  })

  it.each([[undefined], [null], [''], ['abc'], [0], [-3]])('a price row carrying %p is refused by name, before any call', async (price) => {
    live()
    const result = await service.syncToEtsy(row({ payload: { price } }))
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'NO_PRICE', retryable: false })
    expect(m.requests).toEqual([])
  })
})

describe('the Etsy publish gate is unchanged', () => {
  it.each([['', ''], ['true', ''], ['false', 'live']])('NEXUS_ENABLE_ETSY_PUBLISH=%p ETSY_PUBLISH_MODE=%p: SKIPPED, and not even a read', async (flag, mode) => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', flag); vi.stubEnv('ETSY_PUBLISH_MODE', mode)
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', dryRun: true })
    expect(result.message).toMatch(/^Etsy (gated|dry-run) — not published \(set NEXUS_ENABLE_ETSY_PUBLISH=true \+ ETSY_PUBLISH_MODE=live\)$/)
    expect(m.requests).toEqual([])
  })
})

describe('a Nexus sale on an Etsy listing', () => {
  it('is named as staying in Nexus: Etsy has no per-listing sale price', async () => {
    live()
    m.answers.push({ status: 200, body: etsyInventory() })
    const result = await service.syncToEtsy(row({ payload: { price: 21, salePrice: 19, salePriceStart: '2026-10-01', salePriceEnd: '2026-10-08' } }))
    expect(result.message).toBe('Etsy already holds these values; nothing was sent. Etsy has no per-listing sale price, so the sale price stays in Nexus only.')
    expect(puts()).toEqual([])
  })
})
