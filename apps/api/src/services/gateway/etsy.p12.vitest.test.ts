/**
 * P1.2 — Etsy on the gateway: the connected-account reader sends through it (the app key header kept,
 * the account's token, one ledger row against the account), Etsy's errors are classed, and its daily
 * quota headers become the headroom on the ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: vi.fn(async () => ({ id: 'etsy-1', channelType: 'ETSY', identity: { extra: { shopId: '42' } } })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'etsy-token') }))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'key', clientSecret: 'secret' })) }))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { etsyReader } from '../etsy/read-client.js'

beforeEach(() => {
  __rateTest.useMemory(); h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'x-remaining-today': '9990', 'x-limit-per-day': '10000' } })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); __rateTest.reset() })

describe('P1.2 — Etsy through the gateway', () => {
  it('the reader: app key kept, the account token, one ledger row with the daily headroom and no ids in the name', async () => {
    const reader = await etsyReader('etsy-1')
    await reader.get('/shops/42/listings/active?limit=1')
    expect(h.calls[0].url).toBe('https://api.etsy.com/v3/application/shops/42/listings/active?limit=1')
    expect(h.calls[0].init.headers).toMatchObject({ 'x-api-key': 'key:secret', Authorization: 'Bearer etsy-token' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'ETSY', connectionId: 'etsy-1', operation: 'GET /shops/:id/listings/active', rateLimitRemaining: 9990, rateLimitLimit: 10000, apiVersion: 'v3' })])
  })
  it('a failed read keeps the reader\'s own error and gets its class on the ledger', async () => {
    h.answers.push(() => new Response('{"error":"invalid_token"}', { status: 401 }))
    const reader = await etsyReader('etsy-1')
    await expect(reader.get('/shops/42')).rejects.toThrow('HTTP 401')
    expect(gatewayLedger.at(-1)).toMatchObject({ success: false, errorClass: 'auth_expired' })
  })
  it('Etsy classes', () => {
    expect(classifyChannelAnswer('ETSY', 400, '{"error":"invalid_grant"}').errorClass).toBe('auth_revoked')
    expect(classifyChannelAnswer('ETSY', 429, '{"error":"rate limit"}').errorClass).toBe('rate_limited')
    expect(classifyChannelAnswer('ETSY', 404, '{"error":"not found"}').errorClass).toBe('not_found')
  })
})
