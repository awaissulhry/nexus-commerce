/**
 * SD-P1 — the Sponsored Display (and Sponsored Brands) create path says Amazon's own words when Amazon refuses.
 *
 * First live use (2026-10-20): Amazon refused a new SD ad group with HTTP 207 and
 * `[{"code":"INVALID_ARGUMENT","description":" Adgroup name invalid characters"}]`, and the person read "Amazon answered
 * without an id" — `createSdAdGroup` read only the id and dropped the item. Every SD / SB create is sent here through
 * the REAL Ads client (`liveCall`, profiles ON) and the channel gateway with `fetch` stubbed; the answers are the
 * documented 207 shapes (SD 3.0 `AdGroupResponse` / `CampaignResponse` / `ProductAdResponse`, SB 4.0 multi-status).
 * No call leaves this machine; ids and SKUs are made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: unknown }>, answers: [] as unknown[] }))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
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

import { __rateTest } from '../gateway/rate.js'
import { CREATE_NO_ID, createSbAd, createSbAdGroup, createSbCampaign, createSbKeyword, createSdAdGroup, createSdCampaign, createSdProductAd, sdCreateResult } from './ads-api-client.js'

const CTX = { profileId: '123', region: 'EU' as const }
/** The answer Amazon gave the first live SD ad group create (2026-10-20), leading space and all. */
const REFUSED_NAME = [{ code: 'INVALID_ARGUMENT', description: ' Adgroup name invalid characters' }]
/** SB 4.0's 207: `{ <resource>: { success: [], error: [{ index, errors: [{ errorType, errorValue }] }] } }`. */
const sbRefused = (resource: string, message: string) => ({
  [resource]: { success: [], error: [{ index: 0, errors: [{ errorType: 'invalidArgument', errorValue: { invalidArgumentError: { message } } }] }] },
})

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off'); vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), body: init.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(h.answers.shift() ?? []), { status: 207 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('SD creates: Amazon\'s code and description reach the caller', () => {
  it('the ad group refused for its name says so, in Amazon\'s words (it said "answered without an id")', async () => {
    h.answers.push(REFUSED_NAME)
    const r = await createSdAdGroup(CTX, { externalCampaignId: '100000000000001', name: 'Display IT - ad group', defaultBid: 0.5, state: 'enabled' })
    expect(r).toMatchObject({ ok: false, mode: 'live', externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Adgroup name invalid characters' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toMatch(/\/sd\/adGroups$/)
    // the request Amazon got: no tactic, bidOptimization for a cpc campaign
    expect(h.calls[0].body).toEqual([{ campaignId: 100000000000001, name: 'Display IT - ad group', defaultBid: 0.5, state: 'enabled', bidOptimization: 'conversions', creativeType: 'IMAGE' }])
  })

  it('an ad group Amazon made comes back with its id and no error', async () => {
    h.answers.push([{ code: 'SUCCESS', adGroupId: 200000000000001 }])
    const r = await createSdAdGroup(CTX, { externalCampaignId: '100000000000001', name: 'Display IT - ad group', defaultBid: 0.5, costType: 'vcpm' })
    expect(r).toMatchObject({ ok: true, externalId: '200000000000001', error: null })
    expect((h.calls[0].body as Array<Record<string, unknown>>)[0].bidOptimization).toBe('reach')
  })

  it('the campaign, the product ad: each refusal in Amazon\'s words', async () => {
    h.answers.push([{ code: 'INVALID_ARGUMENT', description: 'Budget is below the minimum' }])
    const camp = await createSdCampaign(CTX, { name: 'Display IT', dailyBudget: 0.5 })
    expect(camp).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Budget is below the minimum' })

    h.answers.push([{ code: 'INVALID_ARGUMENT', description: 'SKU is not eligible for advertising' }])
    const ad = await createSdProductAd(CTX, { externalCampaignId: '100000000000001', externalAdGroupId: '200000000000001', sku: 'TEST-SKU-1', state: 'enabled' })
    expect(ad).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — SKU is not eligible for advertising' })
    // a seller's product ad names its SKU and nothing else
    expect(h.calls[1].body).toEqual([{ campaignId: 100000000000001, adGroupId: 200000000000001, sku: 'TEST-SKU-1', state: 'enabled' }])
  })

  it('an answer with neither an id nor an error is still not a create', async () => {
    h.answers.push([])
    const r = await createSdAdGroup(CTX, { externalCampaignId: '1', name: 'x', defaultBid: 1 })
    expect(r).toMatchObject({ ok: false, externalId: null, error: CREATE_NO_ID })
  })

  it('sdCreateResult trims Amazon\'s stray spaces and keeps the code', () => {
    expect(sdCreateResult(REFUSED_NAME, 'adGroupId')).toEqual({ externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Adgroup name invalid characters' })
    expect(sdCreateResult([{ code: 'SUCCESS', adId: 7 }], 'adId')).toEqual({ externalId: '7', error: null })
  })
})

describe('SB creates of the same shape: Amazon\'s words too', () => {
  it('the v4 ad group, campaign and ad read their 207 error item', async () => {
    h.answers.push(sbRefused('adGroups', 'Ad group name is invalid'))
    expect(await createSbAdGroup(CTX, { externalCampaignId: '1', name: 'x' })).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: Ad group name is invalid' })

    h.answers.push(sbRefused('campaigns', 'Brand entity is not eligible'))
    expect(await createSbCampaign(CTX, { name: 'x', dailyBudget: 5, brandEntityId: 'BRAND-TEST' })).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: Brand entity is not eligible' })

    h.answers.push(sbRefused('ads', 'Logo is not approved'))
    const ad = await createSbAd(CTX, { externalCampaignId: '1', externalAdGroupId: '2', brandName: 'Acme', headline: 'Ride on', creativeType: 'productCollection', landingType: 'productList', asins: ['B0FXTEST01'] })
    expect(ad).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: Logo is not approved' })
  })

  it('the legacy SB keyword reads its bare-array item', async () => {
    h.answers.push([{ code: 'INVALID_ARGUMENT', description: 'Keyword text is too long' }])
    const r = await createSbKeyword(CTX, { externalCampaignId: '1', externalAdGroupId: '2', keywordText: 'k', matchType: 'EXACT', bid: 1 })
    expect(r).toMatchObject({ ok: false, externalId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Keyword text is too long' })
  })
})
