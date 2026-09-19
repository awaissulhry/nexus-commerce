/**
 * P1.2 — the REAL amazon-sp-api SDK, with its one sender routed through the gateway.
 *
 * The SDK builds the request and shapes the answer as before; `fetch` (the gateway's sender) is a fake
 * channel that records every request. What must hold: reads are sent, writes follow the publish mode,
 * the SDK's own QuotaExceeded retry still works (one ledger row per send), channel errors keep the SDK's
 * error shape, and an SDK without the replaced sender is refused, never bypassed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { authStatus: 'connected', isActive: true, displayName: 'Amazon IT' },
  ledger: [] as Array<Record<string, any>>,
  calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
  answers: [] as Array<() => Response>,
}))
vi.mock('../../db.js', () => ({ default: { channelConnection: { findUnique: vi.fn(async () => h.account) } } }))
vi.mock('../outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async (row: Record<string, any>) => { h.ledger.push(row) }) }))

import { SellingPartner } from 'amazon-sp-api'
import { __rateTest, registerRateRedis } from './rate.js'
import { amazonSdkKind, routeSdkThroughGateway, SdkShapeChanged } from './amazon-sdk.js'

const IT = 'APJ6JRA9NG5V4'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function sdk(): any {
  const client: any = new SellingPartner({
    region: 'eu', access_token: 'seller-token', refresh_token: 'r',
    credentials: { SELLING_PARTNER_APP_CLIENT_ID: 'app', SELLING_PARTNER_APP_CLIENT_SECRET: 'secret' },
    options: { auto_request_tokens: false, auto_request_throttled: true },
  } as never)
  routeSdkThroughGateway(client, { connectionId: 'amz-A' })
  return client
}
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

beforeEach(() => {
  __rateTest.useMemory()
  h.account = { authStatus: 'connected', isActive: true, displayName: 'Amazon IT' }
  h.ledger = []; h.calls = []; h.answers = []
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const next = h.answers.shift()
    if (!next) throw new Error('the test gave no answer for this call')
    return next()
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('P1.2 — Amazon SDK calls go through the gateway', () => {
  it('a read: sent by the gateway with the seller token; the SDK still unwraps the payload; one ledger row', async () => {
    h.answers.push(() => json({ payload: { Orders: [{ AmazonOrderId: '1' }] } }, 200, { 'x-amzn-RateLimit-Limit': '0.0167' }))
    const result = await sdk().callAPI({ operation: 'getOrders', endpoint: 'orders', query: { MarketplaceIds: [IT], CreatedAfter: '2026-09-01' } })
    expect(result).toEqual({ Orders: [{ AmazonOrderId: '1' }] })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toMatch(/^https:\/\/sellingpartnerapi-eu\.amazon\.com\/orders\/v0\/orders\?/)
    expect(h.calls[0].headers).toMatchObject({ 'x-amz-access-token': 'seller-token' })
    expect(h.calls[0].headers.host).toBeUndefined()
    expect(h.ledger).toEqual([expect.objectContaining({ channel: 'AMAZON', connectionId: 'amz-A', operation: 'getOrders', marketplace: IT, outcome: 'sent', success: true, apiVersion: 'v0', rateLimitLimit: 0.0167 })])
  })

  it('a write in dry-run: refused before the channel, recorded as "would send"; the same in gated mode', async () => {
    vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run')
    const feed = { operation: 'createFeed', endpoint: 'feeds', body: { feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [IT], inputFeedDocumentId: 'doc-1' } }
    expect(await refusalOf(sdk().callAPI(feed))).toMatchObject({ name: 'GatewayRefusal', code: 'DRY_RUN' })
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '')
    expect(await refusalOf(sdk().callAPI(feed))).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
    expect(h.ledger.map((r) => [r.operation, r.outcome])).toEqual([['createFeed', 'would_send'], ['createFeed', 'gated']])
  })

  it('a listings VALIDATION_PREVIEW changes nothing, so it is sent even in dry-run', async () => {
    vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run')
    h.answers.push(() => json({ sku: 'S1', status: 'VALID', submissionId: 'x', issues: [] }))
    await sdk().callAPI({ operation: 'patchListingsItem', endpoint: 'listingsItems', path: { sellerId: 'SELLER', sku: 'S1' }, query: { marketplaceIds: [IT], mode: 'VALIDATION_PREVIEW' }, body: { productType: 'JACKET', patches: [] } })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', url: expect.stringContaining('mode=VALIDATION_PREVIEW') })
  })

  it('a write in sandbox mode goes to the sandbox host, never the live one', async () => {
    vi.stubEnv('AMAZON_PUBLISH_MODE', 'sandbox')
    h.answers.push(() => json({ sku: 'S1', status: 'ACCEPTED', submissionId: 's', issues: [] }))
    await sdk().callAPI({ operation: 'putListingsItem', endpoint: 'listingsItems', path: { sellerId: 'SELLER', sku: 'S1' }, query: { marketplaceIds: [IT] }, body: { productType: 'JACKET', attributes: {} } })
    expect(new URL(h.calls[0].url).host).toBe('sandbox.sellingpartnerapi-eu.amazon.com')
  })

  it('the SDK\'s own QuotaExceeded wait-and-retry still works; each send is its own ledger row', async () => {
    h.answers.push(
      () => json({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] }, 429, { 'x-amzn-RateLimit-Limit': '100' }),
      () => json({ payload: { AmazonOrderId: '1' } }, 200),
    )
    expect(await sdk().callAPI({ operation: 'getOrder', endpoint: 'orders', path: { orderId: '1' } })).toEqual({ AmazonOrderId: '1' })
    expect(h.calls).toHaveLength(2)
    expect(h.ledger.map((r) => [r.success, r.errorClass ?? null, r.attempts])).toEqual([[false, 'rate_limited', 1], [true, null, 1]])
  })

  it('a channel error keeps the SDK\'s error shape (code + message) and gets its class on the ledger', async () => {
    h.answers.push(() => json({ errors: [{ code: 'InvalidInput', message: 'Invalid SKU', details: '' }] }, 400))
    expect(await refusalOf(sdk().callAPI({ operation: 'getListingsItem', endpoint: 'listingsItems', path: { sellerId: 'SELLER', sku: 'S 1' }, query: { marketplaceIds: [IT] } })))
      .toMatchObject({ code: 'InvalidInput', message: 'Invalid SKU' })
    expect(h.ledger.at(-1)).toMatchObject({ success: false, statusCode: 400, errorClass: 'validation', errorCode: 'InvalidInput' })
  })

  it('an account that needs sign-in: held, nothing sent', async () => {
    h.account = { authStatus: 'needs_reauth', isActive: true, displayName: 'Amazon IT' }
    expect(await refusalOf(sdk().callAPI({ operation: 'getOrders', endpoint: 'orders', query: { MarketplaceIds: [IT] } }))).toMatchObject({ code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(h.calls).toHaveLength(0)
  })

  it('no answer at all: the caller gets a network error, as from the SDK\'s own sender', async () => {
    h.answers.push(() => { throw new TypeError('fetch failed') }, () => { throw new TypeError('fetch failed') })
    expect(await refusalOf(sdk().callAPI({ operation: 'getOrders', endpoint: 'orders', query: { MarketplaceIds: [IT] } }))).toMatchObject({ code: 'ECONNRESET' })
  })

  it('an SDK without the sender this replaces is REFUSED, never bypassed — and the installed SDK has it', () => {
    expect(() => routeSdkThroughGateway({}, { connectionId: 'amz-A' })).toThrow(SdkShapeChanged)
    expect(() => routeSdkThroughGateway({ _request: { api: () => null } }, { connectionId: 'amz-A' })).toThrow(SdkShapeChanged)
    const real: any = sdk()
    expect(typeof real._request._constructRequestOptions).toBe('function')
    expect(real._request.api.viaGateway).toBe(true)
  })

  it('notification setup is sent even when Amazon publishing is gated (a switched-off channel must still receive events)', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '')
    h.answers.push(() => json({ payload: { subscriptionId: 's1' } }))
    await sdk().callAPI({ operation: 'createSubscription', endpoint: 'notifications', path: { notificationType: 'ORDER_CHANGE' }, body: { payloadVersion: '1.0', destinationId: 'd1' } })
    expect(h.calls).toHaveLength(1)
    expect(h.ledger.at(-1)).toMatchObject({ operation: 'createSubscription', outcome: 'sent' })
  })

  it('read or write, from the built request', () => {
    expect(amazonSdkKind('POST', 'createDestination', {}, '/notifications/v1/destinations')).toBe('setup')
    expect(amazonSdkKind('POST', 'rotateApplicationClientSecret', {}, '/applications/2023-11-30/clientSecret')).toBe('setup')
    expect(amazonSdkKind('GET', 'getOrders', {})).toBe('read')
    expect(amazonSdkKind('POST', 'createReport', {})).toBe('read')
    expect(amazonSdkKind('POST', 'getItemOffersBatch', {})).toBe('read')
    expect(amazonSdkKind('PATCH', 'patchListingsItem', { mode: 'VALIDATION_PREVIEW' })).toBe('read')
    expect(amazonSdkKind('POST', 'createFeed', {})).toBe('write')
    expect(amazonSdkKind('POST', 'createShipment', {})).toBe('write')
    expect(amazonSdkKind('POST', 'someNewOperation', {})).toBe('write')
  })
})

describe('P1.2 — the rate bucket uses the app\'s Redis only while it is ready', () => {
  it('connecting → memory; ready → Redis; never opens a connection itself', async () => {
    __rateTest.reset()
    const client = { status: 'connecting', eval: vi.fn(), hset: vi.fn(), hgetall: vi.fn(), pexpire: vi.fn() }
    registerRateRedis(() => client)
    expect(await __rateTest.picked()).toBe('memory')
    client.status = 'ready'
    expect(await __rateTest.picked()).toBe('redis')
    registerRateRedis(() => null)
    expect(await __rateTest.picked()).toBe('memory')
  })
})

describe('P1.2 — the Amazon listings client (AmazonSpApiClient) sends through the gateway', () => {
  it('a listings PATCH that meets a 503 is retried (safe to repeat); a label purchase (POST) is not', async () => {
    const { AmazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
    const client: any = new AmazonSpApiClient({ id: 'amz-A', region: 'eu' })
    h.answers.push(() => json({ errors: [{ code: 'InternalFailure' }] }, 503), () => json({ status: 'ACCEPTED' }))
    const patched = await client.fetchWithRetry(`https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/SKU?marketplaceIds=${IT}`, { method: 'PATCH', headers: { 'x-amz-access-token': 't' }, body: '{}' }, 'patchListingPrice(SKU)')
    expect(patched.status).toBe(200)
    expect(h.calls).toHaveLength(2)
    h.calls.length = 0
    h.answers.push(() => json({ errors: [{ code: 'InternalFailure' }] }, 503), () => json({ ok: true }))
    const bought = await client.fetchWithRetry('https://sellingpartnerapi-eu.amazon.com/mfn/v0/shipments', { method: 'POST', headers: { 'x-amz-access-token': 't' }, body: '{}' }, 'POST /mfn/v0/shipments')
    expect(bought.status).toBe(503)
    expect(h.calls).toHaveLength(1)
    expect(h.ledger.map((r) => [r.operation, r.attempts])).toEqual([['patchListingPrice', 2], ['POST /mfn/v0/shipments', 1]])
  }, 20_000)
})
