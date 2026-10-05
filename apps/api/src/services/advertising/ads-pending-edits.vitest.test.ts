/**
 * Campaign manager 1f (API) — an operator's edit reaches Amazon and stays on screen until it does.
 *
 * CM-15: an ad-group rename was a local update in the route — never sent to Amazon, no audit row, and the v1 ingest
 *        wrote Amazon's name back. It is now queued and logged like the status and the default bid.
 * CM-16: only the 20-minute settings sync held back fields with an undelivered write. The keyword/target list sync
 *        and the v1 export ingest wrote Amazon's older value over a queued edit. They now hold back too.
 * CM-28: cancelling a staged write left Nexus showing the cancelled value (written when it was queued). Cancel now
 *        puts each field back, unless something newer has replaced it.
 *
 * Real mutation service → real ads worker → real write gate in LIVE mode, real syncs, on PGlite (production schema)
 * with the shared ads fixture. Amazon is a recorder and a stub list; nothing leaves the process. Fake ids only.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Amazon: a recorder for writes, and stub v3 lists for the keyword/target sync.
const amazon = vi.hoisted(() => ({
  calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }>,
  lists: {} as Record<string, unknown[]>,
}))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  const LIST_KEY: Record<string, string> = { '/sp/keywords/list': 'keywords', '/sp/negativeKeywords/list': 'negativeKeywords', '/sp/targets/list': 'targetingClauses' }
  return {
    ...(await importOriginal<object>()),
    adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record,
    liveCall: async (opts: { path: string }) => ({ [LIST_KEY[opts.path] ?? 'none']: amazon.lists[opts.path] ?? [] }),
  }
})
vi.mock('./ads-profile-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsProfileFor: async (marketplace: string) => ({
    profileId: `P-${marketplace}-TEST`, region: 'EU', connectionId: null, mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'),
    lastWriteAt: null, marketplace, source: 'row',
  }),
  recordWriteForMarket: async () => undefined,
}))
vi.mock('./ads-automation-state.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async () => 0,
}))

const { updateAdTargetWithSync, updateAdGroupWithSync, updateCampaignWithSync, updateProductAdWithSync, cancelPendingMutation } = await import('./ads-mutation.service.js')
const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')
const { syncKeywordsForAdGroups, syncTargetsForAdGroups, upsertCampaignNegativeRows } = await import('./ads-keyword-list-sync.service.js')
const { ingestCampaigns, ingestAdGroups, ingestTargets, ingestAds } = await import('./ads-v1-sync.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const PERSON = 'user:pending-edits-test' as const
let app: FastifyInstance

const target = (id: string) => inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true, status: true } }))
const group = (id: string) => inside(() => db().adGroup.findUniqueOrThrow({ where: { id }, select: { name: true, status: true, defaultBidCents: true } }))
const campaign = (id: string) => inside(() => db().campaign.findUniqueOrThrow({ where: { id }, select: { name: true, dailyBudget: true, status: true, portfolioId: true } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await db().adProductAd.create({ data: { id: 'ad-1', adGroupId: 'g-c-it', externalAdId: 'EXT-ad-1', asin: 'ASIN-TEST-1', status: 'ENABLED' } })
    await db().adTarget.create({ data: {
      id: 't-cneg', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'cheap', bidCents: 0,
      isNegative: true, negativeLevel: 'CAMPAIGN', externalTargetId: 'EXT-t-cneg',
    } })
  })
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)
beforeEach(() => { amazon.calls = []; amazon.lists = {} })

describe('CM-15 — an ad-group rename reaches Amazon', () => {
  it('the Edit Groups PATCH queues the rename with an audit row, and the worker sends it', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/advertising/ad-groups/g-c-it', payload: { name: '  Italy exact — renamed  ', applyImmediately: true } })
    expect(res.statusCode).toBe(200)
    const out = res.json() as { ok: boolean; outboundQueueId: string | null; actionLogId: string | null; error: string | null }
    expect(out).toMatchObject({ ok: true, error: null })
    expect(out.outboundQueueId).toBeTruthy()
    expect(out.actionLogId).toBeTruthy()
    expect((await group('g-c-it')).name).toBe('Italy exact — renamed')

    const mutation = await inside(() => db().adMutation.findFirstOrThrow({ where: { outboundQueueId: out.outboundQueueId } }))
    expect(mutation).toMatchObject({ entityType: 'AD_GROUP', entityId: 'g-c-it', field: 'name', previousValue: 'group c-it', intendedValue: 'Italy exact — renamed' })
    const log = await inside(() => db().advertisingActionLog.findUniqueOrThrow({ where: { id: out.actionLogId } }))
    expect(log).toMatchObject({ entityType: 'AD_GROUP', entityId: 'g-c-it', payloadBefore: { name: 'group c-it' }, payloadAfter: { name: 'Italy exact — renamed' } })

    await inside(() => drainAdsSyncOnce(50))
    expect(amazon.calls).toEqual([{ externalId: 'EXT-g-c-it', patch: { name: 'Italy exact — renamed' } }])
    const queue = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: out.outboundQueueId }, select: { syncStatus: true } }))
    expect(queue.syncStatus).toBe('SUCCESS')
  })

  it('an unchanged name writes nothing', async () => {
    const r = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-it', patch: { name: 'Italy exact — renamed' }, actor: PERSON }))
    expect(r).toMatchObject({ ok: true, outboundQueueId: null, error: 'no_changes' })
  })
})

describe('CM-16 — the keyword/target list sync holds back a queued edit', () => {
  it('keywords: a queued bid stays; a value nobody is changing still follows Amazon', async () => {
    const q = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 70 }, actor: PERSON }))
    expect(q.outboundQueueId).toBeTruthy()
    // Amazon still reports the old 45¢ for t-it (the write has not landed) and a new 9¢ for t-low.
    amazon.lists['/sp/keywords/list'] = [
      { keywordId: 'EXT-t-it', adGroupId: 'EXT-g-c-it', keywordText: 'race jacket', matchType: 'EXACT', bid: 0.45, state: 'ENABLED' },
      { keywordId: 'EXT-t-sup', adGroupId: 'EXT-g-c-it', keywordText: 'leather gloves', matchType: 'EXACT', bid: 0.02, state: 'ENABLED' },
      { keywordId: 'EXT-t-low', adGroupId: 'EXT-g-c-it', keywordText: 'cheap boots', matchType: 'EXACT', bid: 0.09, state: 'ENABLED' },
    ]
    amazon.lists['/sp/negativeKeywords/list'] = [
      { keywordId: 'EXT-t-neg', adGroupId: 'EXT-g-c-it', keywordText: 'free', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
    ]
    await inside(() => syncKeywordsForAdGroups({ profileId: 'P-IT-TEST', region: 'EU', externalAdGroupIds: ['EXT-g-c-it'] }))
    expect((await target('t-it')).bidCents).toBe(70)
    expect((await target('t-low')).bidCents).toBe(9)
  })

  it('targeting clauses: the same', async () => {
    amazon.lists['/sp/targets/list'] = [
      { targetId: 'EXT-t-it', adGroupId: 'EXT-g-c-it', bid: 0.45, state: 'ENABLED' },
      { targetId: 'EXT-t-low', adGroupId: 'EXT-g-c-it', bid: 0.11, state: 'ENABLED' },
    ]
    await inside(() => syncTargetsForAdGroups({ profileId: 'P-IT-TEST', region: 'EU', externalAdGroupIds: ['EXT-g-c-it'] }))
    expect((await target('t-it')).bidCents).toBe(70)
    expect((await target('t-low')).bidCents).toBe(11)
  })

  it('campaign negatives: a queued state change stays', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-cneg', patch: { status: 'PAUSED' }, actor: PERSON }))
    await inside(() => upsertCampaignNegativeRows([{ campaignNegativeKeywordId: 'EXT-t-cneg', campaignId: 'EXT-c-it', keywordText: 'cheap', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }]))
    expect((await target('t-cneg')).status).toBe('PAUSED')
  })
})

describe('CM-16 — the v1 export ingest holds back a queued edit', () => {
  it('campaigns: a queued rename stays; Amazon\'s new budget is taken', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'c-pin', patch: { name: 'Pinned renamed' }, actor: PERSON }))
    await inside(() => ingestCampaigns('P-IT-TEST', [{
      campaignId: 'EXT-c-pin', adProduct: 'SPONSORED_PRODUCTS', name: 'Italy pinned', state: 'ENABLED', startDate: '2026-01-01',
      budgetCaps: { budgetValue: { monetaryBudget: { amount: 25 } } },
    }] as never))
    const c = await campaign('c-pin')
    expect(c.name).toBe('Pinned renamed')
    expect(Number(c.dailyBudget)).toBe(25)
  })

  it('ad groups: a queued rename stays; Amazon\'s state is taken', async () => {
    await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-off', patch: { name: 'Off group renamed' }, actor: PERSON }))
    await inside(() => ingestAdGroups('P-IT-TEST', [{ adGroupId: 'EXT-g-c-off', campaignId: 'EXT-c-off', adProduct: 'SPONSORED_PRODUCTS', name: 'group c-off', state: 'PAUSED' }] as never))
    const g = await group('g-c-off')
    expect(g.name).toBe('Off group renamed')
    expect(g.status).toBe('PAUSED')
  })

  it('targets: a queued bid stays; Amazon\'s state is taken', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 't-uk', patch: { bidCents: 65 }, actor: PERSON }))
    await inside(() => ingestTargets([{
      targetId: 'EXT-t-uk', campaignId: 'EXT-c-uk', adGroupId: 'EXT-g-c-uk', adProduct: 'SPONSORED_PRODUCTS', state: 'PAUSED', negative: false,
      targetType: 'KEYWORD', targetLevel: 'AD_GROUP', targetDetails: { keyword: 'motorbike boots', matchType: 'EXACT' }, bid: 0.6,
    }] as never))
    expect(await target('t-uk')).toEqual({ bidCents: 65, status: 'PAUSED' })
  })

  it('product ads: a queued state change stays', async () => {
    await inside(() => updateProductAdWithSync({ productAdId: 'ad-1', status: 'PAUSED', actor: PERSON }))
    await inside(() => ingestAds('P-IT-TEST', [{
      adId: 'EXT-ad-1', adGroupId: 'EXT-g-c-it', campaignId: 'EXT-c-it', adProduct: 'SPONSORED_PRODUCTS', state: 'ENABLED', adType: 'PRODUCT_AD',
      creative: { products: [{ productIdType: 'ASIN', productId: 'ASIN-TEST-1' }] },
    }] as never))
    const ad = await inside(() => db().adProductAd.findUniqueOrThrow({ where: { id: 'ad-1' }, select: { status: true } }))
    expect(ad.status).toBe('PAUSED')
  })
})

describe('CM-28 — cancelling a staged write puts the old value back', () => {
  it('an ad-group default bid: back to the old value, the write released, nothing sent', async () => {
    const before = (await group('g-c-uk')).defaultBidCents
    const q = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-uk', patch: { defaultBidCents: before + 7 }, actor: PERSON }))
    expect((await group('g-c-uk')).defaultBidCents).toBe(before + 7)
    const r = await inside(() => cancelPendingMutation(q.outboundQueueId!))
    expect(r).toEqual({ ok: true, error: null, restored: ['defaultBid'], kept: [] })
    expect((await group('g-c-uk')).defaultBidCents).toBe(before)
    const states = await inside(() => db().adMutation.findMany({ where: { outboundQueueId: q.outboundQueueId }, select: { state: true } }))
    expect(states).toEqual([{ state: 'CANCELLED' }])
    const queue = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: q.outboundQueueId! }, select: { syncStatus: true } }))
    expect(queue.syncStatus).toBe('CANCELLED')
  })

  it('a campaign moved to a portfolio: back out of it', async () => {
    const q = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { portfolioId: '1001' }, actor: PERSON }))
    expect((await campaign('c-it')).portfolioId).toBe('1001')
    const r = await inside(() => cancelPendingMutation(q.outboundQueueId!))
    expect(r).toMatchObject({ ok: true, restored: ['portfolioId'] })
    expect((await campaign('c-it')).portfolioId).toBeNull()
  })

  it('a newer value is never overwritten', async () => {
    const q = await inside(() => updateCampaignWithSync({ campaignId: 'c-uk', patch: { dailyBudget: 16 }, actor: PERSON }))
    await inside(() => db().campaign.update({ where: { id: 'c-uk' }, data: { dailyBudget: '17.00' } }))
    const r = await inside(() => cancelPendingMutation(q.outboundQueueId!))
    expect(r).toMatchObject({ ok: true, restored: [], kept: ['dailyBudget'] })
    expect(Number((await campaign('c-uk')).dailyBudget)).toBe(17)
  })

  it('a write past its grace window is not cancelled (and nothing is put back)', async () => {
    const q = await inside(() => updateAdTargetWithSync({ adTargetId: 't-off', patch: { bidCents: 31 }, actor: PERSON, applyImmediately: true }))
    const r = await inside(() => cancelPendingMutation(q.outboundQueueId!))
    expect(r).toEqual({ ok: false, error: 'grace_expired' })
    expect((await target('t-off')).bidCents).toBe(31)
  })
})
