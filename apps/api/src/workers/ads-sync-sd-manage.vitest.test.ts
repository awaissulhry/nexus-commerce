/**
 * P2b — managing an EXISTING Sponsored Display campaign, from the mutation layer to the Amazon client (the pattern of
 * ads-sync-sbsd.vitest.test.ts).
 *
 *   · A Claude request (`allowSbSd`) changes an SD campaign's name, start and end date and portfolio, an SD ad group's
 *     name, default bid and state, an SD product ad's state, and archives each of them and an SD target; the worker sends
 *     each to SD's own endpoint (PUT /sd/campaigns, /sd/adGroups, /sd/productAds, /sd/targets — archived is the update to
 *     `archived`, never the Sponsored Products delete), and describes it to the gate.
 *   · The stop and its give-back (suppressCampaignBids / restoreCampaignBids with `allowSbSd`) floor and put back an SD
 *     campaign's ad group default bids and target bids on the same endpoints.
 *   · Every other caller stays Sponsored Products only (6a), and a start date goes out for Sponsored Display only.
 *
 * PGlite with the production schema. The gate is a stand-in that records its input and allows (live); the Amazon client
 * is a recorder. Nothing leaves the process. All ids are made up (numeric, as Amazon's are).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
const gate = vi.hoisted(() => ({ seen: [] as GateContext[] }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return { allowed: true, mode: 'live', profileId: 'P-SDM' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ sp: [] as string[], sd: [] as Array<{ method: string; path: string; body: unknown }> }))
vi.mock('../services/advertising/ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-api-client.js')>()
  const sp = (fn: string) => async () => { amazon.sp.push(fn); return { ok: true, rawResponse: {}, error: null } }
  return {
    ...real,
    adsMode: () => 'live',
    updateCampaign: sp('updateCampaign'), updateAdGroup: sp('updateAdGroup'), updateTarget: sp('updateTarget'),
    updateProductAd: sp('updateProductAd'), archiveSpEntity: sp('archiveSpEntity'),
    sendSbSdUpdate: async (_ctx: unknown, request: { method: string; path: string; body?: unknown }) => {
      amazon.sd.push({ method: request.method, path: request.path, body: request.body })
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
  }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { updateCampaignWithSync, updateAdGroupWithSync, updateAdTargetWithSync, updateProductAdWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { suppressCampaignBids, restoreCampaignBids } = await import('../services/advertising/ads-bid-suppression.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const CLAUDE = 'user:sdm-approver' as const
const ENGINE = 'automation:tstrule-sdm' as const
const drain = () => inside(() => drainAdsSyncOnce(50))
const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const campaign = (id: string, ext: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: ext, dailyBudget: '20.00', startDate: day('2026-01-01'), liveBidWritesEnabled: true, costType: 'cpc', ...extra } as never,
    })
    await campaign('m-sd', '100000000501')
    await campaign('m-stop', '100000000502')
    await campaign('m-arch', '100000000503')
    await campaign('m-sp', '100000000504', { type: 'SP', adProduct: 'SPONSORED_PRODUCTS', costType: null })
    for (const [g, c, ext, bid] of [['mg-sd', 'm-sd', '200000000501', 40], ['mg-stop', 'm-stop', '200000000502', 60], ['mg-arch', 'm-arch', '200000000503', 40]] as const) {
      await db.adGroup.create({ data: { id: g, campaignId: c, name: `group ${g}`, externalAdGroupId: ext, defaultBidCents: bid } })
    }
    const target = (id: string, adGroupId: string, ext: string, bidCents: number) => db.adTarget.create({
      data: { id, adGroupId, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: `asin ${id}`, bidCents, externalTargetId: ext },
    })
    await target('mt-sd', 'mg-sd', '300000000501', 40)
    await target('mt-stop', 'mg-stop', '300000000502', 45)
    await target('mt-arch', 'mg-arch', '300000000503', 40)
    await db.adProductAd.create({ data: { id: 'ma-sd', adGroupId: 'mg-sd', sku: 'TEST-SKU-1', asin: 'B0FXTEST01', externalAdId: '500000000501' } })
    await db.adProductAd.create({ data: { id: 'ma-arch', adGroupId: 'mg-arch', sku: 'TEST-SKU-2', asin: 'B0FXTEST02', externalAdId: '500000000502' } })
    await db.amazonAdsConnection.create({ data: { profileId: 'P-SDM', marketplace: 'IT', mode: 'production', isActive: true } as never })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(async () => {
  await drain() // nothing from an earlier test is left due
  gate.seen = []; amazon.sp = []; amazon.sd = []
})

describe('an SD campaign\'s settings', () => {
  it('name, start date, end date and portfolio → one PUT /sd/campaigns, dates as YYYYMMDD and the portfolio an int64; described to the gate', async () => {
    const r = await inside(() => updateCampaignWithSync({
      campaignId: 'm-sd', patch: { name: 'Test display renamed', startDate: day('2099-01-05'), endDate: day('2099-02-01'), portfolioId: '600000000001' },
      actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true,
    }))
    expect(r.ok, r.error ?? '').toBe(true)
    await drain()
    expect(amazon.sd).toEqual([{ method: 'PUT', path: '/sd/campaigns', body: [{ campaignId: 100000000501, name: 'Test display renamed', startDate: '20990105', endDate: '20990201', portfolioId: 600000000001 }] }])
    expect(amazon.sp).toEqual([])
    expect(gate.seen.at(-1)?.write).toMatchObject({ entity: 'CAMPAIGN', fields: expect.arrayContaining(['name', 'startDate', 'endDate', 'portfolioId']) })
    // The audit row records the start date it replaced (undo-ad-change puts it back).
    const log = await inside(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { entityId: 'm-sd' }, orderBy: { createdAt: 'desc' } }))
    expect(log.payloadBefore).toMatchObject({ startDate: '2026-01-01T00:00:00.000Z', name: 'Test m-sd' })
    expect(log.payloadAfter).toMatchObject({ startDate: '2099-01-05T00:00:00.000Z', name: 'Test display renamed' })
  })

  it('no end date and out of its portfolio → null on the wire (Amazon: null leaves the portfolio)', async () => {
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'm-sd', patch: { endDate: null, portfolioId: null }, actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true }))
    expect(r.ok, r.error ?? '').toBe(true)
    await drain()
    expect(amazon.sd).toEqual([{ method: 'PUT', path: '/sd/campaigns', body: [{ campaignId: 100000000501, endDate: null, portfolioId: null }] }])
  })

  it('a start date is refused for a Sponsored Products campaign (its update would send none), and every SD write without allowSbSd stays refused (6a)', async () => {
    const sp = await inside(() => updateCampaignWithSync({ campaignId: 'm-sp', patch: { startDate: day('2099-01-05') }, actor: CLAUDE, allowSbSd: true }))
    expect(sp).toMatchObject({ ok: false, outboundQueueId: null, error: 'Nexus changes the start date of a Sponsored Display campaign only, so nothing was sent to Amazon.' })
    for (const write of [
      () => updateCampaignWithSync({ campaignId: 'm-sd', patch: { name: 'Engine name' }, actor: ENGINE }),
      () => updateAdGroupWithSync({ adGroupId: 'mg-sd', patch: { defaultBidCents: 35 }, actor: ENGINE }),
      () => updateProductAdWithSync({ productAdId: 'ma-sd', status: 'PAUSED', actor: ENGINE }),
    ]) {
      expect(await inside(write)).toMatchObject({ ok: false, outboundQueueId: null, error: expect.stringMatching(/is not a Sponsored Products campaign \(it is Sponsored Display\)/) })
    }
  })
})

describe('an SD ad group and product ad', () => {
  it('ad group name and default bid → PUT /sd/adGroups; a product ad pause → PUT /sd/productAds; never an SP endpoint', async () => {
    const g = await inside(() => updateAdGroupWithSync({ adGroupId: 'mg-sd', patch: { name: 'group renamed', defaultBidCents: 35 }, actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true }))
    expect(g.ok, g.error ?? '').toBe(true)
    const a = await inside(() => updateProductAdWithSync({ productAdId: 'ma-sd', status: 'PAUSED', actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true, letsGo: true }))
    expect(a.ok, a.error ?? '').toBe(true)
    await drain()
    expect(amazon.sd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sd/adGroups', body: [{ adGroupId: 200000000501, name: 'group renamed', defaultBid: 0.35 }] },
      { method: 'PUT', path: '/sd/productAds', body: [{ adId: 500000000501, state: 'paused' }] },
    ]))
    expect(amazon.sp).toEqual([])
    expect(gate.seen.map((s) => s.write)).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'AD_GROUP', fields: expect.arrayContaining(['defaultBid', 'name']) }),
      expect.objectContaining({ entity: 'PRODUCT_AD', fields: ['status'], toStatus: 'PAUSED' }),
    ]))
  })

  it('archive (archive-ads: letsGo) of an SD campaign, ad group, target and product ad → each one\'s update to archived, never the SP delete', async () => {
    const common = { actor: CLAUDE, allowSbSd: true, applyImmediately: true, manual: true, letsGo: true } as const
    expect((await inside(() => updateCampaignWithSync({ campaignId: 'm-arch', patch: { status: 'ARCHIVED' }, ...common }))).ok).toBe(true)
    expect((await inside(() => updateAdGroupWithSync({ adGroupId: 'mg-arch', patch: { status: 'ARCHIVED' }, ...common }))).ok).toBe(true)
    expect((await inside(() => updateAdTargetWithSync({ adTargetId: 'mt-arch', patch: { status: 'ARCHIVED' }, ...common }))).ok).toBe(true)
    expect((await inside(() => updateProductAdWithSync({ productAdId: 'ma-arch', status: 'ARCHIVED', ...common }))).ok).toBe(true)
    await drain()
    expect(amazon.sd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sd/campaigns', body: [{ campaignId: 100000000503, state: 'archived' }] },
      { method: 'PUT', path: '/sd/adGroups', body: [{ adGroupId: 200000000503, state: 'archived' }] },
      { method: 'PUT', path: '/sd/targets', body: [{ targetId: 300000000503, state: 'archived' }] },
      { method: 'PUT', path: '/sd/productAds', body: [{ adId: 500000000502, state: 'archived' }] },
    ]))
    expect(amazon.sd).toHaveLength(4)
    expect(amazon.sp).toEqual([])
  })
})

describe('the no-pause stop of an SD campaign (suppress / restore with allowSbSd)', () => {
  it('floors its ad group default bid and target bid on SD\'s endpoints, remembers them, and puts them back', async () => {
    const floored = await inside(() => suppressCampaignBids('m-stop', { actor: CLAUDE, reason: 'test stop', floorCents: 2, allowSbSd: true }))
    expect(floored).toBe(2)
    await drain()
    expect(amazon.sd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sd/adGroups', body: [{ adGroupId: 200000000502, defaultBid: 0.02 }] },
      { method: 'PUT', path: '/sd/targets', body: [{ targetId: 300000000502, bid: 0.02 }] },
    ]))
    const remembered = await inside(async () => ({
      group: await database.client.adGroup.findUniqueOrThrow({ where: { id: 'mg-stop' }, select: { defaultBidCents: true, suppressedFromBidCents: true } }),
      target: await database.client.adTarget.findUniqueOrThrow({ where: { id: 'mt-stop' }, select: { bidCents: true, suppressedFromBidCents: true } }),
    }))
    expect(remembered).toEqual({ group: { defaultBidCents: 2, suppressedFromBidCents: 60 }, target: { bidCents: 2, suppressedFromBidCents: 45 } })
    amazon.sd = []
    expect(await inside(() => restoreCampaignBids('m-stop', { actor: CLAUDE, reason: 'test restore', manual: true, allowSbSd: true }))).toBe(2)
    await drain()
    expect(amazon.sd).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/sd/adGroups', body: [{ adGroupId: 200000000502, defaultBid: 0.6 }] },
      { method: 'PUT', path: '/sd/targets', body: [{ targetId: 300000000502, bid: 0.45 }] },
    ]))
    const campaign = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'm-stop' }, select: { bidsSuppressedAt: true } }))
    expect(campaign.bidsSuppressedAt).toBeNull()
  })

  it('🔴 an engine\'s stop (no allowSbSd) moves nothing on an SD campaign: every write is refused (6a)', async () => {
    await inside(() => suppressCampaignBids('m-stop', { actor: ENGINE, reason: 'engine stop', floorCents: 2 }))
    await drain()
    expect(amazon.sd).toEqual([])
    const g = await inside(() => database.client.adGroup.findUniqueOrThrow({ where: { id: 'mg-stop' }, select: { defaultBidCents: true } }))
    expect(g.defaultBidCents).toBe(60)
    // Its mark is set (the engine owns that stop); restored by the engine the same way: nothing reaches Amazon.
    await inside(() => restoreCampaignBids('m-stop', { actor: ENGINE }))
  })
})
