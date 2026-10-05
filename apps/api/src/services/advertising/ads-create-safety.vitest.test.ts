/**
 * W2-B — the campaign creator is safe.
 *
 *   CM-20  an add on an EXISTING campaign (keyword, target, product ad, ad group) obeys the same write gate as an edit
 *          of it: the campaign's live-write allowlist, its pins and bid bounds, Amazon's bid range. A launch's own adds
 *          (`creationFlow`) are not refused by the allowlist or his policies, only by Amazon's range. Sponsored Brands
 *          and Display adds keep going to their own endpoints (the gate's SB/SD refusal is for updates).
 *   CM-33  the create dedupe is atomic: two adds of the same keyword at the same moment send ONE create to Amazon,
 *          and two creates of one campaign name in a market make one campaign.
 *
 * Real create service and the real write gate in LIVE mode, on PGlite (production schema) with the shared fake ads
 * account (c-it allowlisted, c-off not, c-pin bids pinned, c-sb Sponsored Brands). Amazon is a recorder.
 */
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
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), notifyAutomation: async () => 0 }))

/** Amazon, as a recorder: every create answers with a fresh id after `delayMs`. */
const amz = vi.hoisted(() => ({ creates: [] as Array<{ resource: string; input: Record<string, unknown> }>, n: 0, delayMs: 0 }))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (resource: string, idField: string) => async (_ctx: unknown, input: Record<string, unknown>) => {
    amz.creates.push({ resource, input })
    if (amz.delayMs) await new Promise((r) => setTimeout(r, amz.delayMs))
    const raw = { [resource]: { success: [{ index: 0, [idField]: `AMZ-${++amz.n}` }], error: [] } }
    return { ok: true, mode: 'live', externalId: `AMZ-${amz.n}`, rawResponse: raw, error: null }
  }
  return {
    ...real,
    createCampaign: create('campaigns', 'campaignId'),
    createKeyword: create('keywords', 'keywordId'),
    createSbKeyword: create('sbKeywords', 'keywordId'),
    createTarget: create('targetingClauses', 'targetId'),
    createProductAd: create('productAds', 'adId'),
    createAdGroup: create('adGroups', 'adGroupId'),
  }
})

import { setCreateClaimSleepForTests } from './ads-create-claim.js'

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const svc = () => import('./ads-create.service.js')

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'SAFE-SKU-1', name: 'Safety jacket', basePrice: '99.00' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); setCreateClaimSleepForTests(null); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.creates = []; amz.delayMs = 0
  setCreateClaimSleepForTests(async () => { await new Promise((r) => setTimeout(r, 5)) })
})

describe('CM-20 — an add on an existing campaign obeys the campaign\'s own write rules, as an edit does', () => {
  it('🔴 a keyword added to a campaign NOT on the live-write allowlist is refused in the gate\'s words; nothing is sent or kept', async () => {
    const { createKeywordLocal } = await svc()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-off', keywordText: 'cm20 allowlist', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: null })
    expect(r.reason).toMatch(/not on the live-write allowlist/)
    expect(amz.creates).toEqual([])
    expect(await inside(() => db().adTarget.count({ where: { expressionValue: 'cm20 allowlist' } }))).toBe(0)
  })

  it('the same add on an allowlisted campaign is sent and kept', async () => {
    const { createKeywordLocal } = await svc()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'cm20 allowed', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: true, outcome: 'created' })
    expect(amz.creates.map((c) => c.resource)).toEqual(['keywords'])
  })

  it('🔴 a campaign whose bids are pinned by hand refuses an added keyword\'s bid, as it refuses a bid edit', async () => {
    const { createKeywordLocal } = await svc()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-pin', keywordText: 'cm20 pinned', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: false, outcome: 'refused' })
    expect(amz.creates).toEqual([])
  })

  it('🔴 a bid outside Amazon\'s range in the market is refused with Amazon\'s limit, for an add as for an edit', async () => {
    const { createTargetLocal } = await svc()
    const r = await inside(() => createTargetLocal({ adGroupId: 'g-c-it', kind: 'PRODUCT', value: 'B0CM20LOW1', bidEur: 0.01, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: false, outcome: 'refused' })
    expect(r.reason).toMatch(/below Amazon's minimum of €0\.02 in IT/)
    expect(amz.creates).toEqual([])
  })

  it('a product ad added to a campaign not on the allowlist is refused too (it names the campaign now)', async () => {
    const { createProductAdLocal } = await svc()
    const r = await inside(() => createProductAdLocal({ adGroupId: 'g-c-off', sku: 'SAFE-SKU-1', requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: false, outcome: 'refused' })
    expect(r.reason).toMatch(/not on the live-write allowlist/)
    expect(amz.creates).toEqual([])
  })

  it('a launch\'s own adds (creationFlow) are not refused by the allowlist — only by Amazon\'s range', async () => {
    const { createKeywordLocal } = await svc()
    const ok = await inside(() => createKeywordLocal({ adGroupId: 'g-c-off', keywordText: 'cm20 launch', matchType: 'PHRASE', bidEur: 0.4, creationFlow: true }))
    expect(ok.externalTargetId).toMatch(/^AMZ-/)
    const low = await inside(() => createKeywordLocal({ adGroupId: 'g-c-off', keywordText: 'cm20 launch low', matchType: 'PHRASE', bidEur: 0.01, creationFlow: true }))
    expect(low.externalTargetId).toBeNull()
    expect(low.denied).toMatchObject({ deniedAt: 'market_limits' })
  })

  it('a Sponsored Brands add still goes to its own endpoint (the gate\'s SB/SD refusal is for updates only)', async () => {
    const { createKeywordLocal } = await svc()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-sb', keywordText: 'cm20 brand', matchType: 'BROAD', bidEur: 0.4, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(r).toMatchObject({ ok: true, outcome: 'created' })
    expect(amz.creates.map((c) => c.resource)).toEqual(['sbKeywords'])
  })
})

describe('CM-33 — the create dedupe is atomic', () => {
  it('🔴 two adds of the same keyword at the same moment send ONE create to Amazon and keep ONE row', async () => {
    const { createKeywordLocal } = await svc()
    amz.delayMs = 60
    const add = () => inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'cm33 twice', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    const [a, b] = await Promise.all([add(), add()])
    expect(amz.creates.filter((c) => c.resource === 'keywords')).toHaveLength(1)
    expect([a.outcome, b.outcome].sort()).toEqual(['already_existed', 'created'])
    expect(await inside(() => db().adTarget.count({ where: { adGroupId: 'g-c-it', expressionValue: 'cm33 twice' } }))).toBe(1)
  })

  it('🔴 two creates of one campaign name in a market make one campaign; the second is refused with the reason', async () => {
    const { createCampaignLocal } = await svc()
    amz.delayMs = 60
    const make = (name: string) => inside(() => createCampaignLocal({ name, type: 'SP', marketplace: 'IT', targetingType: 'MANUAL', dailyBudgetEur: 10 }))
    const results = await Promise.allSettled([make('CM33 Launch'), make('cm33 launch')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/IT already has a campaign named/)
    expect(amz.creates.filter((c) => c.resource === 'campaigns')).toHaveLength(1)
    expect(await inside(() => db().campaign.count({ where: { name: { equals: 'cm33 launch', mode: 'insensitive' } } }))).toBe(1)
  })

  it('the claim is let go after each create, and another match type of the same text is a different create', async () => {
    const { createKeywordLocal } = await svc()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'cm33 twice', matchType: 'PHRASE', bidEur: 0.4 }))
    expect(r.externalTargetId).toMatch(/^AMZ-/)
    expect(await inside(() => db().commandReceipt.count({ where: { scope: 'ads-create-claim' } }))).toBe(0)
  })
})
