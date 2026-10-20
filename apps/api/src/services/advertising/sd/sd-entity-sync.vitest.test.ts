/**
 * SD-AUD — the Sponsored Display sync, run for real on PGlite (production schema and policies) with Amazon stood in by
 * the SD 3.0 openapi's own response shapes (CampaignResponseEx, AdGroupResponseEx, ProductAdResponseEx,
 * TargetingClauseEx, NegativeTargetingClauseEx). Nothing leaves this machine: liveCall is a stub that records each
 * request. Fake ids, names and amounts only.
 *
 * Proven: the requests (every resource, all states, the held SD campaigns only, paged by 100); every SD setting lands
 * on the row Nexus has (tactic, cost type, budget, dates, state, serving status, portfolio; default bid, bid
 * optimization, creative type; landing page, SKU/ASIN only where empty; expression, resolved expression, bid; negative
 * expressions); an undelivered write is never overwritten; leaving a portfolio opens a drift row first; an archived
 * campaign is read only while its tactic or cost type is empty; nothing is created; sandbox asks nothing; and the v1
 * export no longer blanks a cost type it did not carry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
const amazon = vi.hoisted(() => ({
  mode: 'live' as 'live' | 'sandbox', calls: [] as Array<{ method: string; path: string }>, answers: {} as Record<string, unknown[]>, refuse: {} as Record<string, Error>,
}))
vi.mock('../ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => amazon.mode,
  liveCall: async (opts: { method: string; path: string }) => {
    amazon.calls.push({ method: opts.method, path: opts.path })
    const resource = /^\/sd\/(\w+)\/extended/.exec(opts.path)?.[1] ?? ''
    if (amazon.refuse[resource]) throw amazon.refuse[resource]
    const start = Number(/startIndex=(\d+)/.exec(opts.path)?.[1] ?? 0)
    return (amazon.answers[resource] ?? []).slice(start, start + 100)
  },
}))

import { syncSdEntitiesFromAmazon } from './sd-entity-sync.service.js'
import { listSdTargetsEx } from './sd-entities.client.js'
import { ingestCampaigns } from '../ads-v1-sync.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client

const VIEWS = [{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]
const ANSWERS = {
  campaigns: [
    { campaignId: 100000000001, name: 'Test display', tactic: 'T00030', budgetType: 'daily', budget: 12.5, startDate: '20261001', state: 'paused', portfolioId: null, servingStatus: 'CAMPAIGN_PAUSED', costType: 'cpc' },
    { campaignId: 100000000002, name: 'Test display old', tactic: 'T00020', budgetType: 'daily', budget: 5, startDate: '20260101', endDate: '20260301', state: 'archived', servingStatus: 'CAMPAIGN_ARCHIVED', costType: 'vcpm' },
    { campaignId: 100000000999, name: 'Made in the console', tactic: 'T00020', state: 'enabled', costType: 'cpc' },
  ],
  adGroups: [{ adGroupId: 200000000001, campaignId: 100000000001, name: 'Test group', defaultBid: 0.85, state: 'enabled', tactic: 'T00030', creativeType: 'IMAGE', bidOptimization: 'conversions', servingStatus: 'AD_GROUP_STATUS_ENABLED' }],
  productAds: [{ adId: 300000000001, adGroupId: 200000000001, campaignId: 100000000001, sku: 'SKU-TEST-1', asin: 'B0FX000001', state: 'enabled', servingStatus: 'AD_STATUS_LIVE' }],
  targets: [
    { targetId: 400000000001, adGroupId: 200000000001, campaignId: 100000000001, state: 'enabled', expressionType: 'manual', bid: 1.1, expression: VIEWS, resolvedExpression: VIEWS, servingStatus: 'TARGET_STATUS_LIVE' },
    { targetId: 400000000002, adGroupId: 200000000001, campaignId: 100000000001, state: 'paused', expressionType: 'manual', bid: 0.9, expression: [{ type: 'asinSameAs', value: 'B0FX000002' }], servingStatus: 'TARGET_STATUS_PAUSED' },
    { targetId: 400000000003, adGroupId: 200000000001, campaignId: 100000000001, state: 'enabled', expressionType: 'manual', expression: [{ type: 'similarProduct' }] },
  ],
  negativeTargets: [{ targetId: 500000000001, adGroupId: 200000000001, state: 'enabled', expressionType: 'manual', expression: [{ type: 'asinBrandSameAs', value: '9' }], servingStatus: 'TARGET_STATUS_LIVE' }],
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    await c.amazonAdsConnection.create({ data: { profileId: 'P-IT-TEST', marketplace: 'IT', region: 'EU', mode: 'production', isActive: true } })
    const campaign = (id: string, ext: string, extra: Record<string, unknown>) => c.campaign.create({
      data: { id, name: `name ${id}`, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: ext, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), ...extra } as never,
    })
    await campaign('c-sd', '100000000001', { portfolioId: 'PF-TEST-1' })
    await campaign('c-sd-old', '100000000002', { status: 'ARCHIVED' })
    await campaign('c-sd-done', '100000000003', { status: 'ARCHIVED', tactic: 'T00020', costType: 'cpc' })
    await c.campaign.create({ data: { id: 'c-sp', name: 'Test products', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: '100000000777', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await c.adGroup.create({ data: { id: 'g-sd', campaignId: 'c-sd', name: 'group', externalAdGroupId: '200000000001' } })
    await c.adProductAd.create({ data: { id: 'pa-sd', adGroupId: 'g-sd', sku: 'SKU-TEST-1', externalAdId: '300000000001' } })
    const target = (id: string, ext: string, kind: string, extra: Record<string, unknown> = {}) => c.adTarget.create({
      data: { id, adGroupId: 'g-sd', kind, expressionType: 'UNKNOWN', expressionValue: '', bidCents: 0, externalTargetId: ext, ...extra },
    })
    await target('t-aud', '400000000001', 'AUDIENCE')
    await target('t-pt', '400000000002', 'PRODUCT', { bidCents: 30, expressionValue: 'B0FX000002' })
    await target('t-sim', '400000000003', 'PRODUCT', { bidCents: 40 })
    await target('n-brand', '500000000001', 'PRODUCT', { isNegative: true, negativeLevel: 'AD_GROUP' })
    // A bid for t-pt Nexus queued and has not sent: Amazon still reports the old one.
    await c.adMutation.create({ data: { entityType: 'AD_TARGET', entityId: 't-pt', field: 'bid', previousValue: '30', intendedValue: '35', state: 'PENDING', actor: 'user:test' } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { amazon.mode = 'live'; amazon.calls = []; amazon.answers = ANSWERS; amazon.refuse = {} })

describe('syncSdEntitiesFromAmazon', () => {
  it('reads every SD resource of the held campaigns, all states, paged by 100; an archived campaign only for its missing settings', async () => {
    const r = await inside(() => syncSdEntitiesFromAmazon())
    expect(r.errors).toEqual([])
    const paths = amazon.calls.map((c) => `${c.method} ${decodeURIComponent(c.path)}`)
    expect(paths).toEqual([
      'GET /sd/campaigns/extended?campaignIdFilter=100000000001,100000000002&stateFilter=enabled,paused,archived&startIndex=0&count=100',
      'GET /sd/adGroups/extended?campaignIdFilter=100000000001&stateFilter=enabled,paused,archived&startIndex=0&count=100',
      'GET /sd/productAds/extended?campaignIdFilter=100000000001&stateFilter=enabled,paused,archived&startIndex=0&count=100',
      'GET /sd/targets/extended?campaignIdFilter=100000000001&stateFilter=enabled,paused,archived&startIndex=0&count=100',
      'GET /sd/negativeTargets/extended?campaignIdFilter=100000000001&stateFilter=enabled,paused,archived&startIndex=0&count=100',
    ])
    expect(r).toMatchObject({
      profiles: 1,
      campaigns: { read: 3, updated: 2, notInNexus: 1 },
      adGroups: { read: 1, updated: 1, notInNexus: 0 },
      productAds: { read: 1, updated: 1, notInNexus: 0 },
      targets: { read: 3, updated: 3, notInNexus: 0 },
      negativeTargets: { read: 1, updated: 1, notInNexus: 0 },
      held: 1,
      raced: 0,
    })
  })

  it('every SD setting is on the rows Nexus has; nothing is created; a Sponsored Products campaign is untouched', async () => {
    const c = await inside(() => db().campaign.findMany({ where: { id: { in: ['c-sd', 'c-sd-old', 'c-sp'] } }, orderBy: { id: 'asc' } }))
    const byId = Object.fromEntries(c.map((x) => [x.id, x]))
    expect(byId['c-sd']).toMatchObject({ name: 'Test display', tactic: 'T00030', costType: 'cpc', status: 'PAUSED', servingStatus: 'CAMPAIGN_PAUSED', portfolioId: null, endDate: null })
    expect(Number(byId['c-sd'].dailyBudget)).toBe(12.5)
    expect(byId['c-sd'].startDate.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(byId['c-sd'].settingsSyncedAt).not.toBeNull()
    expect(byId['c-sd-old']).toMatchObject({ tactic: 'T00020', costType: 'vcpm', status: 'ARCHIVED', servingStatus: 'CAMPAIGN_ARCHIVED' })
    expect(byId['c-sd-old'].endDate?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(byId['c-sp']).toMatchObject({ tactic: null, costType: null, servingStatus: null })
    expect(await inside(() => db().campaign.count({ where: { externalCampaignId: '100000000999' } }))).toBe(0)

    const g = await inside(() => db().adGroup.findUniqueOrThrow({ where: { id: 'g-sd' } }))
    expect(g).toMatchObject({ name: 'Test group', defaultBidCents: 85, bidOptimization: 'conversions', creativeType: 'IMAGE', status: 'ENABLED', servingStatus: 'AD_GROUP_STATUS_ENABLED' })
    const ad = await inside(() => db().adProductAd.findUniqueOrThrow({ where: { id: 'pa-sd' } }))
    expect(ad).toMatchObject({ sku: 'SKU-TEST-1', asin: 'B0FX000001', status: 'ENABLED', servingStatus: 'AD_STATUS_LIVE', landingPageType: null, landingPageUrl: null, adName: null })

    const t = Object.fromEntries((await inside(() => db().adTarget.findMany({ where: { adGroupId: 'g-sd' } }))).map((x) => [x.id, x]))
    expect(t['t-aud']).toMatchObject({ expressionJson: VIEWS, resolvedExpressionJson: VIEWS, bidCents: 110, status: 'ENABLED', servingStatus: 'TARGET_STATUS_LIVE' })
    // The queued bid is held back; the rest of the row follows Amazon.
    expect(t['t-pt']).toMatchObject({ bidCents: 30, status: 'PAUSED', expressionJson: [{ type: 'asinSameAs', value: 'B0FX000002' }] })
    // No bid of its own: it serves at the ad group's default bid, and Nexus's copy is left.
    expect(t['t-sim']).toMatchObject({ bidCents: 40, expressionJson: [{ type: 'similarProduct' }] })
    expect(t['n-brand']).toMatchObject({ isNegative: true, expressionJson: [{ type: 'asinBrandSameAs', value: '9' }], status: 'ENABLED', servingStatus: 'TARGET_STATUS_LIVE' })
  })

  it('a campaign leaving its portfolio at Amazon opens a drift row before Nexus follows it', async () => {
    const drift = await inside(() => db().adDrift.findMany({ where: { entityType: 'CAMPAIGN', entityId: 'c-sd', field: 'portfolioId' } }))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ ourValue: 'PF-TEST-1', amazonValue: null, resolvedAt: null })
  })

  it('once an archived campaign has its settings, it is not read again; a profile with no SD campaign asks nothing', async () => {
    await inside(() => syncSdEntitiesFromAmazon())
    expect(decodeURIComponent(amazon.calls[0].path)).toContain('campaignIdFilter=100000000001&')
    amazon.calls = []
    await inside(() => db().amazonAdsConnection.create({ data: { profileId: 'P-DE-TEST', marketplace: 'DE', region: 'EU', mode: 'production', isActive: true } }))
    const r = await inside(() => syncSdEntitiesFromAmazon({ profileId: 'P-DE-TEST' }))
    expect(r.profiles).toBe(0)
    expect(amazon.calls).toEqual([])
  })

  it("Amazon's refusal of one resource is reported with its text; the others still sync", async () => {
    amazon.refuse = { adGroups: Object.assign(new Error('[ADS-LIVE] GET /sd/adGroups/extended → 400: {"code":"INVALID_ARGUMENT","details":"bad filter"}'), { statusCode: 400 }) }
    const r = await inside(() => syncSdEntitiesFromAmazon())
    expect(r.errors).toEqual(['adGroups IT: [ADS-LIVE] GET /sd/adGroups/extended → 400: {"code":"INVALID_ARGUMENT","details":"bad filter"}'])
    expect(amazon.calls.map((c) => c.path.split('?')[0])).toEqual(['/sd/campaigns/extended', '/sd/adGroups/extended', '/sd/productAds/extended', '/sd/targets/extended', '/sd/negativeTargets/extended'])
    expect(r.productAds.read).toBe(1)
  })

  it('sandbox: Amazon is not asked', async () => {
    amazon.mode = 'sandbox'
    const r = await inside(() => syncSdEntitiesFromAmazon())
    expect(amazon.calls).toEqual([])
    expect(r.campaigns.read).toBe(0)
  })
})

describe('listSdTargetsEx — paging', () => {
  it('asks for the next 100 while a page is full', async () => {
    amazon.answers = { targets: Array.from({ length: 103 }, (_, i) => ({ targetId: 600000000000 + i, state: 'enabled' })) }
    const rows = await inside(() => listSdTargetsEx({ profileId: 'P-IT-TEST', region: 'EU' }, ['100000000001']))
    expect(rows).toHaveLength(103)
    expect(amazon.calls.map((c) => /startIndex=(\d+)/.exec(c.path)?.[1])).toEqual(['0', '100'])
  })
})

describe('the v1 export and the SD cost type', () => {
  it('a campaigns record without costType keeps the one the SD sync read; one with it still writes it', async () => {
    const record = (costType?: string) => ({ campaignId: '100000000001', adProduct: 'SPONSORED_DISPLAY' as const, name: 'Test display', state: 'PAUSED' as const, startDate: '2026-10-01', ...(costType ? { costType } : {}) })
    await inside(() => ingestCampaigns('P-IT-TEST', [record()]))
    expect((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-sd' } }))).costType).toBe('cpc')
    await inside(() => ingestCampaigns('P-IT-TEST', [record('vcpm')]))
    expect((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-sd' } }))).costType).toBe('vcpm')
  })
})
