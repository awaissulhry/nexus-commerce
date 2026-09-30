/**
 * P4.6b — the Etsy write client, on the gateway.
 *
 * Every case here drives a real `gatewayCall`, so what is proven is the behaviour of the pair
 * (client + gateway), not the client's intentions about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response | Promise<Response>>,
  connection: { id: 'etsy-1', channelType: 'ETSY', identity: { extra: { shopId: '42' } } } as Record<string, unknown>,
}))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: vi.fn(async () => h.connection) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => '12345678.etsy-token') }))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'keystring', clientSecret: 'sharedsecret' })) }))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import { GatewayNoAnswer, GatewayRefusal } from '../gateway/gateway.js'
import { etsyWriter, EtsyWriteError, etsyErrorSentence } from './write-client.js'

const live = () => { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live') }
const gated = () => { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', ''); vi.stubEnv('ETSY_PUBLISH_MODE', '') }

beforeEach(() => {
  __rateTest.useMemory(); h.calls = []; h.answers = []; gatewayLedger.length = 0
  h.connection = { id: 'etsy-1', channelType: 'ETSY', identity: { extra: { shopId: '42' } } }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return (await h.answers.shift()?.()) ?? new Response('{"listing_id":7}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __rateTest.reset() })

describe('P4.6b — a listing write', () => {
  it('passes lease loss through the gateway to the HTTP request as an unknown outcome', async () => {
    live()
    const abort = new AbortController()
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!
        if (signal.aborted) { reject(new DOMException('Lease lost', 'AbortError')); return }
        signal.addEventListener('abort', () => reject(new DOMException('Lease lost', 'AbortError')), { once: true })
        entered()
      })
    }))
    const etsy = await etsyWriter('etsy-1')
    const result = etsy.send({ path: '/listings/7/inventory', method: 'PUT', body: {}, signal: abort.signal })
    const outcome = expect(result).rejects.toBeInstanceOf(GatewayNoAnswer)
    await started
    abort.abort()
    await outcome
  })
  it('names its account, carries keystring:shared_secret and the bearer, and lands on the ledger', async () => {
    live()
    const etsy = await etsyWriter('etsy-1')
    expect(etsy.shopId).toBe('42')
    const answer = await etsy.send<{ listing_id: number }>({ path: '/shops/42/listings/7', method: 'PATCH', body: { title: 'New' } })
    expect(answer).toEqual({ listing_id: 7 })
    expect(h.calls[0].url).toBe('https://api.etsy.com/v3/application/shops/42/listings/7')
    expect(h.calls[0].init.method).toBe('PATCH')
    // Etsy's documented format, verified 2026-09-21: keystring and shared secret, colon-separated.
    expect(h.calls[0].init.headers).toMatchObject({
      'x-api-key': 'keystring:sharedsecret',
      Authorization: 'Bearer 12345678.etsy-token',
      'Content-Type': 'application/json',
    })
    expect(h.calls[0].init.body).toBe('{"title":"New"}')
    expect(gatewayLedger.at(-1)).toMatchObject({
      channel: 'ETSY', connectionId: 'etsy-1', operation: 'PATCH /shops/:id/listings/:id', outcome: 'sent', success: true,
    })
  })

  it('is governed by the Etsy publish mode — nothing leaves while it is gated', async () => {
    gated()
    const etsy = await etsyWriter('etsy-1')
    await expect(etsy.send({ path: '/shops/42/listings/7', method: 'PATCH', body: { title: 'New' } }))
      .rejects.toMatchObject({ name: 'GatewayRefusal', code: 'PUBLISH_GATED' })
    expect(h.calls).toEqual([])
  })

  it('a push-locked listing is refused before the call', async () => {
    live()
    const etsy = await etsyWriter('etsy-1')
    const refusal = await etsy.send({
      path: '/listings/7/inventory', method: 'PUT', body: { products: [] },
      pushLock: [{ syncPaused: true }],
    }).then(() => null, (e) => e as GatewayRefusal)
    expect(refusal).toBeInstanceOf(GatewayRefusal)
    expect(refusal?.code).toBe('PUSH_SYNC_PAUSED')
    expect(refusal?.outcome).toBe('refused')
    expect(h.calls).toEqual([])
  })
})

describe('P4.6b — an order ACTION is not a listing write', () => {
  it('a shipment notice is sent while listing publishing is GATED — it has its own switch', async () => {
    // The gateway's contract: the publish mode applies to `write`, not to `action`. Marking a
    // receipt shipped is not publishing a listing, and one switch must not silently govern both.
    gated()
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/shops/42/receipts/9/tracking', method: 'POST', kind: 'action', body: { tracking_code: 'T1' } })
    expect(h.calls).toHaveLength(1)
    expect(gatewayLedger.at(-1)).toMatchObject({ outcome: 'sent', operation: 'POST /shops/:id/receipts/:id/tracking' })
  })
})

describe('P4.6b — Etsy has no idempotency key, so only PUT and DELETE repeat', () => {
  const noAnswer = () => { throw new TypeError('fetch failed') }

  it('🔴 a POST is NOT retried after a transport failure — a retry is a second tracking number', async () => {
    live()
    h.answers.push(noAnswer, noAnswer)
    const etsy = await etsyWriter('etsy-1')
    await expect(etsy.send({ path: '/shops/42/listings/7/images', method: 'POST', body: { image: 'x' } }))
      .rejects.toBeInstanceOf(GatewayNoAnswer)
    expect(h.calls).toHaveLength(1)
  })

  it('a PATCH is NOT retried either', async () => {
    live()
    h.answers.push(noAnswer, noAnswer)
    const etsy = await etsyWriter('etsy-1')
    await expect(etsy.send({ path: '/shops/42/listings/7', method: 'PATCH', body: { title: 'x' } })).rejects.toThrow()
    expect(h.calls).toHaveLength(1)
  })

  it('POSITIVE CONTROL: a PUT IS retried — the same body gives the same result', async () => {
    live()
    h.answers.push(noAnswer)
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/listings/7/inventory', method: 'PUT', body: { products: [] } })
    expect(h.calls).toHaveLength(2)
  })
})

describe('P4.6b — what Etsy says comes back as a sentence', () => {
  it('a 400 keeps Etsy\'s own words and the status', async () => {
    live()
    h.answers.push(() => new Response('{"error":"Array contains invalid keys: product_id,is_deleted"}', { status: 400 }))
    const etsy = await etsyWriter('etsy-1')
    const err = await etsy.send({ path: '/listings/7/inventory', method: 'PUT', body: {} }).then(() => null, (e) => e as EtsyWriteError)
    expect(err).toBeInstanceOf(EtsyWriteError)
    expect(err?.status).toBe(400)
    expect(err?.message).toBe('Etsy refused this change (HTTP 400): Array contains invalid keys: product_id,is_deleted.')
  })
  it('a 429 is retried by the gateway first, and only then says what to do about it', async () => {
    live()
    // The gateway retries a 429 whatever the method (max429Retries = 2), because a throttle means
    // nothing was done — so three answers are needed to see the sentence. The FIRST version of this
    // test pushed one 429, got the default 200 back and "passed" the wrong proposition.
    const throttled = () => new Response('{"error":"Limit exceeded"}', { status: 429 })
    h.answers.push(throttled, throttled, throttled)
    const etsy = await etsyWriter('etsy-1')
    await expect(etsy.send({ path: '/shops/42/listings/7', method: 'PATCH', body: {} }))
      .rejects.toThrow('Retry after the Etsy rate limit resets.')
    expect(h.calls).toHaveLength(3)
  })
  it('a body that is not JSON does not become a broken sentence', () => {
    expect(etsyErrorSentence('<html>502</html>')).toBeNull()
    expect(etsyErrorSentence('')).toBeNull()
    expect(etsyErrorSentence('{"error":"said"}')).toBe('said')
  })
})

describe('P4.6b — the account and the path are proven, not trusted', () => {
  it('a non-Etsy account is refused', async () => {
    h.connection = { id: 'x', channelType: 'SHOPIFY', identity: { extra: { shopId: '42' } } }
    await expect(etsyWriter('x')).rejects.toThrow('The selected account is not Etsy.')
  })
  it.each([null, { extra: {} }, { extra: { shopId: '' } }, { extra: { shopId: '0' } }, { extra: { shopId: 'abc' } }, { extra: { shopId: '4 2' } }])
  ('an account with identity %p has no usable shop id', async (identity) => {
    h.connection = { id: 'x', channelType: 'ETSY', identity }
    await expect(etsyWriter('x')).rejects.toThrow('The Etsy account has no verified shop identity.')
  })
  it.each(['shops/42', '//evil.example', 'https://evil.example/x', '/x://y'])('the path %p never becomes a URL', async (path) => {
    live()
    const etsy = await etsyWriter('etsy-1')
    await expect(etsy.send({ path, method: 'PATCH', body: {} })).rejects.toThrow('Invalid Etsy resource path.')
    expect(h.calls).toEqual([])
  })
})

describe('P4.6d — a form-encoded body is a DIFFERENT body format on the same channel', () => {
  it('🔴 `form` sends x-www-form-urlencoded, never JSON — updateListing refuses JSON', async () => {
    // Etsy's inventory PUT is application/json and its updateListing PATCH one path away is
    // application/x-www-form-urlencoded. Sending the wrong one is a 400 with no hint which.
    // Found by a surviving mutation: nothing here checked the header.
    live()
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/shops/42/listings/7', method: 'PATCH', form: { title: 'Mug', tags: ['a', 'b'] } })
    expect(h.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(h.calls[0].init.body).toBe('title=Mug&tags=a&tags=b')
  })
  it('POSITIVE CONTROL: the same client sends JSON when given a body instead', async () => {
    live()
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/listings/7/inventory', method: 'PUT', body: { products: [] } })
    expect(h.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(h.calls[0].init.body).toBe('{"products":[]}')
  })
  it('a form body wins over a JSON body if a caller somehow sends both', async () => {
    live()
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/shops/42/listings/7', method: 'PATCH', form: { title: 'Mug' }, body: { title: 'Other' } })
    expect(h.calls[0].init.body).toBe('title=Mug')
    expect(h.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
  })
})

describe('P4.6b — an image upload is multipart', () => {
  it('FormData is passed through and the client does NOT set Content-Type (fetch owns the boundary)', async () => {
    live()
    const form = new FormData()
    form.set('image', new Blob(['bytes']), 'a.jpg')
    const etsy = await etsyWriter('etsy-1')
    await etsy.send({ path: '/shops/42/listings/7/images', method: 'POST', body: form })
    expect(h.calls[0].init.body).toBeInstanceOf(FormData)
    expect(Object.keys(h.calls[0].init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('content-type')
  })
})
