/**
 * P4.4 (CX) B1 — an eBay Inventory-lane price write is CONFIRMED, and nothing heals it.
 *
 *   1. before the PUT: the offers of this SKU are asked for WITH this marketplace, and exactly one
 *      FIXED_PRICE offer of this marketplace is priced — none or several are refused before any write
 *      (the old code took `offers[0]` of an unfiltered list);
 *   2. after a 2xx PUT (200 or 204): ONE `GET /offer/{offerId}` through the same account, as a gateway
 *      read on the call ledger — started by the completion writer AFTER the row has its answer
 *      (`afterAnswer`), outside the dispatch budget; compared in integer cents and in the market's currency;
 *   3. a mismatch or an unreadable answer: the row stays SUCCESS (the write happened), a
 *      CHANNEL_PRICE_READBACK "price unconfirmed" conflict is recorded (24 h dedupe), no second PUT,
 *      no queue row, not retryable. Dry-run returns before any of it.
 *
 * The publish mode is `live`; `fetch` is the only way out and records every call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// processSingle's per-row budget is read at module load: the lowest the service allows (5 s).
vi.hoisted(() => { process.env.NEXUS_SYNC_DISPATCH_TIMEOUT_MS = '5000' })
const h = vi.hoisted(() => ({
  putDelayMs: 0,
  queueStatus: 'PENDING',
  queueUpdates: [] as Array<Record<string, any>>,
  pendingRows: [] as Array<Record<string, any>>,
  retryRows: [] as Array<Record<string, any>>,
  acquired: [] as Array<[string, string]>,
  calls: [] as Array<{ method: string; url: string; auth: string; market: string; body: string | null }>,
  offers: [] as Array<Record<string, unknown>>,
  putStatus: 200,
  readStatus: 200,
  readBody: {} as unknown,
  afterPut: null as null | (() => void),
  listingMarket: 'IT',
  clNull: false,
  hangRead: false,
  readSignal: null as AbortSignal | null,
  releaseHungRead: null as null | (() => void),
  statusAtRead: [] as string[],
  updateDelayMs: 0,
  itemPut25004: false,
  existingKeys: new Set<string>(),
  logConflict: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  createOutboundRow: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  findFirstLog: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  attemptCreate: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}))
h.logConflict = vi.fn(async () => ({ id: 'log-1' }))
h.createOutboundRow = vi.fn(async () => ({ id: 'row-x' }))
h.attemptCreate = vi.fn(async () => ({}))
h.findFirstLog = vi.fn(async ({ where }: any) => (h.existingKeys.has(String(where?.conflictData?.equals)) ? { id: 'old' } : null))

const queueRow = () => ({ id: 'q1', holdUntil: null, traceId: null, channelListingId: 'listing-1', channelConnectionId: 'conn-B', targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', productId: 'p1', product: { id: 'p1', sku: 'SKU-1' }, payload: { price: 19.9 }, retryCount: 0, maxRetries: 3 })
const CURRENCY: Record<string, string> = { UK: 'GBP', GB: 'GBP', IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR' } // SE: none configured
vi.mock('../db.js', () => ({
  default: {
    marketplace: {
      findFirst: async (a: any) => {
        const code = String(a?.where?.code ?? '').toUpperCase()
        return { currency: CURRENCY[code] ?? null, languages: [code === 'DE' ? 'de' : code === 'UK' ? 'en' : 'it'] }
      },
      findMany: async () => [],
    },
    channelListing: {
      findUnique: vi.fn(async () => (h.clNull ? null : { stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: h.listingMarket, syncPaused: false })),
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.id?.in) return where.id.in.includes('listing-1') ? [{ id: 'listing-1', channelConnectionId: 'conn-B' }] : []
        return where?.OR?.some((w: any) => w.id?.in?.includes('listing-1')) ? [{ channelConnectionId: 'conn-B' }] : []
      }),
    },
    sharedListingMembership: { findMany: vi.fn(async () => []) },
    channelConnection: { findMany: vi.fn(async () => [{ id: 'conn-A', displayName: 'Primary shop', externalAccountId: 'a' }, { id: 'conn-B', displayName: 'Second shop', externalAccountId: 'b' }]) },
    stockLevel: { findMany: vi.fn(async ({ where }: any) => ((where?.productId?.in ?? ['p1']).map((productId: string) => ({ productId, quantity: 50, available: 50, location: { type: 'WAREHOUSE', code: 'IT-MAIN', syncRoutes: [] } })))), aggregate: vi.fn(async () => null) },
    stockPoolLink: { findMany: vi.fn(async () => []) },
    offer: { findFirst: vi.fn(async () => null) },
    product: { findUnique: vi.fn(async () => ({ minPrice: null, maxPrice: null })), findUniqueOrThrow: vi.fn() },
    syncHealthLog: { findFirst: (...a: unknown[]) => h.findFirstLog(...a) },
    outboundSyncQueue: {
      findUnique: vi.fn(async () => ({ ...queueRow(), syncStatus: h.queueStatus })),
      findMany: vi.fn(async ({ where }: any) => (where?.syncStatus === 'PENDING' ? h.pendingRows : where?.syncStatus === 'FAILED' ? h.retryRows : [])),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where?.syncStatus !== h.queueStatus) return { count: 0 }
        h.queueStatus = data.syncStatus
        return { count: 1 }
      }),
      update: vi.fn(async ({ data }: any) => {
        h.queueUpdates.push(data)
        // A row write that takes time: the status lands when the write does, not when it is called.
        if (h.updateDelayMs) await new Promise((resolve) => setTimeout(resolve, h.updateDelayMs))
        if (data?.syncStatus) h.queueStatus = data.syncStatus
        return {}
      }),
    },
    outboundApiCallLog: { create: vi.fn(async () => ({})) },
    channelPublishAttempt: { create: (...a: unknown[]) => h.attemptCreate(...a) },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./connection-resolver.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection-resolver.service.js')>()),
  tryResolveConnection: vi.fn(async ({ accountId }: { accountId?: string }) => (accountId ? { id: accountId, channelType: 'EBAY', isPrimary: accountId === 'conn-A' } : null)),
  listActiveConnections: vi.fn(async () => [{ id: 'conn-A', channelType: 'EBAY', isActive: true, isPrimary: true }, { id: 'conn-B', channelType: 'EBAY', isActive: true, isPrimary: false }]),
}))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./sync-health.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync-health.service.js')>()),
  syncHealthService: { logConflict: (...a: unknown[]) => h.logConflict(...a) },
}))
vi.mock('./outbound-rows.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbound-rows.js')>()),
  createOutboundRow: (...a: unknown[]) => h.createOutboundRow(...a),
}))
vi.mock('./ebay-publish-gate.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ebay-publish-gate.service.js')>()
  return { ...real, acquireEbayPublishToken: (connectionId: string, marketplaceId: string, ...rest: unknown[]) => { h.acquired.push([connectionId, marketplaceId]); return (real.acquireEbayPublishToken as any)(connectionId, marketplaceId, ...rest) } }
})
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))

import { OutboundSyncService } from './outbound-sync.service.js'
import { gatewayAccounts, gatewayLedger } from '../test-support/gateway-stubs.js'
import { ebayMarketplaceIdOf, ebayOfferPriceReadback, ebayPriceUnconfirmedMessage, pickEbayPriceOffer, recordEbayPriceUnconfirmed } from './ebay-price-readback.service.js'
import { getAllEbayCircuitStates, recordEbayOutcome, resetAllEbayCircuits } from './ebay-publish-gate.service.js'
import { logger } from '../utils/logger.js'

type Result = { success: boolean; status: string; message?: string; error?: string; errorCode?: string; retryable?: boolean; dryRun?: boolean; afterAnswer?: () => Promise<unknown> }
const service = new OutboundSyncService() as unknown as { syncToEbay: (q: unknown) => Promise<Result>; processSingle: (id: string) => Promise<Result> }
/** A dispatch as the completion writers run it: the answer, then its after-answer work (B1's read-back). */
const syncThenAnswer = async (q: unknown): Promise<Result> => {
  const r = await service.syncToEbay(q)
  await r.afterAnswer?.()
  return r
}
const row = (payload: Record<string, unknown> = { price: 19.9 }) =>
  ({ id: 'q1', channelListingId: 'listing-1', channelConnectionId: 'conn-B', product: { id: 'p1', sku: 'SKU-1' }, payload })
const offer = (offerId: string, marketplaceId: string, format = 'FIXED_PRICE', extra: Record<string, unknown> = {}) =>
  ({ offerId, sku: 'SKU-1', marketplaceId, format, availableQuantity: 4, pricingSummary: { price: { value: '12.00', currency: 'EUR' } }, ...extra })

const puts = () => h.calls.filter((c) => c.method === 'PUT')
const offerReads = () => h.calls.filter((c) => c.method === 'GET' && /\/sell\/inventory\/v1\/offer\/[^/?]+$/.test(new URL(c.url).pathname))
const offerLists = () => h.calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname === '/sell/inventory/v1/offer')

beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true')
  vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  h.calls = []; h.offers = [offer('OFF-IT', 'EBAY_IT')]; h.putStatus = 200; h.readStatus = 200
  h.readBody = { offerId: 'OFF-IT', pricingSummary: { price: { value: '19.90', currency: 'EUR' } } }
  h.afterPut = null; h.listingMarket = 'IT'; h.clNull = false; h.hangRead = false; h.existingKeys = new Set()
  h.putDelayMs = 0; h.queueStatus = 'PENDING'; h.queueUpdates = []; h.acquired = []; h.pendingRows = []; h.retryRows = []; h.statusAtRead = []; h.updateDelayMs = 0; h.itemPut25004 = false
  h.logConflict.mockClear(); h.createOutboundRow.mockClear(); h.findFirstLog.mockClear(); h.attemptCreate.mockClear()
  resetAllEbayCircuits()
  vi.stubEnv('NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS', '300')
  gatewayLedger.length = 0
  for (const key of Object.keys(gatewayAccounts)) delete gatewayAccounts[key]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = (init.headers ?? {}) as Record<string, string>
    h.calls.push({ method, url, auth: String(headers.Authorization ?? ''), market: String(headers['X-EBAY-C-MARKETPLACE-ID'] ?? ''), body: typeof init.body === 'string' ? init.body : null })
    const path = new URL(url).pathname
    if (method === 'GET' && path === '/sell/inventory/v1/offer') return new Response(JSON.stringify({ total: h.offers.length, offers: h.offers }), { status: 200 })
    if (method === 'PUT' && path.startsWith('/sell/inventory/v1/offer/')) {
      if (h.putDelayMs) await new Promise((resolve) => setTimeout(resolve, h.putDelayMs))
      h.afterPut?.()
      return new Response(h.putStatus === 204 ? null : '{}', { status: h.putStatus })
    }
    if (method === 'GET' && path.startsWith('/sell/inventory/v1/offer/')) {
      h.readSignal = (init.signal as AbortSignal | undefined) ?? null
      h.statusAtRead.push(h.queueStatus)
      if (h.hangRead) return new Promise<Response>((_resolve, reject) => {
        const abortRead = () => {
          init.signal?.removeEventListener('abort', abortRead)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        h.releaseHungRead = abortRead
        init.signal?.addEventListener('abort', abortRead, { once: true })
      })
      return new Response(JSON.stringify(h.readBody), { status: h.readStatus })
    }
    if (method === 'POST' && path === '/sell/inventory/v1/bulk_update_price_quantity') return new Response(JSON.stringify({ responses: [{ statusCode: 200 }] }), { status: 200 })
    if (method === 'GET' && path.startsWith('/sell/inventory/v1/inventory_item/')) return new Response(JSON.stringify({ product: { title: 'Old', description: 'Old' }, availability: {} }), { status: 200 })
    if (method === 'PUT' && path.startsWith('/sell/inventory/v1/inventory_item/')) {
      if (h.itemPut25004) { h.itemPut25004 = false; return new Response(JSON.stringify({ errors: [{ errorId: 25004 }] }), { status: 400 }) }
      return new Response(null, { status: 204 })
    }
    return new Response('{"unexpected":true}', { status: 500 })
  }))
})
afterEach(() => { h.releaseHungRead?.(); h.releaseHungRead = null; vi.unstubAllEnvs(); vi.unstubAllGlobals() })

// ── the pure verdicts ────────────────────────────────────────────────────────────────────────────
describe('B1 pure — ebayOfferPriceReadback compares integer cents AND currency', () => {
  const eur = (value: unknown, currency: unknown = 'EUR') => ({ pricingSummary: { price: { value, currency } } })
  it('"19.9" from eBay confirms a sent 19.90', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('19.9'))).toMatchObject({ outcome: 'CONFIRMED', channelPrice: 19.9, channelCurrency: 'EUR' })
  })
  it('compares in CENTS: an intended 0.1 + 0.2 is confirmed by "0.30" (floats would call it drift)', () => {
    expect(ebayOfferPriceReadback({ price: 0.1 + 0.2, currency: 'EUR' }, eur('0.30')).outcome).toBe('CONFIRMED')
    expect(ebayOfferPriceReadback({ price: 18.09 * 1.1, currency: 'EUR' }, eur('19.90')).outcome).toBe('CONFIRMED')
  })
  it('a real difference is a PRICE_MISMATCH with its signed drift', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('18.00'))).toMatchObject({
      outcome: 'PRICE_MISMATCH', channelPrice: 18, drift: { channelPrice: 18, intendedPrice: 19.9, difference: -1.9 },
    })
  })
  it('"0.00" is a price of zero, reported', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('0.00'))).toMatchObject({ outcome: 'PRICE_MISMATCH', channelPrice: 0 })
  })
  it('a MISSING price is UNREADABLE — never read as 0', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, { pricingSummary: { price: { currency: 'EUR' } } }).outcome).toBe('UNREADABLE')
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('abc')).outcome).toBe('UNREADABLE')
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, {}).outcome).toBe('UNREADABLE')
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, null).outcome).toBe('UNREADABLE')
  })
  it('GBP held on a EUR market is a CURRENCY_MISMATCH even at the same number', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('19.90', 'GBP'))).toMatchObject({ outcome: 'CURRENCY_MISMATCH', channelCurrency: 'GBP', channelPrice: 19.9 })
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, eur('19.90', 'eur')).outcome).toBe('CONFIRMED')
  })
})

describe('B1 pure — pickEbayPriceOffer: exactly one FIXED_PRICE offer of THIS marketplace', () => {
  it('two marketplaces → the right one, whatever its position', () => {
    expect(pickEbayPriceOffer([offer('OFF-DE', 'EBAY_DE'), offer('OFF-IT', 'EBAY_IT')], 'EBAY_IT', 'S').offer?.offerId).toBe('OFF-IT')
  })
  it('an auction beside the fixed-price offer → the fixed-price one', () => {
    expect(pickEbayPriceOffer([offer('OFF-AU', 'EBAY_IT', 'AUCTION'), offer('OFF-FP', 'EBAY_IT')], 'EBAY_IT', 'S').offer?.offerId).toBe('OFF-FP')
  })
  it('none for this marketplace → refused 404; several → refused 409, naming them', () => {
    const none = pickEbayPriceOffer([offer('OFF-DE', 'EBAY_DE')], 'EBAY_IT', 'S')
    expect(none).toMatchObject({ offer: null, status: 404 })
    expect(none.reason).toMatch(/The price was not written\./)
    expect(none.reason).not.toMatch(/Nothing was written/)
    const two = pickEbayPriceOffer([offer('A1', 'EBAY_IT'), offer('A2', 'EBAY_IT')], 'EBAY_IT', 'S')
    expect(two).toMatchObject({ offer: null, status: 409 })
    expect(two.reason).toMatch(/A1, A2/)
    expect(pickEbayPriceOffer(undefined, 'EBAY_IT', 'S').offer).toBeNull()
  })
  it('market codes become eBay ids (UK → EBAY_GB)', () => {
    expect(['IT', 'uk', 'GB', 'EBAY_DE', 'EBAY_UK', '', null, 'GLOBAL'].map((v) => ebayMarketplaceIdOf(v as string)))
      .toEqual(['EBAY_IT', 'EBAY_GB', 'EBAY_GB', 'EBAY_DE', 'EBAY_GB', null, null, null])
  })
})

// ── syncToEbay step 7b, end to end through the gateway ────────────────────────────────────────────
describe('B1 — before the PUT: the offer of THIS marketplace, or nothing is written', () => {
  it('asks for the offers WITH marketplace_id and prices the right one when eBay lists two marketplaces', async () => {
    h.offers = [offer('OFF-DE', 'EBAY_DE'), offer('OFF-IT', 'EBAY_IT')]
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(new URL(offerLists()[0].url).searchParams.get('marketplace_id')).toBe('EBAY_IT')
    expect(puts().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-IT'])
    expect(JSON.parse(puts()[0].body as string).pricingSummary.price).toEqual({ value: '19.90', currency: 'EUR' })
  })
  it('two fixed-price offers on this marketplace → refused before any PUT, terminal, both named', async () => {
    h.offers = [offer('OFF-1', 'EBAY_IT'), offer('OFF-2', 'EBAY_IT')]
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(r.error).toMatch(/OFF-1, OFF-2/)
    expect(puts()).toHaveLength(0)
    expect(offerReads()).toHaveLength(0)
  })
  it('only another marketplace\'s offer → refused before any PUT', async () => {
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(puts()).toHaveLength(0)
  })
  it('the marketplace is the LISTING\'s when the row names none (price rows never carry marketplaceId)', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-IT', 'EBAY_IT'), offer('OFF-DE', 'EBAY_DE')]
    h.readBody = { pricingSummary: { price: { value: '19.90', currency: 'EUR' } } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(new URL(offerLists()[0].url).searchParams.get('marketplace_id')).toBe('EBAY_DE')
    expect(puts().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-DE'])
    expect(puts()[0].market).toBe('EBAY_DE')
  })
  it('a UK listing is priced in GBP (the market\'s currency), not the EBAY_IT default\'s EUR', async () => {
    h.listingMarket = 'UK'
    h.offers = [offer('OFF-GB', 'EBAY_GB', 'FIXED_PRICE', { pricingSummary: { price: { value: '1.00', currency: 'GBP' } } })]
    h.readBody = { pricingSummary: { price: { value: '19.90', currency: 'GBP' } } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(JSON.parse(puts()[0].body as string).pricingSummary.price).toEqual({ value: '19.90', currency: 'GBP' })
    expect(h.logConflict).not.toHaveBeenCalled()
  })
})

describe('B1 — after the PUT: one read of the offer, same account, a gateway read on the ledger', () => {
  it('confirmed: GET /offer/{offerId} with the SAME account\'s token, ledgered as a GET for that account; nothing logged', async () => {
    h.readBody = { pricingSummary: { price: { value: '19.9', currency: 'EUR' } } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(r.message).not.toMatch(/unconfirmed/i)
    expect(offerReads().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-IT'])
    expect(offerReads()[0].auth).toBe('Bearer token-conn-B')
    expect(h.calls.at(-1)?.method).toBe('GET') // the read comes AFTER the PUT
    const readRow = gatewayLedger.find((l) => l.method === 'GET' && /\/offer\/OFF-IT$/.test(String(l.endpoint)))
    expect(readRow).toMatchObject({ connectionId: 'conn-B', outcome: 'sent', success: true })
    expect(new Set(h.calls.map((c) => c.auth))).toEqual(new Set(['Bearer token-conn-B']))
    expect(h.logConflict).not.toHaveBeenCalled()
  })
  it('a 204 PUT is read back too', async () => {
    h.putStatus = 204
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(offerReads()).toHaveLength(1)
  })
  it('a failed PUT is a write failure and is NOT read back', async () => {
    h.putStatus = 400
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: false, status: 'FAILED' })
    expect(offerReads()).toHaveLength(0)
    expect(h.logConflict).not.toHaveBeenCalled()
  })
})

describe('B1 — a mismatch is recorded, never re-pushed', () => {
  it('mismatch: row stays SUCCESS, not retryable, ONE PUT, no queue row, one CHANNEL_PRICE_READBACK "price unconfirmed"', async () => {
    h.readBody = { pricingSummary: { price: { value: '18.00', currency: 'EUR' } } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(r.retryable).toBeUndefined()
    expect(r.errorCode).toBeUndefined()
    // CX review 2026-09-26 — the read happens after the answer, so the row's message cannot carry it; the finding is the record.
    expect(r.message).toBe('Product SKU-1 synced to eBay')
    expect(puts()).toHaveLength(1)
    expect(offerReads()).toHaveLength(1)
    expect(h.createOutboundRow).not.toHaveBeenCalled()
    expect(h.logConflict).toHaveBeenCalledTimes(1)
    const logged = h.logConflict.mock.calls[0][0] as any
    expect(logged).toMatchObject({ channel: 'EBAY', conflictType: 'CHANNEL_PRICE_READBACK', productId: 'p1' })
    expect(logged.message).toMatch(/^Price unconfirmed/)
    expect(logged.message).toMatch(/EUR 18\.00/)
    expect(logged.message).toMatch(/EUR 19\.90/)
    expect(logged.remoteData).toMatchObject({ health: 'PRICE_UNCONFIRMED', outcome: 'PRICE_MISMATCH', offerId: 'OFF-IT', marketplace: 'EBAY_IT', ebayPrice: 18 })
    expect(logged.localData).toMatchObject({ sentPrice: 19.9, currency: 'EUR' })
  })
  it('the dedupe key is source + marketplace + offer + outcome class, within 24 h, UNRESOLVED; a match skips the record', async () => {
    h.readBody = { pricingSummary: { price: { value: '18.00', currency: 'EUR' } } }
    h.existingKeys = new Set(['INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|PRICE'])
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(h.logConflict).not.toHaveBeenCalled()
    const where = (h.findFirstLog.mock.calls[0][0] as any).where
    expect(where).toMatchObject({ productId: 'p1', channel: 'EBAY', conflictType: 'CHANNEL_PRICE_READBACK', resolutionStatus: 'UNRESOLVED', conflictData: { path: ['remote', 'dedupeKey'], equals: 'INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|PRICE' } })
    const ageMs = Date.now() - (where.createdAt.gte as Date).getTime()
    expect(ageMs).toBeGreaterThan(24 * 3600e3 - 60_000)
    expect(ageMs).toBeLessThan(24 * 3600e3 + 60_000)
  })
  it('an earlier "unconfirmed" (read failed / stale) does NOT suppress a real mismatch', async () => {
    h.readBody = { pricingSummary: { price: { value: '18.00', currency: 'EUR' } } }
    h.existingKeys = new Set(['INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|UNCONFIRMED'])
    await syncThenAnswer(row())
    expect(h.logConflict).toHaveBeenCalledTimes(1)
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ dedupeKey: 'INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|PRICE', outcome: 'PRICE_MISMATCH' })
  })
  it('every occurrence is logged (warn), deduped or not, without the token', async () => {
    const warn = vi.spyOn(logger, 'warn')
    h.readBody = { pricingSummary: { price: { value: '18.00', currency: 'EUR' } } }
    await syncThenAnswer(row())
    h.existingKeys = new Set(['INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|PRICE'])
    await syncThenAnswer(row())
    const ours = warn.mock.calls.filter((c) => c[0] === 'ebay-price-readback: price unconfirmed')
    expect(ours.map((c) => (c[1] as any).recorded)).toEqual(['logged', 'deduped'])
    expect(ours[1][1]).toMatchObject({ source: 'INVENTORY_GET_OFFER', marketplace: 'EBAY_IT', ref: 'offer:OFF-IT', outcome: 'PRICE_MISMATCH', productId: 'p1' })
    expect(JSON.stringify(ours)).not.toMatch(/token-|Bearer/)
    warn.mockRestore()
  })
  it('GBP held on EBAY_IT: a currency mismatch, recorded as such', async () => {
    h.readBody = { pricingSummary: { price: { value: '19.90', currency: 'GBP' } } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'CURRENCY_MISMATCH', ebayCurrency: 'GBP' })
    expect(puts()).toHaveLength(1)
  })
  it('a failed read-back GET is "unconfirmed", not a write failure', async () => {
    h.readStatus = 404
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(r.retryable).toBeUndefined()
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'READ_FAILED' })
    expect(puts()).toHaveLength(1)
  })
  it('a read-back the gateway refuses (account signed out after the PUT) is "unconfirmed", not a failure', async () => {
    h.afterPut = () => { gatewayAccounts['conn-B'] = { authStatus: 'needs_reauth', isActive: true, displayName: 'Second shop' } }
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'READ_FAILED' })
    expect(puts()).toHaveLength(1)
  })
  it('an answer with no price is "unconfirmed" (UNREADABLE), not a drift to 0', async () => {
    h.readBody = { pricingSummary: { price: { currency: 'EUR' } } }
    await syncThenAnswer(row())
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'UNREADABLE' })
  })
})

describe('B1 review — a read equal to the PRE-write price is STALE_READ, not a mismatch', () => {
  it('pure: pre-write 12.00, sent 19.90, read 12.00 → STALE_READ; read 18.00 → PRICE_MISMATCH; read 19.90 → CONFIRMED', () => {
    const previous = { price: 12, currency: 'EUR' }
    const read = (value: string, currency = 'EUR') => ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, { pricingSummary: { price: { value, currency } } }, previous)
    expect(read('12.00')).toMatchObject({ outcome: 'STALE_READ', channelPrice: 12 })
    expect(read('12.0')).toMatchObject({ outcome: 'STALE_READ' })
    expect(read('18.00').outcome).toBe('PRICE_MISMATCH')
    expect(read('19.90').outcome).toBe('CONFIRMED')
    expect(read('12.00', 'GBP').outcome).toBe('CURRENCY_MISMATCH') // not the pre-write pair
    // The same number in ANOTHER currency than the pre-write one is not "the old price still showing".
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, { pricingSummary: { price: { value: '12.00', currency: 'EUR' } } }, { price: 12, currency: 'GBP' }).outcome).toBe('PRICE_MISMATCH')
    // No pre-write price known: a different number is a mismatch, as before.
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'EUR' }, { pricingSummary: { price: { value: '12.00', currency: 'EUR' } } }).outcome).toBe('PRICE_MISMATCH')
  })
  it('end to end: the offer read back still at its pre-write 12.00 is recorded as STALE_READ ("not yet visible"), class UNCONFIRMED', async () => {
    h.readBody = { pricingSummary: { price: { value: '12.00', currency: 'EUR' } } } // the offer held 12.00 before the PUT
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    const logged = h.logConflict.mock.calls[0][0] as any
    expect(logged.remoteData).toMatchObject({ outcome: 'STALE_READ', dedupeKey: 'INVENTORY_GET_OFFER|EBAY_IT|offer:OFF-IT|UNCONFIRMED' })
    expect(logged.message).toMatch(/not yet visible/)
    expect(puts()).toHaveLength(1)
  })
})

describe('B1 review — the refusal says what WAS sent', () => {
  it('a price+quantity row with two offers: quantity went out (bulk update), the price is refused and the sentence says both', async () => {
    h.offers = [offer('OFF-1', 'EBAY_IT'), offer('OFF-2', 'EBAY_IT')]
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3 }))
    expect(r).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(h.calls.some((c) => c.method === 'POST' && /bulk_update_price_quantity$/.test(c.url))).toBe(true)
    expect(r.error).toMatch(/The price was not written\./)
    expect(r.error).toMatch(/quantity\/content .*already sent/)
    expect(r.error).not.toMatch(/Nothing was written/)
    expect(puts()).toHaveLength(0)
  })
  it('a price-only row refused: no claim that anything else was sent', async () => {
    h.offers = [offer('OFF-1', 'EBAY_IT'), offer('OFF-2', 'EBAY_IT')]
    const r = await syncThenAnswer(row())
    expect(r.error).toMatch(/The price was not written\./)
    expect(r.error).not.toMatch(/already sent/)
  })
})

describe('B1 review — the read-back is bounded', () => {
  it('a read that never answers → READ_FAILED at the deadline, row SUCCESS, one GET', async () => {
    h.hangRead = true
    const t0 = Date.now()
    const operation = syncThenAnswer(row())
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    try {
      // Observe independently so removing the service deadline fails an assertion,
      // rather than preventing every assertion until Vitest times the test out.
      const completed = await Promise.race([
        operation.then(() => true),
        new Promise<boolean>(resolve => { observationTimer = setTimeout(() => resolve(false), 3_000) }),
      ])
      expect(completed, 'the read-back must finish within the existing three-second bound').toBe(true)
      const r = await operation
      expect(Date.now() - t0).toBeLessThan(3_000)
      expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
      expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'READ_FAILED' })
      expect(offerReads()).toHaveLength(1)
      expect(puts()).toHaveLength(1)
      expect(h.readSignal?.aborted).toBe(true) // the in-flight read is cancelled at the deadline, not left running
    } finally {
      clearTimeout(observationTimer)
      h.releaseHungRead?.()
      await operation
    }
  })
  it('a 503 read is not retried (one GET), recorded READ_FAILED', async () => {
    // A deadline long enough that a retry (1 s backoff) WOULD show as a second GET.
    vi.stubEnv('NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS', '5000')
    h.readStatus = 503
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(offerReads()).toHaveLength(1)
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toMatchObject({ outcome: 'READ_FAILED' })
  })
})

describe('B1 review — the price step is audited and breaks on ITS market', () => {
  it('a DE listing\'s failed price PUT counts toward the EBAY_DE circuit and attempt log, not EBAY_IT', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    h.putStatus = 500
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: false, status: 'FAILED' })
    const states = getAllEbayCircuitStates()
    expect(states['conn-B:EBAY_DE']?.failureCount).toBe(1)
    expect(states['conn-B:EBAY_IT']?.failureCount ?? 0).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.attemptCreate.mock.calls.map((c) => (c[0] as any).data.marketplace)).toContain('EBAY_DE')
    expect(h.attemptCreate.mock.calls.map((c) => (c[0] as any).data.marketplace)).not.toContain('EBAY_IT')
  })
  it('an OPEN EBAY_DE circuit stops a DE price-only row at the gate (its own market), not fed another failure', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    for (let i = 0; i < 3; i++) recordEbayOutcome('conn-B', 'EBAY_DE', false)
    const openedAt = getAllEbayCircuitStates()['conn-B:EBAY_DE'].openedAt
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: false, status: 'FAILED' })
    expect(r.error).toMatch(/circuit open/)
    expect(h.calls).toHaveLength(0)
    expect(getAllEbayCircuitStates()['conn-B:EBAY_DE']).toMatchObject({ failureCount: 3, openedAt })
  })
  it('a DE listing\'s successful price write is audited on EBAY_DE', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    await syncThenAnswer(row())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.attemptCreate.mock.calls.map((c) => (c[0] as any).data)).toEqual([expect.objectContaining({ marketplace: 'EBAY_DE', outcome: 'success' })])
  })
})

describe('B1 review — which market the price step uses', () => {
  // CX (main session ruling 2026-09-26, aligned with Amazon A-24): the row's market and its listing's market must agree.
  it.each([['marketplaceId', { marketplaceId: 'EBAY_FR' }], ['marketplace', { marketplace: 'FR' }]])('a row whose %s disagrees with its listing is refused: recorded, terminal, nothing sent', async (_field, market) => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE'), offer('OFF-FR', 'EBAY_FR')]
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3, ...market }))
    expect(r).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_MARKET_UNRESOLVED', retryable: false })
    expect(r.error).toMatch(/asks for EBAY_FR, but its listing is on EBAY_DE, so nothing was sent/)
    expect(h.calls).toHaveLength(0)
    expect(h.acquired).toEqual([])
  })
  it('no listing, and the row\'s two market fields disagree → refused, nothing sent', async () => {
    h.clNull = true
    const r = await syncThenAnswer(row({ price: 19.9, marketplaceId: 'EBAY_IT', marketplace: 'ES' }))
    expect(r).toMatchObject({ success: false, errorCode: 'EBAY_MARKET_UNRESOLVED', retryable: false })
    expect(r.error).toMatch(/names two markets \(EBAY_IT and EBAY_ES\)/)
    expect(h.calls).toHaveLength(0)
  })
  // Main session, read-only production check 09:15Z: the two row shapes of the last 30 days (A, B), plus C and D.
  it.each([
    ['A: payload marketplaceId EBAY_IT, no linked listing', null, { marketplaceId: 'EBAY_IT' }],
    ['A: payload marketplace EBAY_IT, no linked listing', null, { marketplace: 'EBAY_IT' }],
    ['B: payload marketplace IT, listing IT', 'IT', { marketplace: 'IT' }],
    ['C: payload marketplaceId EBAY_IT, listing IT', 'IT', { marketplaceId: 'EBAY_IT' }],
    ['C: payload marketplace EBAY_IT and marketplaceId EBAY_IT, listing IT', 'IT', { marketplace: 'EBAY_IT', marketplaceId: 'EBAY_IT' }],
  ])('%s → accepted: EBAY_IT and IT are one market', async (_shape, listing, market) => {
    const q = listing ? row({ price: 19.9, quantity: 3, ...market }) : { ...row({ price: 19.9, quantity: 3, ...market }), channelListingId: null }
    if (listing) h.listingMarket = listing; else h.clNull = true
    const r = await syncThenAnswer(q)
    expect(r, r.error).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(h.acquired).toEqual([['conn-B', 'EBAY_IT']])
    expect(new Set(offerLists().map((c) => new URL(c.url).searchParams.get('marketplace_id')))).toEqual(new Set(['EBAY_IT']))
    expect(puts().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-IT'])
  })
  it('D: payload marketplaceId EBAY_DE, listing IT → refused, nothing sent', async () => {
    h.listingMarket = 'IT'
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3, marketplaceId: 'EBAY_DE' }))
    expect(r).toMatchObject({ success: false, errorCode: 'EBAY_MARKET_UNRESOLVED', retryable: false })
    expect(r.error).toMatch(/asks for EBAY_DE, but its listing is on EBAY_IT/)
    expect(h.calls).toHaveLength(0)
  })
  it('the disagreement is recorded on the queue row (dead-lettered with its reason) by the backstop', async () => {
    h.listingMarket = 'DE'
    h.pendingRows = [{ ...queueRow(), payload: { price: 19.9, marketplaceId: 'EBAY_FR' } }]
    const stats = await (service as unknown as { processPendingSyncs: () => Promise<{ failed: number }> }).processPendingSyncs()
    expect(stats).toMatchObject({ failed: 1 })
    expect(h.queueUpdates.at(-1)).toMatchObject({ syncStatus: 'FAILED', errorCode: 'EBAY_MARKET_UNRESOLVED', errorMessage: expect.stringMatching(/nothing was sent/) })
    expect(h.calls).toHaveLength(0)
  })
  it('a row market that agrees with its listing (UK written as GB) goes out on that market', async () => {
    h.listingMarket = 'UK'
    h.offers = [offer('OFF-GB', 'EBAY_GB', 'FIXED_PRICE', { pricingSummary: { price: { value: '1.00', currency: 'GBP' } } })]
    h.readBody = { pricingSummary: { price: { value: '19.90', currency: 'GBP' } } }
    const r = await syncThenAnswer(row({ price: 19.9, marketplace: 'GB', marketplaceId: 'EBAY_GB' }))
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(puts().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-GB'])
  })
  it('no listing row (cl = null) → payload.marketplace', async () => {
    h.clNull = true
    h.offers = [offer('OFF-IT', 'EBAY_IT'), offer('OFF-ES', 'EBAY_ES')]
    await syncThenAnswer(row({ price: 19.9, marketplace: 'ES' }))
    expect(new URL(offerLists()[0].url).searchParams.get('marketplace_id')).toBe('EBAY_ES')
    expect(puts().map((c) => new URL(c.url).pathname)).toEqual(['/sell/inventory/v1/offer/OFF-ES'])
  })
  it('a market with no configured currency → refused before any price call', async () => {
    h.listingMarket = 'SE'
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_VALIDATION', retryable: false })
    expect(r.error).toMatch(/No currency is configured for EBAY\/SE/)
    expect(offerLists()).toHaveLength(0)
    expect(puts()).toHaveLength(0)
  })
})

describe('CX review 2026-09-26 — the read-back runs AFTER the row has its answer, outside the dispatch budget', () => {
  type Answered = Result & { afterAnswer?: () => Promise<unknown> }
  it('processSingle answers without reading; the caller starts the read-back afterwards, and it reads once', async () => {
    const r = await service.processSingle('q1') as Answered
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(offerReads()).toHaveLength(0)
    expect(typeof r.afterAnswer).toBe('function')
    await r.afterAnswer!()
    expect(offerReads()).toHaveLength(1)
    expect(h.logConflict).not.toHaveBeenCalled()
  })
  it('a hung read never delays the answer: processSingle returns at once, the read runs to its own 8 s deadline later', async () => {
    vi.stubEnv('NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS', '8000')
    h.hangRead = true
    const t0 = Date.now()
    const r = await service.processSingle('q1').catch((err) => ({ status: 'THREW', error: String(err) })) as Answered
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(offerReads()).toHaveLength(0)
    expect(h.queueUpdates.filter((u) => u.syncStatus === 'PENDING')).toHaveLength(0)
  }, 15_000)
  it.each([['the PENDING lane', 'PENDING'], ['the retry lane', 'FAILED']])('the backstop loop (%s) writes SUCCESS first, then reads the offer back', async (_lane, status) => {
    h.queueStatus = status
    h.updateDelayMs = 200 // the read must wait for the WRITE, not merely for the call
    if (status === 'PENDING') h.pendingRows = [queueRow()]; else h.retryRows = [queueRow()]
    const stats = await (service as unknown as { processPendingSyncs: () => Promise<{ succeeded: number; failed: number }> }).processPendingSyncs()
    expect(stats).toMatchObject({ succeeded: 1, failed: 0 })
    await vi.waitFor(() => expect(offerReads()).toHaveLength(1), { timeout: 3_000 })
    expect(h.statusAtRead).toEqual(['SUCCESS'])
    expect(puts()).toHaveLength(1)
  }, 15_000)
})

describe('B1 re-review — small fixes', () => {
  it('a currency change wins over "same as before": pre-write EUR 12.00, sent GBP 19.90, read EUR 12.00 → CURRENCY_MISMATCH', () => {
    expect(ebayOfferPriceReadback({ price: 19.9, currency: 'GBP' }, { pricingSummary: { price: { value: '12.00', currency: 'EUR' } } }, { price: 12, currency: 'EUR' }))
      .toMatchObject({ outcome: 'CURRENCY_MISMATCH', channelCurrency: 'EUR' })
  })
  it('the STALE_READ sentence does not promise a later check that does not exist', () => {
    const text = ebayPriceUnconfirmedMessage({ sku: 'S', marketplaceId: 'EBAY_IT', offerId: 'O', expected: { price: 19.9, currency: 'EUR' }, readback: { outcome: 'STALE_READ', channelPrice: 12, channelCurrency: 'EUR' } })
    expect(text).not.toMatch(/next check/)
    expect(text).toMatch(/No later check re-reads this offer/)
  })
  it('a caller\'s remoteData cannot overwrite the computed dedupeKey / source / outcome / health', async () => {
    await recordEbayPriceUnconfirmed({ productId: 'p1', source: 'INVENTORY_GET_OFFER', marketplace: 'EBAY_IT', ref: 'offer:O', outcome: 'PRICE_MISMATCH', sku: 'S', message: 'm', localData: {},
      remoteData: { dedupeKey: 'forged', source: 'forged', outcome: 'forged', health: 'forged', offerId: 'O' } })
    expect((h.logConflict.mock.calls[0][0] as any).remoteData).toEqual({ offerId: 'O', health: 'PRICE_UNCONFIRMED', source: 'INVENTORY_GET_OFFER', outcome: 'PRICE_MISMATCH', dedupeKey: 'INVENTORY_GET_OFFER|EBAY_IT|offer:O|PRICE' })
  })
  it('a price-only row of another market takes that market\'s rate token and circuit, never EBAY_IT\'s', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    for (let i = 0; i < 3; i++) recordEbayOutcome('conn-B', 'EBAY_IT', false) // EBAY_IT open: must not block a DE price
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(h.acquired).toEqual([['conn-B', 'EBAY_DE']])
  })
  it('a failed offer PUT after 7a says the quantity/content went out', async () => {
    h.putStatus = 400
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3 }))
    expect(r).toMatchObject({ success: false, status: 'FAILED' })
    expect(r.error).toMatch(/offer PUT 400/)
    expect(r.error).toMatch(/quantity\/content in this row were already sent/)
  })
})

describe('CX review 2026-09-26 — one market per row (eBay offers a SKU on one marketplace)', () => {
  it('a DE price+quantity row: quantity AND price go to EBAY_DE — one rate token, every call on EBAY_DE', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3 }))
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(h.acquired).toEqual([['conn-B', 'EBAY_DE']])
    expect(offerLists().map((c) => new URL(c.url).searchParams.get('marketplace_id'))).toEqual(['EBAY_DE', 'EBAY_DE'])
    expect(new Set(h.calls.map((c) => c.market))).toEqual(new Set(['EBAY_DE']))
    expect(h.calls.some((c) => c.method === 'POST' && /bulk_update_price_quantity$/.test(c.url))).toBe(true)
  })
  it('a DE quantity-only row: the offer lookup and the bulk update are on EBAY_DE, audited on EBAY_DE', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    const r = await syncThenAnswer(row({ quantity: 3 }))
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(offerLists().map((c) => new URL(c.url).searchParams.get('marketplace_id'))).toEqual(['EBAY_DE'])
    expect(h.calls.find((c) => c.method === 'POST')?.market).toBe('EBAY_DE')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.attemptCreate.mock.calls.map((c) => (c[0] as any).data.marketplace)).toEqual(['EBAY_DE'])
  })
  it('an OPEN EBAY_DE circuit stops a DE price+quantity row at the gate: nothing is sent, the circuit is not fed', async () => {
    h.listingMarket = 'DE'
    h.offers = [offer('OFF-DE', 'EBAY_DE')]
    for (let i = 0; i < 3; i++) recordEbayOutcome('conn-B', 'EBAY_DE', false)
    const openedAt = getAllEbayCircuitStates()['conn-B:EBAY_DE'].openedAt
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3 }))
    expect(r).toMatchObject({ success: false, status: 'FAILED' })
    expect(r.error).toMatch(/circuit open/)
    expect(h.calls).toHaveLength(0)
    expect(getAllEbayCircuitStates()['conn-B:EBAY_DE']).toMatchObject({ failureCount: 3, openedAt })
  })
  it('a row with no listing and no market is refused before any call — never sent to EBAY_IT by default', async () => {
    h.clNull = true
    const r = await syncThenAnswer(row({ price: 19.9, quantity: 3 }))
    expect(r).toMatchObject({ success: false, status: 'FAILED', errorCode: 'EBAY_MARKET_UNRESOLVED', retryable: false })
    expect(r.error).toMatch(/names no eBay market/)
    expect(h.calls).toHaveLength(0)
    expect(h.acquired).toEqual([])
  })
})

describe('CX review 2026-09-26 — the quantity path uses the FIXED_PRICE offer, never offers[0]', () => {
  const bulkBody = () => JSON.parse(h.calls.find((c) => c.method === 'POST' && /bulk_update_price_quantity$/.test(c.url))!.body as string)
  it('bulk quantity update: an auction offer listed first is not the one raised', async () => {
    h.offers = [offer('OFF-AU', 'EBAY_IT', 'AUCTION'), offer('OFF-FP', 'EBAY_IT')]
    const r = await syncThenAnswer(row({ quantity: 3 }))
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    const request = bulkBody().requests[0]
    expect(request).toMatchObject({ sku: 'SKU-1', offers: [{ offerId: 'OFF-FP' }] })
    expect(request.offers[0].availableQuantity).toBe(request.shipToLocationAvailability.quantity)
  })
  it('bulk quantity update: two fixed-price offers on the market → no offer is guessed (item quantity only)', async () => {
    h.offers = [offer('OFF-1', 'EBAY_IT'), offer('OFF-2', 'EBAY_IT')]
    await syncThenAnswer(row({ quantity: 3 }))
    expect(bulkBody().requests[0].offers).toBeUndefined()
  })
  it('25004 heal: the parked FIXED_PRICE offer is raised, never the auction listed first', async () => {
    h.offers = [offer('OFF-AU', 'EBAY_IT', 'AUCTION'), offer('OFF-FP', 'EBAY_IT')]
    h.itemPut25004 = true
    const r = await syncThenAnswer(row({ quantity: 3, title: 'New title' }))
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    const offerPuts = puts().filter((c) => /\/sell\/inventory\/v1\/offer\//.test(c.url)).map((c) => new URL(c.url).pathname)
    expect(offerPuts).toEqual(['/sell/inventory/v1/offer/OFF-FP'])
    const itemPut = JSON.parse(puts().find((c) => /inventory_item/.test(c.url))!.body as string)
    expect(JSON.parse(puts().find((c) => /\/offer\/OFF-FP$/.test(c.url))!.body as string).availableQuantity).toBe(itemPut.availability.shipToLocationAvailability.quantity)
  })
})

describe('B1 — dry-run returns before any of it', () => {
  it('no offer query, no PUT, no read-back, nothing logged', async () => {
    vi.stubEnv('EBAY_PUBLISH_MODE', 'dry-run')
    const r = await syncThenAnswer(row())
    expect(r).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(h.calls).toHaveLength(0)
    expect(h.logConflict).not.toHaveBeenCalled()
    expect(h.findFirstLog).not.toHaveBeenCalled()
  })
})
