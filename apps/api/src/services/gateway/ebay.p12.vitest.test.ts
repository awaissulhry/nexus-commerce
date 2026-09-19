/**
 * P1.2 — eBay on the gateway: the `fetch`-shaped senders the moved files use, the token-to-account
 * memory, the Trading sender, caller deadlines and file bodies. `fetch` is a fake channel that records
 * every request; the account check and ledger are stand-ins; the gateway itself is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response | Promise<Response>>,
}))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async (id: string) => `account-token-${id}`) }))
// The eBay Marketplace rows as seeded (IT, DE, FR, ES, UK) plus a two-language market (BE).
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: vi.fn(async ({ where }: any) => ({
  IT: { marketplaceId: 'EBAY_IT', languages: ['it'], language: 'it' }, DE: { marketplaceId: 'EBAY_DE', languages: ['de'], language: 'de' },
  FR: { marketplaceId: 'EBAY_FR', languages: ['fr'], language: 'fr' }, ES: { marketplaceId: 'EBAY_ES', languages: ['es'], language: 'es' },
  UK: { marketplaceId: 'EBAY_GB', languages: ['en'], language: 'en' }, BE: { marketplaceId: 'EBAY_BE', languages: ['fr', 'nl'], language: 'fr' },
} as Record<string, unknown>)[where.code] ?? null) } } }))

import { gatewayAccounts, gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { ebaySend, ebayTradingSend, ebayTransport } from './ebay.js'
import { __tokenAccountsTest, accountOfToken, rememberTokenAccount } from './token-accounts.js'

const ok = (body: unknown = {}, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

beforeEach(() => {
  __rateTest.useMemory(); __tokenAccountsTest.clear()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayAccounts)) delete gatewayAccounts[key]
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const next = h.answers.shift()
    return next ? next() : ok()
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('ebayTransport — a file\'s fetch calls moved onto the gateway unchanged', () => {
  it('a read keeps the call\'s own headers and bearer token (English labels on purpose) and gets only the missing market header', async () => {
    await ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/offer?sku=S', { headers: { Authorization: 'Bearer caller-token', 'Accept-Language': 'en-US', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT' } })
    expect(h.calls[0].init.headers).toMatchObject({ Authorization: 'Bearer caller-token', 'Accept-Language': 'en-US', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT', 'Content-Language': 'it-IT' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ connectionId: 'conn-1', marketplace: 'EBAY_IT', operation: 'GET /sell/inventory/v1/offer', outcome: 'sent' })])
  })

  it('no bearer header → the account\'s own token', async () => {
    await ebaySend('conn-2', 'https://api.ebay.com/sell/account/v1/fulfillment_policy', {})
    expect(h.calls[0].init.headers).toMatchObject({ Authorization: 'Bearer account-token-conn-2' })
  })

  it('a listing write follows the publish mode; an order action does not', async () => {
    vi.stubEnv('EBAY_PUBLISH_MODE', 'dry-run')
    expect(await refusalOf(ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/offer/1/publish', { method: 'POST', body: '{}' }))).toMatchObject({ code: 'DRY_RUN' })
    await ebaySend('conn-1', 'https://api.ebay.com/sell/fulfillment/v1/order/1/shipping_fulfillment', { method: 'POST', body: '{}' })
    expect(h.calls.map((c) => c.url)).toEqual(['https://api.ebay.com/sell/fulfillment/v1/order/1/shipping_fulfillment'])
  })

  it('a held account is not called', async () => {
    gatewayAccounts['conn-stale'] = { authStatus: 'needs_reauth', isActive: true, displayName: 'Old' }
    expect(await refusalOf(ebaySend('conn-stale', 'https://api.ebay.com/sell/inventory/v1/offer', {}))).toMatchObject({ code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(h.calls).toHaveLength(0)
  })

  it('bodies: text as is; a form becomes text with its content type; a file upload passes through; anything else is refused', async () => {
    await ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/offer', { method: 'POST', body: '{"a":1}' })
    await ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/offer', { method: 'POST', body: new URLSearchParams({ q: 'x' }) })
    const form = new FormData(); form.append('file', new Blob(['ndjson']), 'feed.json')
    await ebaySend('conn-1', 'https://api.ebay.com/sell/feed/v1/task/t/upload_file', { method: 'POST', body: form })
    expect(h.calls[0].init.body).toBe('{"a":1}')
    expect(h.calls[1].init).toMatchObject({ body: 'q=x', headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }) })
    expect(h.calls[2].init.body).toBe(form)
    const stream = new ReadableStream()
    await expect(ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/offer', { method: 'POST', body: stream as never })).rejects.toThrow('does not go through the channel gateway')
    expect(h.calls).toHaveLength(3)
  })

  it('a failed file upload: the ledger keeps the size of the file, never its content', async () => {
    h.answers.push(() => ok({ errors: [{ errorId: 1 }] }, 400))
    await ebaySend('conn-1', 'https://api.ebay.com/sell/feed/v1/task/t/upload_file', { method: 'POST', body: new TextEncoder().encode('secret-ndjson') })
    expect(JSON.stringify(gatewayLedger.at(-1)?.requestPayload)).toBe('{"__binary":true,"bytes":13}')
  })

  it('the caller\'s own deadline is kept (a signal that aborts ends the call as a timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })))
    const res = ebayTransport('conn-1', { maxTransientRetries: 0 })('https://api.ebay.com/sell/account/v1/payment_policy', { signal: AbortSignal.timeout(30) })
    await expect(res).rejects.toMatchObject({ name: 'GatewayNoAnswer', errorClass: 'timeout' })
  })

  it('an own retry loop turns the gateway\'s retries off (no double retries)', async () => {
    h.answers.push(() => ok({ errors: [] }, 503), () => ok({}))
    const res = await ebayTransport('conn-1', { maxTransientRetries: 0, max429Retries: 0 })('https://api.ebay.com/sell/inventory/v1/inventory_item/S', { method: 'PUT', body: '{}' })
    expect(res.status).toBe(503)
    expect(h.calls).toHaveLength(1)
  })
})

describe('token-to-account memory — a call site that holds only the token', () => {
  it('the token service records every token it hands out; the gateway finds the account from it', async () => {
    rememberTokenAccount('tok-B', 'conn-B')
    await ebaySend(null, 'https://api.ebay.com/sell/marketing/v1/ad_campaign', { headers: { Authorization: 'Bearer tok-B' } })
    expect(gatewayLedger.at(-1)).toMatchObject({ connectionId: 'conn-B', outcome: 'sent' })
  })
  it('a token Nexus did not hand out has no account: refused, never "the primary"', async () => {
    expect(await refusalOf(ebaySend(null, 'https://api.ebay.com/sell/marketing/v1/ad_campaign', { headers: { Authorization: 'Bearer foreign' } }))).toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(h.calls).toHaveLength(0)
  })
  it('keeps a hash, not the token; the newest mapping wins', () => {
    rememberTokenAccount('tok-C', 'conn-1'); rememberTokenAccount('tok-C', 'conn-2')
    expect(accountOfToken('tok-C')).toBe('conn-2')
    expect(accountOfToken('tok-D')).toBeNull()
  })
})

describe('ebayTradingSend — Trading XML calls from their own files', () => {
  it('names the call from its header, finds the account from the IAF token, reads the Ack', async () => {
    rememberTokenAccount('iaf-1', 'conn-T')
    h.answers.push(() => ok('<R><Ack>Failure</Ack><Errors><ErrorCode>21916984</ErrorCode><LongMessage>Internal</LongMessage></Errors></R>'))
    const res = await ebayTradingSend(null, 'https://api.ebay.com/ws/api.dll', { method: 'POST', headers: { 'X-EBAY-API-CALL-NAME': 'GetFeedback', 'X-EBAY-API-IAF-TOKEN': 'iaf-1' }, body: '<x/>' })
    expect(res.status).toBe(200)
    expect(gatewayLedger.at(-1)).toMatchObject({ connectionId: 'conn-T', operation: 'trading.GetFeedback', success: false, errorClass: 'transient', errorCode: '21916984' })
    expect((h.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('P1.5 — eBay market headers on a listing write, from the Marketplace row', () => {
  const put = (market: string, language?: string) => ebaySend('conn-1', 'https://api.ebay.com/sell/inventory/v1/inventory_item/S', {
    method: 'PUT', body: '{}', headers: { 'X-EBAY-C-MARKETPLACE-ID': market, 'Content-Type': 'application/json', ...(language ? { 'Content-Language': language, 'accept-language': language } : {}) },
  })
  it.each([
    ['EBAY_IT', 'EBAY_IT', 'it-IT'], ['EBAY_DE', 'EBAY_DE', 'de-DE'], ['EBAY_FR', 'EBAY_FR', 'fr-FR'],
    ['EBAY_ES', 'EBAY_ES', 'es-ES'], ['EBAY_GB', 'EBAY_GB', 'en-GB'], ['EBAY_BE', 'EBAY_BE', 'fr-BE'],
  ])('%s: all three headers right (the old helper sent en-US for the full id)', async (market, id, tag) => {
    await put(market, 'en-US')
    const sent = h.calls[0].init.headers as Record<string, string>
    expect(sent).toMatchObject({ 'X-EBAY-C-MARKETPLACE-ID': id, 'Content-Language': tag, 'Accept-Language': tag })
    // one value per header — the caller's differently-cased copy is gone, not joined
    expect(Object.keys(sent).filter((k) => k.toLowerCase() === 'accept-language')).toEqual(['Accept-Language'])
  })
  it('a language of the market that the caller chose is kept (Belgium in Dutch)', async () => {
    await put('EBAY_BE', 'nl-BE')
    expect(h.calls[0].init.headers).toMatchObject({ 'Content-Language': 'nl-BE', 'Accept-Language': 'nl-BE' })
  })
  it('a listing write to a market Nexus has no row for: refused, nothing sent', async () => {
    const refused = await put('EBAY_AU').then(() => null, (e) => e)
    expect(refused).toMatchObject({ code: 'MARKET_UNCONFIGURED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a failed market lookup is not "market not set up": refused as MARKET_LOOKUP_FAILED (retry later), nothing sent', async () => {
    const db = (await import('../../db.js')).default as any
    const real = db.marketplace.findFirst
    db.marketplace.findFirst = vi.fn(async () => { throw new Error('connection reset') })
    try {
      expect(await put('EBAY_IT').then(() => null, (e) => e)).toMatchObject({ code: 'MARKET_LOOKUP_FAILED', statusCode: 503 })
      expect(h.calls).toHaveLength(0)
    } finally { db.marketplace.findFirst = real }
  })
  it('the language helper the callers use reads the same row (and answers en-US only for an unknown market)', async () => {
    const { ebayListingLanguage } = await import('./channels.js')
    expect(await Promise.all(['EBAY_IT', 'IT', 'EBAY_GB', 'UK', 'EBAY_AU'].map(ebayListingLanguage))).toEqual(['it-IT', 'it-IT', 'en-GB', 'en-GB', 'en-US'])
  })
})
