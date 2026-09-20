/**
 * P1.1 — the channel gateway: the nine steps, in order, for all four channels.
 *
 * `fetch` is a fake channel that records every request (so "0 calls" is counted, not assumed) and
 * answers what each test tells it to. The ledger writer, the account table, the token services, the
 * eBay signer and the P0.7 guard are stand-ins; the gateway, the rate buckets (in memory), the vocabulary
 * and the redaction are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  accounts: {} as Record<string, { authStatus: string; isActive: boolean; displayName: string }>,
  markets: [] as Array<{ channel: string; code: string; marketplaceId: string | null; languages: string[]; language: string }>,
  ledger: [] as Array<Record<string, any>>,
  calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
  answers: [] as Array<() => Response | Promise<Response>>,
  wrongAccount: null as string | null,
  signed: 0,
}))
vi.mock('../../db.js', () => ({ default: {
  channelConnection: { findUnique: vi.fn(async ({ where }: any) => h.accounts[where.id] ?? null) },
  marketplace: { findFirst: vi.fn(async ({ where }: any) => h.markets.find((m) => m.channel === where.channel && m.code === where.code) ?? null) },
} }))
vi.mock('../outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async (row: Record<string, any>) => { h.ledger.push(row) }) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async (id: string) => `tok-${id}`) }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonAccessToken: vi.fn(async (id: string) => `amz-${id}`) }))
vi.mock('../cx/connectors/ebay/client.js', () => ({ ebaySigningHeaders: vi.fn(async () => { h.signed++; return { 'x-ebay-signature-key': 'jwe', 'Signature-Input': 'sig1=()', Signature: 'sig1=:x:' } }) }))
vi.mock('../write-account-guard.js', () => ({ assertWriteAccount: vi.fn(async () => { if (h.wrongAccount) throw new Error(h.wrongAccount) }) }))

import { __rateTest, observeRate, takeToken } from './rate.js'
import { gatewayCall, GatewayRefusal, idempotencyKeyFor, type GatewayRequest } from './gateway.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { ledgerSafeBody } from './redact.js'
import { sandboxUrlOf, bucketGroupOf, apiVersionOf } from './channels.js'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => {
  __rateTest.useMemory()
  h.accounts = {
    'ebay-A': { authStatus: 'connected', isActive: true, displayName: 'eBay IT' },
    'amz-A': { authStatus: 'connected', isActive: true, displayName: 'Amazon IT' },
    'shop-A': { authStatus: 'connected', isActive: true, displayName: 'Shopify' },
    'ads-A': { authStatus: 'connected', isActive: true, displayName: 'Ads' },
    'ebay-stale': { authStatus: 'needs_reauth', isActive: true, displayName: 'Old eBay' },
    'ebay-off': { authStatus: 'connected', isActive: false, displayName: 'Off eBay' },
  }
  h.ledger = []; h.calls = []; h.answers = []; h.wrongAccount = null; h.signed = 0
  // The eBay Marketplace rows as seeded (local database, 2026-09-19), plus a two-language market.
  h.markets = [
    ...(['DE', 'ES', 'FR', 'IT'] as const).map((code) => ({ channel: 'EBAY', code, marketplaceId: `EBAY_${code}`, languages: [code.toLowerCase()], language: code.toLowerCase() })),
    { channel: 'EBAY', code: 'UK', marketplaceId: 'EBAY_GB', languages: ['en'], language: 'en' },
    { channel: 'EBAY', code: 'BE', marketplaceId: 'EBAY_BE', languages: ['fr', 'nl'], language: 'fr' },
    { channel: 'EBAY', code: 'PL', marketplaceId: 'EBAY_PL', languages: [], language: '' },
    { channel: 'AMAZON', code: 'NL', marketplaceId: 'A1805IZSGTT6HS', languages: ['nl'], language: 'nl' },
  ]
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'true'); vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const next = h.answers.shift()
    return next ? next() : json({ ok: true })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

const ebayWrite = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  channel: 'EBAY', operation: 'inventory.createOrReplaceInventoryItem', kind: 'write', connectionId: 'ebay-A',
  url: 'https://api.ebay.com/sell/inventory/v1/inventory_item/SKU-1', method: 'PUT', body: '{"availability":{}}', marketplace: 'EBAY_IT', ...over,
})
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as GatewayRefusal)

describe('P1.1 — steps 1–4: nothing is sent unless it may be', () => {
  it('1. a write that names no account is refused (never "the primary"), 0 calls', async () => {
    const r = await refusalOf(gatewayCall(ebayWrite({ connectionId: null })))
    expect(r).toMatchObject({ outcome: 'refused', code: 'ACCOUNT_REQUIRED' })
    expect(h.calls).toHaveLength(0)
    expect(h.ledger).toEqual([expect.objectContaining({ outcome: 'refused', success: false, statusCode: null })])
  })
  it('2. an account that needs sign-in, or is inactive, is HELD — 0 calls', async () => {
    expect(await refusalOf(gatewayCall(ebayWrite({ connectionId: 'ebay-stale' })))).toMatchObject({ outcome: 'held', code: 'ACCOUNT_NEEDS_SIGNIN', message: expect.stringMatching(/Old eBay.*needs_reauth/) })
    expect(await refusalOf(gatewayCall(ebayWrite({ connectionId: 'ebay-off' })))).toMatchObject({ outcome: 'held' })
    expect(h.calls).toHaveLength(0)
  })
  it('3. gated → nothing; dry-run → "would send", nothing; both leave a ledger row', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', '')
    expect(await refusalOf(gatewayCall(ebayWrite()))).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'dry-run')
    expect(await refusalOf(gatewayCall(ebayWrite()))).toMatchObject({ outcome: 'would_send', code: 'DRY_RUN' })
    expect(h.calls).toHaveLength(0)
    expect(h.ledger.map((r) => r.outcome)).toEqual(['gated', 'would_send'])
  })
  it('3. sandbox → the sandbox host (eBay, Amazon, Ads); a channel without one → nothing', async () => {
    vi.stubEnv('EBAY_PUBLISH_MODE', 'sandbox'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'sandbox'); vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    await gatewayCall(ebayWrite())
    await gatewayCall({ channel: 'AMAZON_SP', operation: 'listings.patch', kind: 'write', connectionId: 'amz-A', url: 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/SKU', method: 'PATCH', body: '{}' })
    await gatewayCall({ channel: 'AMAZON_ADS', operation: 'sp.keywords.update', kind: 'write', connectionId: 'ads-A', url: 'https://advertising-api-eu.amazon.com/sp/keywords', method: 'PUT', body: '[]' })
    expect(h.calls.map((c) => new URL(c.url).host)).toEqual(['api.sandbox.ebay.com', 'sandbox.sellingpartnerapi-eu.amazon.com', 'advertising-api-test.amazon.com'])
    expect(sandboxUrlOf('SHOPIFY', 'https://x.myshopify.com/admin/api/2026-07/graphql.json')).toBeNull()
  })
  it('3. reads ignore the publish mode (control: a GET in dry-run is sent)', async () => {
    vi.stubEnv('EBAY_PUBLISH_MODE', 'dry-run')
    const res = await gatewayCall(ebayWrite({ kind: 'read', method: 'GET', body: null }))
    expect(res.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
  })
  it('3. connection setup (event subscriptions, keys) is sent in every mode; a write in the same mode is not', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', '')
    await gatewayCall(ebayWrite({ kind: 'setup', operation: 'notification.createSubscription', url: 'https://api.ebay.com/commerce/notification/v1/subscription', method: 'POST' }))
    expect(h.calls).toHaveLength(1)
    expect(h.ledger.at(-1)).toMatchObject({ outcome: 'sent', operation: 'notification.createSubscription' })
    expect(await refusalOf(gatewayCall(ebayWrite()))).toMatchObject({ outcome: 'gated' })
    expect(h.calls).toHaveLength(1)
  })
  it('3. an order action (refund, shipment, cancel) follows its own switch, not the listing publish mode', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', '')
    await gatewayCall(ebayWrite({ kind: 'action', operation: 'fulfillment.issueRefund', url: 'https://api.ebay.com/sell/fulfillment/v1/order/1-2/issue_refund', method: 'POST' }))
    expect(h.calls).toHaveLength(1)
    expect(h.ledger.at(-1)).toMatchObject({ outcome: 'sent' })
  })
  it('3. a client moved onto the gateway as is can keep its own mode check', async () => {
    vi.stubEnv('EBAY_PUBLISH_MODE', 'dry-run')
    await gatewayCall(ebayWrite({ modeAppliedByCaller: true }))
    expect(h.calls).toHaveLength(1)
  })
  it('4. the push lock refuses a paused listing, and the wrong-account guard refuses a foreign one — 0 calls', async () => {
    expect(await refusalOf(gatewayCall(ebayWrite({ pushLock: [{ syncPaused: true } as never] })))).toMatchObject({ outcome: 'refused', code: 'PUSH_SYNC_PAUSED' })
    h.wrongAccount = 'Nothing was sent to eBay: this change is for a listing of the eBay account "B".'
    expect(await refusalOf(gatewayCall(ebayWrite({ writeTarget: { listingIds: ['l1'] } })))).toMatchObject({ outcome: 'refused', code: 'WRONG_ACCOUNT_WRITE', message: h.wrongAccount })
    expect(h.calls).toHaveLength(0)
  })
})

describe('P1.1 — step 5: headers and signing', () => {
  it('eBay: bearer + the three market headers from the Marketplace row (IT is it-IT, not en-US)', async () => {
    await gatewayCall(ebayWrite())
    expect(h.calls[0].headers).toMatchObject({ Authorization: 'Bearer tok-ebay-A', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT', 'Content-Language': 'it-IT', 'Accept-Language': 'it-IT' })
  })
  it.each([
    ['EBAY_IT', null, 'EBAY_IT', 'it-IT'], ['DE', null, 'EBAY_DE', 'de-DE'], ['ebay_fr', null, 'EBAY_FR', 'fr-FR'],
    ['ES', null, 'EBAY_ES', 'es-ES'], ['EBAY_GB', null, 'EBAY_GB', 'en-GB'], ['UK', null, 'EBAY_GB', 'en-GB'],
    ['BE', null, 'EBAY_BE', 'fr-BE'], ['BE', 'nl', 'EBAY_BE', 'nl-BE'],
  ])('P1.5 — market %s (language %s) sends %s + %s in all three headers', async (market, language, id, tag) => {
    await gatewayCall(ebayWrite({ marketplace: market, contentLanguage: language }))
    expect(h.calls[0].headers).toMatchObject({ 'X-EBAY-C-MARKETPLACE-ID': id, 'Content-Language': tag, 'Accept-Language': tag })
  })
  it('P1.5 — a write to a market with no languages, an unknown market, or a language the market lacks: refused, 0 calls; a read goes without', async () => {
    for (const [market, language] of [['PL', null], ['NL', null], ['BE', 'de']] as const) {
      expect(await refusalOf(gatewayCall(ebayWrite({ marketplace: market, contentLanguage: language })))).toMatchObject({ outcome: 'refused', code: 'MARKET_UNCONFIGURED' })
    }
    expect(h.calls).toHaveLength(0)
    await gatewayCall(ebayWrite({ kind: 'read', method: 'GET', body: null, marketplace: 'PL' }))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].headers['Content-Language']).toBeUndefined()
  })
  it('eBay must-sign paths are signed; others are not', async () => {
    await gatewayCall(ebayWrite())
    await gatewayCall(ebayWrite({ operation: 'fulfillment.issueRefund', url: 'https://api.ebay.com/sell/fulfillment/v1/order/1-2-3/issue_refund', method: 'POST' }))
    expect(h.signed).toBe(1)
    expect(h.calls[1].headers).toMatchObject({ Signature: 'sig1=:x:' })
    expect(h.calls[0].headers.Signature).toBeUndefined()
  })
  it('Amazon, Shopify, Ads: each channel its own login header', async () => {
    await gatewayCall({ channel: 'AMAZON_SP', operation: 'orders.get', kind: 'read', connectionId: 'amz-A', url: 'https://sellingpartnerapi-eu.amazon.com/orders/v0/orders', method: 'GET' })
    await gatewayCall({ channel: 'SHOPIFY', operation: 'graphql', kind: 'read', connectionId: 'shop-A', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: '{"query":"{shop{name}}"}' })
    await gatewayCall({ channel: 'AMAZON_ADS', operation: 'profiles.list', kind: 'read', connectionId: 'ads-A', url: 'https://advertising-api-eu.amazon.com/v2/profiles', method: 'GET', headers: { 'Amazon-Advertising-API-ClientId': 'cid' } })
    expect(h.calls[0].headers['x-amz-access-token']).toBe('amz-amz-A')
    expect(h.calls[1].headers['X-Shopify-Access-Token']).toBe('tok-shop-A')
    expect(h.calls[2].headers).toMatchObject({ Authorization: 'Bearer tok-ads-A', 'Amazon-Advertising-API-ClientId': 'cid' })
  })
})

describe('P1.1 — step 6: rate buckets fed by the channel', () => {
  it('a 429 waits for its Retry-After and retries; the ledger counts the attempts', async () => {
    h.answers.push(() => json({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] }, 429, { 'retry-after': '0.05' }), () => json({ payload: {} }))
    const res = await gatewayCall({ channel: 'AMAZON_SP', operation: 'listings.patch', kind: 'write', connectionId: 'amz-A', url: 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/SKU', method: 'PATCH', body: '{}' })
    expect(res).toMatchObject({ ok: true, attempts: 2 })
    expect(h.ledger.at(-1)).toMatchObject({ success: true, attempts: 2, outcome: 'sent' })
  })
  it('a 429 that never clears ends as rate_limited (retryable), after the allowed retries', async () => {
    for (let i = 0; i < 5; i++) h.answers.push(() => json({ errors: [{ code: 'QuotaExceeded' }] }, 429, { 'retry-after': '0.01' }))
    const res = await gatewayCall({ channel: 'AMAZON_SP', operation: 'listings.patch', kind: 'write', connectionId: 'amz-A', url: 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/SKU', method: 'PATCH', body: '{}', max429Retries: 1 })
    expect(res).toMatchObject({ ok: false, attempts: 2, verdict: { errorClass: 'rate_limited', retryable: true, channelCode: 'QuotaExceeded' } })
  })
  it('Shopify THROTTLED inside a 200 is retried like a 429, and the body headroom is recorded', async () => {
    h.answers.push(
      () => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 } } } }),
      () => json({ data: { shop: { name: 'x' } }, extensions: { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } }),
    )
    const res = await gatewayCall({ channel: 'SHOPIFY', operation: 'graphql', kind: 'read', connectionId: 'shop-A', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: '{}' })
    expect(res).toMatchObject({ ok: true, attempts: 2, rate: { remaining: 1990, limit: 2000 } })
    expect(h.ledger.at(-1)).toMatchObject({ rateLimitRemaining: 1990, rateLimitLimit: 2000 })
  })
  it('Shopify GraphQL errors in a 200 are NOT ok', async () => {
    h.answers.push(() => json({ errors: [{ message: 'Field x does not exist', extensions: { code: 'undefinedField' } }] }))
    const res = await gatewayCall({ channel: 'SHOPIFY', operation: 'graphql', kind: 'read', connectionId: 'shop-A', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: '{}' })
    expect(res).toMatchObject({ ok: false, verdict: { errorClass: 'validation', channelMessage: 'Field x does not exist' } })
  })
  it('no token within the wait → not sent, rate_limited locally (the queue retries later)', async () => {
    const key = 'EBAY:ebay-A:all'
    await observeRate('EBAY', key, { retryAfterSec: 30 })
    expect(await refusalOf(gatewayCall(ebayWrite({ maxRateWaitMs: 0 })))).toMatchObject({ outcome: 'refused', code: 'RATE_LIMITED_LOCAL', statusCode: 429 })
    expect(h.calls).toHaveLength(0)
  })
  it('the bucket itself: capacity then refill; Amazon\'s rate header sets the refill', async () => {
    const slept: number[] = []
    const sleep = async (ms: number) => { slept.push(ms); await new Promise((r) => setTimeout(r, ms)) }
    const key = 'AMAZON_SP:amz-B:PATCH /listings/2021-08-01/items'
    await observeRate('AMAZON_SP', key, { limit: 100 }) // 100 per second
    for (let i = 0; i < 10; i++) expect((await takeToken('AMAZON_SP', key, 0, sleep)).ok).toBe(true)
    const eleventh = await takeToken('AMAZON_SP', key, 1000, sleep)
    expect(eleventh.ok).toBe(true)
    expect(slept[0]).toBeLessThanOrEqual(10) // 1 token at 100/s ≈ 10 ms
    expect(bucketGroupOf('AMAZON_SP', 'patch', 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/SELLER123/SKU-9')).toBe('PATCH /listings/2021-08-01/items')
  })
})

describe('P1.1 — steps 7–9: key, class, ledger', () => {
  it('a stable idempotency key: same parts, same key; recorded on the ledger row', async () => {
    const key = idempotencyKeyFor('inventory', 'ebay-A', 'SKU-1', 3)
    expect(key).toBe(idempotencyKeyFor('inventory', 'ebay-A', 'SKU-1', 3))
    expect(key).not.toBe(idempotencyKeyFor('inventory', 'ebay-A', 'SKU-1', 4))
    await gatewayCall(ebayWrite({ idempotencyKey: key }))
    expect(h.ledger.at(-1)).toMatchObject({ idempotencyKey: key })
  })
  it('ONE ledger row per call, with account, operation, time, api version; payloads only on failure, made safe', async () => {
    await gatewayCall(ebayWrite())
    h.answers.push(() => json({ errors: [{ errorId: 25002, message: 'Bad SKU', parameters: [] }], buyerEmail: 'buyer@example.com' }, 400))
    await gatewayCall(ebayWrite({ body: JSON.stringify({ shipTo: { fullName: 'Mario Rossi' }, token: 'secret-token' }) }))
    expect(h.ledger).toHaveLength(2)
    expect(h.ledger[0]).toMatchObject({ channel: 'EBAY', connectionId: 'ebay-A', operation: 'inventory.createOrReplaceInventoryItem', success: true, statusCode: 200, outcome: 'sent', apiVersion: 'v1', endpoint: 'api.ebay.com/sell/inventory/v1/inventory_item/SKU-1' })
    expect(h.ledger[0].requestPayload).toBeUndefined()
    expect(h.ledger[1]).toMatchObject({ success: false, statusCode: 400, errorClass: 'validation', errorCode: '25002', errorMessage: 'Bad SKU' })
    const stored = JSON.stringify([h.ledger[1].requestPayload, h.ledger[1].responsePayload])
    expect(stored).not.toMatch(/Mario Rossi|buyer@example.com|secret-token/)
    expect(stored).toMatch(/\[personal\]/)
  })
  it('a network failure on a read is retried once; a timeout is classed timeout', async () => {
    h.answers.push(() => { throw new TypeError('fetch failed') }, () => json({ ok: true }))
    expect(await gatewayCall(ebayWrite({ kind: 'read', method: 'GET', body: null, retryBackoffMs: 1 }))).toMatchObject({ ok: true, attempts: 2 })
    h.answers.push(() => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }, () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e })
    expect(await gatewayCall(ebayWrite({ kind: 'read', method: 'GET', body: null, retryBackoffMs: 1 }))).toMatchObject({ ok: false, attempts: 2, verdict: { errorClass: 'timeout', retryable: true } })
  })
  it('a write that could apply twice (POST) is NOT retried on a 5xx or a network error', async () => {
    h.answers.push(() => json({ errors: [{ errorId: 25001, message: 'System error' }] }, 500))
    expect(await gatewayCall(ebayWrite({ method: 'POST', retryBackoffMs: 1 }))).toMatchObject({ ok: false, attempts: 1, verdict: { errorClass: 'transient', retryable: true } })
    h.answers.push(() => { throw new TypeError('fetch failed') })
    expect(await gatewayCall(ebayWrite({ method: 'PATCH', retryBackoffMs: 1 }))).toMatchObject({ ok: false, attempts: 1, verdict: { errorClass: 'network' } })
  })
  it('a write that is safe to repeat (PUT, or flagged idempotent) is retried with a growing wait, up to the limit', async () => {
    for (let i = 0; i < 5; i++) h.answers.push(() => json({ errors: [{ errorId: 25001 }] }, 503))
    const started = Date.now()
    expect(await gatewayCall(ebayWrite({ method: 'PUT', maxTransientRetries: 3, retryBackoffMs: 20 }))).toMatchObject({ ok: false, attempts: 4 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(20 + 40 + 80 - 5)
    h.answers.length = 0
    h.answers.push(() => { throw new TypeError('fetch failed') }, () => json({ ok: true }))
    expect(await gatewayCall(ebayWrite({ method: 'PATCH', idempotent: true, retryBackoffMs: 1 }))).toMatchObject({ ok: true, attempts: 2 })
  })
})

describe('P1.1 — the vocabulary and the redaction on their own', () => {
  it.each([
    ['EBAY', 400, JSON.stringify({ errors: [{ errorId: 215002, message: 'Signature validation failed' }] }), 'signature'],
    ['EBAY', 401, '{"error":"invalid_grant"}', 'auth_revoked'],
    ['AMAZON_SP', 403, JSON.stringify({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }), 'forbidden'],
    ['AMAZON_SP', 400, JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'bad' }] }), 'validation'],
    ['AMAZON_SP', 401, '{"error_description":"Client authentication failed","error":"invalid_client"}', 'configuration'],
    ['SHOPIFY', 402, 'Payment Required', 'forbidden'],
    ['SHOPIFY', 401, '{"errors":"[API] Invalid API key or access token"}', 'auth_revoked'],
    ['AMAZON_ADS', 404, '{"code":"NOT_FOUND","details":"Profile not found"}', 'not_found'],
    ['EBAY', 503, 'Service Unavailable', 'transient'],
    ['EBAY', 0, 'ECONNRESET', 'network'],
  ] as const)('%s %i → %s', (channel, status, text, cls) => {
    expect(classifyChannelAnswer(channel, status, text).errorClass).toBe(cls)
  })
  it('redaction: secrets and personal fields go, structure stays; XML credentials too; big bodies are capped', () => {
    expect(ledgerSafeBody({ order: { buyer: { username: 'b1' }, shippingAddress: { city: 'Roma' }, total: 10 }, access_token: 'abc' }))
      .toEqual({ order: { buyer: '[personal]', shippingAddress: '[personal]', total: 10 }, access_token: '[redacted]' })
    expect(ledgerSafeBody('<ReviseItemRequest><RequesterCredentials><eBayAuthToken>T</eBayAuthToken></RequesterCredentials><Email>a@b.c</Email></ReviseItemRequest>'))
      .toBe('<ReviseItemRequest><RequesterCredentials>[redacted]</RequesterCredentials><Email>[personal]</Email></ReviseItemRequest>')
    expect(ledgerSafeBody({ blob: 'x'.repeat(40_000) })).toMatchObject({ __truncated: true })
    expect(apiVersionOf('AMAZON_SP', 'https://sellingpartnerapi-eu.amazon.com/orders/v0/orders')).toBe('v0')
  })
})

describe('P1.2 — eBay read / write / action / setup', () => {
  it.each([
    ['GET', 'https://api.ebay.com/sell/inventory/v1/inventory_item/S', 'read'],
    ['PUT', 'https://api.ebay.com/sell/inventory/v1/inventory_item/S', 'write'],
    ['POST', 'https://api.ebay.com/sell/inventory/v1/offer/1/publish', 'write'],
    ['POST', 'https://api.ebay.com/sell/inventory/v1/bulk_get_inventory_item', 'read'],
    ['POST', 'https://api.ebay.com/sell/fulfillment/v1/order/1/issue_refund', 'action'],
    ['POST', 'https://api.ebay.com/post-order/v2/cancellation', 'action'],
    ['POST', 'https://api.ebay.com/sell/marketing/v1/item_price_markdown', 'action'],
    ['POST', 'https://api.ebay.com/commerce/notification/v1/subscription', 'setup'],
    ['POST', 'https://apiz.ebay.com/developer/key_management/v1/signing_key', 'setup'],
  ])('%s %s → %s', async (method, url, kind) => {
    const { ebayKind } = await import('./ebay.js')
    expect(ebayKind(method, url)).toBe(kind)
  })
})
