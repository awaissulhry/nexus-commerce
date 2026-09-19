/**
 * P1.2 — Amazon Ads on the gateway, driven through the REAL Ads client (`liveCall`, profiles ON): the
 * account the client resolved, its token and client id, one ledger row per send, the client's own retry
 * loop kept (the gateway does not retry again), and the read / action rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { adsKind } from './ads.js'
import { liveCall } from '../advertising/ads-api-client.js'

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ campaigns: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('P1.2 — the Ads client sends through the gateway', () => {
  it('a list read: the account\'s token and client id, the profile scope, one ledger row against the account', async () => {
    await liveCall({ profileId: '123', region: 'EU', method: 'POST', path: '/sp/campaigns/list', body: {} })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('https://advertising-api-eu.amazon.com/sp/campaigns/list')
    expect(h.calls[0].init.headers).toMatchObject({ Authorization: 'Bearer ads-token', 'Amazon-Advertising-API-ClientId': 'amzn1.application-oa2-client.x', 'Amazon-Advertising-API-Scope': '123' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', connectionId: 'ads-1', outcome: 'sent', success: true })])
  })

  it('a 429 is retried by the client\'s own loop (once per its policy), each send its own row — the gateway adds no retry', async () => {
    h.answers.push(() => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }), () => new Response('{"ok":true}', { status: 200 }))
    await liveCall({ profileId: '123', region: 'EU', method: 'PUT', path: '/sp/keywords', body: [] })
    expect(h.calls).toHaveLength(2)
    expect(gatewayLedger.map((r) => [r.success, r.attempts])).toEqual([[false, 1], [true, 1]])
  })

  it('an Ads change is an action (its own write gate decides): sent while the listing publish switches are off', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '')
    await liveCall({ profileId: '123', region: 'EU', method: 'PUT', path: '/sp/keywords', body: [] })
    expect(h.calls).toHaveLength(1)
  })

  it('read / action', () => {
    expect(adsKind('GET', 'https://advertising-api-eu.amazon.com/v2/profiles')).toBe('read')
    expect(adsKind('POST', 'https://advertising-api-eu.amazon.com/sp/campaigns/list')).toBe('read')
    expect(adsKind('PUT', 'https://advertising-api-eu.amazon.com/sp/keywords')).toBe('action')
    expect(adsKind('POST', 'https://advertising-api-eu.amazon.com/reporting/reports')).toBe('action')
  })
})
