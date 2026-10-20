/**
 * P2b — what managing an existing Sponsored Display campaign sends, built by sd-manage.client.ts (and the widened
 * sdCampaignUpdateRequest), driven through the REAL liveCall and the REAL channel gateway with `fetch` stubbed (the
 * pattern of ads-sbsd-update-shapes.vitest.test.ts). Nothing leaves the process. Shapes are Amazon's SD 3.0 document:
 *   PUT /sd/campaigns   [{ campaignId (int64), name?, startDate? YYYYMMDD, endDate? YYYYMMDD | null, portfolioId? int64 | null, state? }]
 *   PUT /sd/adGroups    [{ adGroupId (int64), name?, defaultBid?, state? }]
 *   PUT /sd/productAds  [{ adId (int64), state }]
 * and Amazon's 207 answer is read per item: anything but SUCCESS is its refusal in its own words. Ids are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../../../db.js', () => ({
  default: {
    adKeywordProtection: { findMany: async () => [] },
    adsStrategy: { findMany: async () => [] },
    campaign: { findFirst: async () => ({ id: 'c-1', marketplace: 'IT' }) },
    adGroup: { findFirst: async () => ({ campaign: { id: 'c-1', marketplace: 'IT' } }) },
    adTarget: { findFirst: async () => null },
  },
}))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { sdCampaignUpdateRequest, sdDay, sendSbSdUpdate } from '../ads-api-client.js'
import { sdAdGroupUpdateRequest, sdProductAdUpdateRequest } from './sd-manage.client.js'

const ctx = { profileId: '123', region: 'EU' as const }

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response('[]', { status: 207 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

const sent = (i = 0) => ({
  method: h.calls[i].init.method,
  path: new URL(h.calls[i].url).pathname,
  body: h.calls[i].init.body == null ? undefined : JSON.parse(String(h.calls[i].init.body)),
  headers: h.calls[i].init.headers as Record<string, string>,
})
const answer = (status: number, body: unknown) => h.answers.push(() => new Response(JSON.stringify(body), { status }))

describe('the request builders (pure)', () => {
  it('a campaign\'s settings: dates as YYYYMMDD, the portfolio an int64; null clears the end date and leaves the portfolio', () => {
    expect(sdCampaignUpdateRequest('100000000001', { name: 'Test display', startDate: '2099-01-05', endDate: '2099-02-01', portfolioId: '600000000001' })).toEqual({
      method: 'PUT', path: '/sd/campaigns', contentType: 'application/json', acceptHeader: 'application/json', answer: 'items',
      body: [{ campaignId: 100000000001, name: 'Test display', startDate: '20990105', endDate: '20990201', portfolioId: 600000000001 }],
    })
    expect(sdCampaignUpdateRequest('100000000001', { endDate: null, portfolioId: null, state: 'archived' }).body).toEqual([{ campaignId: 100000000001, state: 'archived', endDate: null, portfolioId: null }])
    expect(() => sdDay('05/01/2099')).toThrow(/is not a YYYY-MM-DD date, so nothing was sent to Amazon/)
    expect(() => sdCampaignUpdateRequest('100000000001', { portfolioId: 'PF-TEXT' })).toThrow(/cannot be sent as a number/)
  })

  it('an ad group: name, default bid, state; a product ad: its state only', () => {
    expect(sdAdGroupUpdateRequest('200000000001', { name: 'group', defaultBid: 0.35, state: 'paused' })).toEqual({
      method: 'PUT', path: '/sd/adGroups', contentType: 'application/json', acceptHeader: 'application/json', answer: 'items',
      body: [{ adGroupId: 200000000001, name: 'group', defaultBid: 0.35, state: 'paused' }],
    })
    expect(sdProductAdUpdateRequest('500000000001', 'archived')).toEqual({
      method: 'PUT', path: '/sd/productAds', contentType: 'application/json', acceptHeader: 'application/json', answer: 'items',
      body: [{ adId: 500000000001, state: 'archived' }],
    })
  })
})

describe('on the wire, through the gateway', () => {
  it('PUT /sd/adGroups as JSON; Amazon\'s 207 refusal comes back in its own words (code — description)', async () => {
    answer(207, [{ code: 'INVALID_ARGUMENT', description: 'Adgroup name invalid characters', adGroupId: 200000000001 }])
    const r = await sendSbSdUpdate(ctx, sdAdGroupUpdateRequest('200000000001', { name: 'group' }), 'test')
    expect(sent()).toMatchObject({ method: 'PUT', path: '/sd/adGroups', body: [{ adGroupId: 200000000001, name: 'group' }] })
    expect(sent().headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json', 'Amazon-Advertising-API-Scope': '123' })
    expect(r).toMatchObject({ ok: false, mode: 'live', error: 'amazon_rejected: INVALID_ARGUMENT — Adgroup name invalid characters' })
  })

  it('PUT /sd/productAds and PUT /sd/campaigns answered SUCCESS are the change made; each one call logged by the gateway', async () => {
    answer(207, [{ code: 'SUCCESS', adId: 500000000001 }])
    expect((await sendSbSdUpdate(ctx, sdProductAdUpdateRequest('500000000001', 'paused'), 'test')).ok).toBe(true)
    answer(207, [{ code: 'SUCCESS', campaignId: 100000000001 }])
    expect((await sendSbSdUpdate(ctx, sdCampaignUpdateRequest('100000000001', { startDate: '2099-01-05' }), 'test')).ok).toBe(true)
    expect([sent(0).path, sent(1).path]).toEqual(['/sd/productAds', '/sd/campaigns'])
    expect(sent(1).body).toEqual([{ campaignId: 100000000001, startDate: '20990105' }])
    expect(gatewayLedger.length).toBe(2)
  })

  it('sandbox sends nothing', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    expect(await sendSbSdUpdate(ctx, sdAdGroupUpdateRequest('200000000001', { state: 'archived' }), 'test')).toMatchObject({ ok: true, mode: 'sandbox' })
    expect(h.calls).toEqual([])
  })
})
