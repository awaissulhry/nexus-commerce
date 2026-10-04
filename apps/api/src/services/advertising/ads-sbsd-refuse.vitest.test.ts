/**
 * 6a — Sponsored Brands and Display writes are refused before Nexus or Amazon changes (Owner decision S8; review G.1).
 *
 * Every update path sends to a Sponsored Products endpoint, where an SB/SD id is unknown: a budget lands nowhere, and an
 * SB keyword sent to /sp/keywords comes back "not found" and is marked orphaned although it is healthy. Pinned here, on
 * the fixture's SB campaign `c-sb` (target t-sb): each path refuses with the shared sentence and changes nothing — no
 * local row, no queue row, no audit row, no Amazon call — while the same path on the SP campaign `c-it` still works.
 *
 * Sandbox mode throughout, on purpose: the refusal comes BEFORE the sandbox return, so sandbox proves it too.
 * On a real PostgreSQL (PGlite, production schema); the queue and the Amazon client are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { adProductRefusal } from '@nexus/shared/ads-ad-product'

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
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// Same reason as no-automated-pause: PGlite's single connection, and an ads row names no listing account.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
const amz = vi.hoisted(() => ({
  updateCampaign: vi.fn(async () => ({ ok: true, mode: 'sandbox' })),
  createNegativeKeyword: vi.fn(async () => ({ ok: true, mode: 'sandbox', externalId: 'EXT-NEG', rawResponse: null })),
  createNegativeProductTarget: vi.fn(async () => ({ ok: true, mode: 'sandbox', externalId: 'EXT-NPT', rawResponse: null })),
  liveCall: vi.fn(async () => ({})),
}))
vi.mock('./ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => 'sandbox',
  updateCampaign: amz.updateCampaign,
  createNegativeKeyword: amz.createNegativeKeyword,
  createNegativeProductTarget: amz.createNegativeProductTarget,
  liveCall: amz.liveCall,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PERSON = 'user:sbsd-test' as const
const RULE = 'automation:tstrule-sbsd' as const
const SENTENCE = adProductRefusal({ name: 'Italy brands', adProduct: 'SPONSORED_BRANDS' })!

/** Everything a write leaves behind: queue rows, audit rows, history rows. A refusal moves none of them. */
const trail = () => inside(async () => ({
  queue: await database.client.outboundSyncQueue.count(),
  log: await database.client.advertisingActionLog.count(),
  history: await database.client.campaignBidHistory.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.adProductAd.create({ data: { id: 'pa-sb', adGroupId: 'g-c-sb', asin: 'B0SBTEST01', externalAdId: 'EXT-pa-sb' } })
    await database.client.adProductAd.create({ data: { id: 'pa-it', adGroupId: 'g-c-it', asin: 'B0SPTEST01', sku: 'SP-1', externalAdId: 'EXT-pa-it' } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { vi.clearAllMocks() })

describe('the mutation layer refuses SB/SD before the local write', () => {
  it('a campaign budget: refused with the sentence, the row and the trail untouched; the SP campaign still changes', async () => {
    const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
    const before = await trail()
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-sb', patch: { dailyBudget: 30 }, actor: PERSON }))
    expect(r).toEqual({ ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: SENTENCE })
    const row = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'c-sb' }, select: { dailyBudget: true } }))
    expect(Number(row.dailyBudget)).toBe(20)
    expect(await trail()).toEqual(before)

    const sp = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 22 }, actor: PERSON }))
    expect(sp).toMatchObject({ ok: true, error: null })
    expect(sp.outboundQueueId).toBeTruthy()
  })

  it('an ad group default bid', async () => {
    const { updateAdGroupWithSync } = await import('./ads-mutation.service.js')
    const before = await trail()
    const r = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-sb', patch: { defaultBidCents: 80 }, actor: RULE }))
    expect(r).toMatchObject({ ok: false, error: SENTENCE, outboundQueueId: null })
    const g = await inside(() => database.client.adGroup.findUniqueOrThrow({ where: { id: 'g-c-sb' }, select: { defaultBidCents: true } }))
    expect(g.defaultBidCents).not.toBe(80)
    expect(await trail()).toEqual(before)
  })

  it('a keyword bid — nothing queued, so nothing can come back "not found" and mark a healthy keyword orphaned', async () => {
    const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
    const before = await trail()
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-sb', patch: { bidCents: 55 }, actor: RULE }))
    expect(r).toMatchObject({ ok: false, error: SENTENCE, outboundQueueId: null })
    const t = await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id: 't-sb' }, select: { bidCents: true, orphanedAt: true } }))
    expect(t).toEqual({ bidCents: 40, orphanedAt: null })
    expect(await trail()).toEqual(before)
  })

  it('a forced bid (suppression) is refused too — its bid would land on /sp/keywords all the same', async () => {
    const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-sb', patch: { bidCents: 2 }, actor: RULE, force: true }))
    expect(r).toMatchObject({ ok: false, error: SENTENCE })
  })

  it('a bulk bid change counts the SB keyword as failed and still applies the SP one', async () => {
    const { bulkUpdateAdTargetBids } = await import('./ads-mutation.service.js')
    const out = await inside(() => bulkUpdateAdTargetBids({ entries: [{ adTargetId: 't-sb', bidCents: 55 }, { adTargetId: 't-it', bidCents: 50 }], actor: PERSON }))
    expect(out).toMatchObject({ applied: 1, failed: 1 })
    expect(out.outcomes[0]).toMatchObject({ ok: false, error: SENTENCE })
    const bids = await inside(() => database.client.adTarget.findMany({ where: { id: { in: ['t-sb', 't-it'] } }, select: { id: true, bidCents: true }, orderBy: { id: 'asc' } }))
    expect(bids).toEqual([{ id: 't-it', bidCents: 50 }, { id: 't-sb', bidCents: 40 }])
  })

  it('a product ad status, even from a person; the SP product ad still pauses', async () => {
    const { updateProductAdWithSync } = await import('./ads-mutation.service.js')
    const before = await trail()
    const r = await inside(() => updateProductAdWithSync({ productAdId: 'pa-sb', status: 'PAUSED', actor: PERSON }))
    expect(r).toMatchObject({ ok: false, error: SENTENCE })
    const pa = await inside(() => database.client.adProductAd.findUniqueOrThrow({ where: { id: 'pa-sb' }, select: { status: true } }))
    expect(pa.status).toBe('ENABLED')
    expect(await trail()).toEqual(before)
    expect(await inside(() => updateProductAdWithSync({ productAdId: 'pa-it', status: 'PAUSED', actor: PERSON }))).toMatchObject({ ok: true })
  })
})

describe('placement bias (inline PUT to /sp/campaigns)', () => {
  it('refused like a gate denial: blocked, the sentence, deniedAt ad_product_unsupported, no PUT, no local change', async () => {
    const { updatePlacementBidding } = await import('./ads-create.service.js')
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-sb', adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], actor: RULE }))
    expect(r).toMatchObject({ ok: false, mode: 'blocked', reason: SENTENCE, deniedAt: 'ad_product_unsupported' })
    expect(amz.updateCampaign).not.toHaveBeenCalled()
    const c = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'c-sb' }, select: { dynamicBidding: true } }))
    expect(c.dynamicBidding).toBeNull()
  })

  it('the SP campaign still takes it', async () => {
    const { updatePlacementBidding } = await import('./ads-create.service.js')
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], actor: PERSON }))
    expect(r).toMatchObject({ ok: true, mode: 'sandbox' })
    expect(amz.updateCampaign).toHaveBeenCalledTimes(1)
  })
})

describe('negatives (/sp/negativeKeywords, /sp/negativeTargets) — the gate gets the ad product', () => {
  it('createNegative: refused at the gate for the SB campaign, sent for the SP one', async () => {
    const { createNegative } = await import('./ads-negative-kw.service.js')
    const args = { profileId: 'P-IT-TEST', marketplace: 'IT', keywordText: 'cheap brand', matchType: 'NEGATIVE_EXACT' as const, scope: 'CAMPAIGN' as const }
    const sb = await inside(() => createNegative({ ...args, externalCampaignId: 'EXT-c-sb' }))
    expect(sb).toMatchObject({ ok: false, denied: { deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('(it is Sponsored Brands)') } })
    const sp = await inside(() => createNegative({ ...args, externalCampaignId: 'EXT-c-it' }))
    expect(sp).toMatchObject({ ok: true, mode: 'sandbox', denied: null })
  })

  // 5b — and no local row: a refused negative leaves nothing behind (it used to write the row anyway).
  it('createNegativeKeywordLocal / createNegativeProductTargetLocal: no Amazon call and no local row for the SB ad group', async () => {
    const { createNegativeKeywordLocal, createNegativeProductTargetLocal } = await import('./ads-create.service.js')
    const kw = await inside(() => createNegativeKeywordLocal({ adGroupId: 'g-c-sb', keywordText: 'cheap brand', matchType: 'EXACT' }))
    expect(kw).toMatchObject({ id: null, externalTargetId: null, mode: 'refused', refusal: { deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('(it is Sponsored Brands)') } })
    const pt = await inside(() => createNegativeProductTargetLocal({ adGroupId: 'g-c-sb', asin: 'B0OTHER001' }))
    expect(pt).toMatchObject({ id: null, externalTargetId: null, mode: 'refused', refusal: { deniedAt: 'ad_product_unsupported' } })
    expect(amz.createNegativeKeyword).not.toHaveBeenCalled()
    expect(amz.createNegativeProductTarget).not.toHaveBeenCalled()
    expect(await inside(() => database.client.adTarget.count({ where: { adGroupId: 'g-c-sb', isNegative: true } }))).toBe(0)

    await inside(() => createNegativeKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'cheap brand', matchType: 'EXACT' }))
    expect(amz.createNegativeKeyword).toHaveBeenCalledTimes(1)
  })
})

describe('the marketing adapter (UM path) refuses before updateCampaign', () => {
  it('an SB budget is a FAILED result with the sentence; the SP budget is sent', async () => {
    const { amazonAdapter } = await import('../marketing/adapters/amazon.adapter.js')
    const mutation = (externalId: string) => ({ syncType: 'MKT_BUDGET_UPDATE', externalId, entityType: 'CAMPAIGN', payload: { budgetCents: 3000 } })
    const sb = await inside(() => amazonAdapter.applyMutation(mutation('EXT-c-sb'), { connectionId: '', marketplace: 'IT', mode: 'live' }))
    expect(sb).toEqual({ ok: false, status: 'FAILED', externalId: 'EXT-c-sb', error: SENTENCE })
    expect(amz.updateCampaign).not.toHaveBeenCalled()
    const sp = await inside(() => amazonAdapter.applyMutation(mutation('EXT-c-it'), { connectionId: '', marketplace: 'IT', mode: 'live' }))
    expect(sp).toMatchObject({ ok: true, status: 'SUCCESS' })
    expect(amz.updateCampaign).toHaveBeenCalledWith(expect.anything(), 'EXT-c-it', { dailyBudget: 30 })
  })
})
