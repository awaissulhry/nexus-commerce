/**
 * PB-5a — the SP Super Wizard launch as a service (ads-sp-wizard-launch.service.ts), with the ads playbook's options.
 *
 *   playbook   off the live-write allowlist, the ad group, keywords, negatives, product ads (by SKU), product targets and
 *              Auto groups still reach Amazon (every create of the launch passes creationFlow); born suppressed: every
 *              bid at the 2¢ floor with the planned bid remembered, the campaign flagged suppressed by the requester;
 *              deferPlacements writes none and returns them; every audit row carries the change set; progress per
 *              campaign and once at the end; the answer maps each wizard campaign to its campaign and ad group
 *   screens    no options: on the allowlist, the bids as asked, the placements written (the route's launch)
 *
 * Real create services, the real write gate in LIVE mode and the real read-back, on PGlite (production schema) with the
 * shared fake ads account. Amazon is a recorder that answers every create with a fresh id. Values are made up.
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
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('./ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

type Clause = { targetId: string; adGroupId: string; expressionType: string; state: string; bid?: number; expression: Array<{ type: string }> }

/** Amazon, as a recorder: every create gets a fresh id; each ad group lists its four auto groups. */
const amz = vi.hoisted(() => ({
  calls: [] as string[],
  n: 0,
  bids: [] as Array<{ resource: string; bid: unknown }>,
  autoGroups: new Map<string, Clause[]>(),
  placements: [] as string[],
}))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (resource: string, idField: string) => async (_ctx: unknown, args: { bid?: unknown; defaultBid?: unknown }) => {
    amz.calls.push(resource)
    if (args && ('bid' in args || 'defaultBid' in args)) amz.bids.push({ resource, bid: args.bid ?? args.defaultBid })
    const raw = { [resource]: { success: [{ index: 0, [idField]: `AMZ-${++amz.n}` }], error: [] } }
    const made = real.v3CreateResult(raw, resource, idField)
    return { ok: true, mode: 'live', externalId: made.externalId, rawResponse: raw, error: null }
  }
  const autoOf = (adGroupId: string): Clause[] => {
    if (!amz.autoGroups.has(adGroupId)) {
      amz.autoGroups.set(adGroupId, ['QUERY_HIGH_REL_MATCHES', 'QUERY_BROAD_REL_MATCHES', 'ASIN_SUBSTITUTE_RELATED', 'ASIN_ACCESSORY_RELATED']
        .map((type) => ({ targetId: `AUTO-${adGroupId}-${type}`, adGroupId, expressionType: 'AUTO', state: 'ENABLED', expression: [{ type }] })))
    }
    return amz.autoGroups.get(adGroupId)!
  }
  return {
    ...real,
    createCampaign: create('campaigns', 'campaignId'),
    createAdGroup: create('adGroups', 'adGroupId'),
    createKeyword: create('keywords', 'keywordId'),
    createTarget: create('targetingClauses', 'targetId'),
    createProductAd: create('productAds', 'adId'),
    createNegativeKeyword: async () => { amz.calls.push('negativeKeywords'); return { ok: true, mode: 'live', externalId: `AMZ-NK-${++amz.n}`, rawResponse: {} } },
    createNegativeProductTarget: async () => { amz.calls.push('negativeTargets'); return { ok: true, mode: 'live', externalId: `AMZ-NT-${++amz.n}`, rawResponse: {} } },
    listTargets: async (_ctx: unknown, opts: { adGroupIds?: string[] }) => {
      if (!opts.adGroupIds?.length) return []
      amz.calls.push('targets/list')
      return opts.adGroupIds.flatMap(autoOf)
    },
    updateTarget: async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
      amz.calls.push('targets/update')
      if (patch.bid != null) amz.bids.push({ resource: 'autoGroup', bid: patch.bid })
      for (const list of amz.autoGroups.values()) {
        const c = list.find((x) => x.targetId === externalId)
        if (c && patch.bid != null) c.bid = Number(patch.bid)
      }
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    listCampaignsV3: async (_ctx: unknown, opts?: { campaignIds?: string[] }) => (opts?.campaignIds ?? []).map((campaignId) => ({ campaignId, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] } })),
    updateCampaign: async (_ctx: unknown, externalId: string) => { amz.calls.push('campaigns/update'); amz.placements.push(externalId); return { ok: true, mode: 'live', rawResponse: {}, error: null } },
    listAdGroupsV3: async () => [],
    listKeywords: async () => [],
    listProductAds: async () => [],
    listNegativeKeywords: async () => [],
    listNegativeTargets: async () => [],
  }
})

import { spWizardLaunch, type SpwLaunchBody, type SpwProgress } from './ads-sp-wizard-launch.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'TEST-PBW-1', name: 'Test jacket', basePrice: '99.00', amazonAsin: 'B0TESTPBW1' } })
    await database.client.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.calls = []; amz.bids = []; amz.placements = []
})

/** A playbook-like body: one keyword slot, one product-target slot, one Auto slot; placements asked for. */
const body = (tag: string): SpwLaunchBody => ({
  market: 'IT', productGroupName: tag,
  products: [{ sku: 'TEST-PBW-1', asin: 'B0TESTPBW1' }],
  campaigns: [
    {
      id: 'exact-category', name: `${tag} | IT | Exact | Category`, kind: 'keyword', bidEur: 0.4, budgetEur: 12, biddingStrategy: 'AUTO_FOR_SALES',
      keywords: [{ text: 'test jacket', matchType: 'EXACT', bidEur: 0.45 }], negKeywords: [{ text: 'test kids', matchType: 'PHRASE' }],
    },
    { id: 'pat', name: `${tag} | IT | PAT`, kind: 'pat', bidEur: 0.3, budgetEur: 5, productTargets: [{ asin: 'B0TESTRIV1' }] },
    { id: 'auto', name: `${tag} | IT | Auto`, kind: 'auto', bidEur: 0.35, budgetEur: 6, autoGroups: [{ key: 'CLOSE_MATCH', enabled: true, bidEur: 0.35 }, { key: 'LOOSE_MATCH', enabled: false, bidEur: 0.25 }] },
  ],
  placementBids: { tos: '25' },
})

type Answer = {
  ok: boolean; created: Array<{ name: string; campaignId: string; externalCampaignId: string | null }>
  slots: Record<string, { campaignId: string; adGroupId: string }>
  deferredPlacements?: Array<{ campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }>
  launch: { ok: boolean; live: number }
}

describe('the playbook build options', () => {
  let answer: Answer
  const progress: SpwProgress[] = []
  let calls: string[] = []
  let bids: typeof amz.bids = []
  let placements: string[] = []
  beforeAll(async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const out = await inside(() => spWizardLaunch(body('PBW'), 'user:approver', {
      allowlistAtBirth: false,
      bornSuppressed: { floorCents: 2, by: 'user:asker' },
      changeSetId: 'cs-pbw-1',
      deferPlacements: true,
      onProgress: async (p) => { progress.push(p) },
    }))
    expect(out.status).toBe(200)
    answer = out.body as unknown as Answer
    ;({ calls, bids, placements } = { calls: [...amz.calls], bids: [...amz.bids], placements: [...amz.placements] })
  })

  it('off the allowlist, every part still reaches Amazon: ad groups, keywords, negatives, product ads by SKU, product targets, Auto groups', async () => {
    expect(answer.launch).toMatchObject({ ok: true, live: 3 })
    // The Auto groups are Amazon's own: linked and set (Loose match off), never POSTed.
    expect(calls).toEqual(expect.arrayContaining(['campaigns', 'adGroups', 'keywords', 'negativeKeywords', 'productAds', 'targetingClauses', 'targets/list', 'targets/update']))
    const ids = answer.created.map((c) => c.campaignId)
    const campaigns = await inside(() => db().campaign.findMany({ where: { id: { in: ids } }, select: { name: true, liveBidWritesEnabled: true, externalCampaignId: true, status: true } }))
    expect(campaigns.every((c) => !c.liveBidWritesEnabled && c.externalCampaignId && String(c.status) === 'ENABLED')).toBe(true)
    const ads = await inside(() => db().adProductAd.findMany({ where: { adGroup: { campaignId: { in: ids } } }, select: { sku: true, externalAdId: true } }))
    expect(ads).toHaveLength(3)
    expect(ads.every((a) => a.sku === 'TEST-PBW-1' && a.externalAdId)).toBe(true)
  })

  it('born suppressed: every bid at 2¢ with the planned bid remembered; the campaign flagged by the person who asked; never paused', async () => {
    expect(bids.length).toBeGreaterThan(4)
    expect(bids.filter((b) => Number(b.bid) !== 0.02)).toEqual([])
    const exact = answer.slots['exact-category']
    const group = await inside(() => db().adGroup.findUniqueOrThrow({ where: { id: exact.adGroupId }, select: { defaultBidCents: true, suppressedFromBidCents: true } }))
    expect(group).toEqual({ defaultBidCents: 2, suppressedFromBidCents: 40 })
    const keyword = await inside(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: exact.adGroupId, kind: 'KEYWORD', isNegative: false }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(keyword).toEqual({ bidCents: 2, suppressedFromBidCents: 45 })
    const pat = await inside(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: answer.slots.pat.adGroupId, kind: 'PRODUCT' }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(pat).toEqual({ bidCents: 2, suppressedFromBidCents: 30 })
    const auto = await inside(() => db().adTarget.findMany({ where: { adGroupId: answer.slots.auto.adGroupId, kind: 'AUTO', expressionValue: { in: ['CLOSE_MATCH', 'LOOSE_MATCH'] } }, orderBy: { expressionValue: 'asc' }, select: { expressionValue: true, bidCents: true, suppressedFromBidCents: true } }))
    expect(auto).toEqual([
      { expressionValue: 'CLOSE_MATCH', bidCents: 2, suppressedFromBidCents: 35 },
      { expressionValue: 'LOOSE_MATCH', bidCents: 2, suppressedFromBidCents: 25 },
    ])
    const flagged = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: exact.campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedFloorCents: true, bidsSuppressedBy: true, status: true } }))
    expect(flagged).toMatchObject({ bidsSuppressedAt: expect.any(Date), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'user:asker' })
  })

  it('writes no placement and returns them; the slot\'s bidding strategy travels', async () => {
    expect(placements).toEqual([])
    expect(calls).not.toContain('campaigns/update')
    expect(answer.deferredPlacements).toHaveLength(3)
    expect(answer.deferredPlacements![0].adjustments).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 25 }])
    const strategies = await inside(() => db().campaign.findMany({ where: { id: { in: [answer.slots['exact-category'].campaignId, answer.slots.pat.campaignId] } }, orderBy: { name: 'asc' }, select: { name: true, biddingStrategy: true } }))
    expect(strategies.map((c) => String(c.biddingStrategy))).toEqual(['AUTO_FOR_SALES', 'LEGACY_FOR_SALES'])
  })

  it('every audit row it wrote carries the change set; progress before each campaign and once at the end; the slots map', async () => {
    const ids = answer.created.map((c) => c.campaignId)
    const groups = Object.values(answer.slots).map((s) => s.adGroupId)
    const targets = (await inside(() => db().adTarget.findMany({ where: { adGroupId: { in: groups } }, select: { id: true } }))).map((t) => t.id)
    const ads = (await inside(() => db().adProductAd.findMany({ where: { adGroupId: { in: groups } }, select: { id: true } }))).map((a) => a.id)
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: { in: [...ids, ...groups, ...targets, ...ads] } }, select: { actionType: true, executionId: true, entityType: true } }))
    expect(logs.length).toBeGreaterThan(10)
    // The read-back receipt (launch_verification) is not a write: it is the one row without the change set.
    expect(logs.filter((l) => l.executionId !== 'cs-pbw-1').map((l) => `${l.actionType} ${l.entityType}`)).toEqual(['launch_verification CAMPAIGN'])
    expect(new Set(logs.map((l) => l.actionType))).toEqual(new Set(['create_campaign', 'create_ad_group', 'create_keyword', 'create_negative_keyword', 'create_product_ad', 'create_target', 'link_auto_target', 'launch_verification']))
    expect(progress.map((p) => [p.done, p.campaign])).toEqual([[0, 'PBW | IT | Exact | Category'], [1, 'PBW | IT | PAT'], [2, 'PBW | IT | Auto'], [3, null]])
    expect(Object.keys(answer.slots).sort()).toEqual(['auto', 'exact-category', 'pat'])
  })
})

describe('no options: the screens\' launch', () => {
  it('on the allowlist at birth, the bids as asked, the placements written, no floor, no change set', async () => {
    const out = await inside(() => spWizardLaunch({ ...body('SCR'), campaigns: body('SCR').campaigns!.slice(0, 1).map(({ biddingStrategy: _b, ...c }) => c) }, 'user:screen'))
    expect(out.status).toBe(200)
    const answer = out.body as unknown as Answer
    expect(answer.ok).toBe(true)
    expect(answer.deferredPlacements).toBeUndefined()
    const c = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: answer.created[0].campaignId }, select: { liveBidWritesEnabled: true, bidsSuppressedAt: true } }))
    expect(c).toEqual({ liveBidWritesEnabled: true, bidsSuppressedAt: null })
    expect(amz.bids.map((b) => Number(b.bid))).toEqual(expect.arrayContaining([0.4, 0.45]))
    expect(amz.placements).toHaveLength(1)
    const k = await inside(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: answer.slots['exact-category'].adGroupId, kind: 'KEYWORD', isNegative: false }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(k).toEqual({ bidCents: 45, suppressedFromBidCents: null })
    const logs = await inside(() => db().advertisingActionLog.count({ where: { entityId: answer.created[0].campaignId, executionId: { not: null } } }))
    expect(logs).toBe(0)
  })

  it('refuses before anything is created: no market, no campaigns, an SB campaign', async () => {
    expect((await inside(() => spWizardLaunch({ ...body('X'), market: undefined }, 'user:screen'))).status).toBe(400)
    expect((await inside(() => spWizardLaunch({ ...body('X'), campaigns: [] }, 'user:screen'))).body).toEqual({ error: 'no campaigns to create' })
    expect((await inside(() => spWizardLaunch({ ...body('X'), campaigns: [{ name: 'X sb', kind: 'keyword', adProduct: 'SB' }] }, 'user:screen'))).status).toBe(400)
  })
})
