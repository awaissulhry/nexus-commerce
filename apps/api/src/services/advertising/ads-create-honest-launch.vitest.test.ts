/**
 * W2-A — the campaign creator makes what was asked, and says honestly what happened (CC-1, CC-2, CC-3, CC-17).
 *
 *   CC-1   Amazon makes the four auto groups itself: a launch links them (by expression type) and sends only the
 *          on/off and bid the person changed. Nothing is POSTed as a new target; a refused change is put back.
 *   CC-3   a refused campaign create is stored FAILED with Amazon's (or the gate's) reason and logged FAILED.
 *   CC-2   every launch answers each campaign: live / partly made (what failed, why) / not made (why); `ok` only when
 *          everything asked for is live. A refused product ad keeps its row (no Amazon id) for the read-back.
 *   CC-17  negatives go first; the read-back checks the auto groups by expression, the negatives and the placements.
 *
 * Real create services, launch routes, the real write gate in LIVE mode and the real read-back, on PGlite (production
 * schema) with the shared fake ads account. Amazon is a small recorder: each create answers with a 207 body a test
 * queues (read by the client's own `v3CreateResult`), else with a fresh id; it lists the four auto groups of any ad group.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
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

type Clause = { targetId: string; adGroupId: string; campaignId?: string; expressionType: string; state: string; bid?: number; expression: Array<{ type: string; value?: string }> }

/** Amazon, as a recorder. */
const amz = vi.hoisted(() => ({
  /** per resource, one entry per create call in order: refuse (a 207 with Amazon's words), throw, or null = made */
  script: {} as Record<string, Array<{ refuse?: string; throw?: string } | null>>,
  calls: [] as string[],
  n: 0,
  /** ad groups Amazon made no auto groups for (the read finds none) */
  noAuto: new Set<string>(),
  autoGroups: new Map<string, Clause[]>(),
  targetUpdates: [] as Array<{ externalId: string; patch: Record<string, unknown>; kind: unknown }>,
  targetUpdateAnswer: null as null | { ok: boolean; error?: string },
  placements: new Map<string, Array<{ placement: string; percentage: number }>>(),
  /** what the read-back lists (verifyLaunch) */
  lists: { campaigns: [] as unknown[], adGroups: [] as unknown[], targets: [] as unknown[], keywords: [] as unknown[], productAds: [] as unknown[], negKeywords: [] as unknown[], negTargets: [] as unknown[] },
}))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (resource: string, idField: string) => async () => {
    amz.calls.push(resource)
    const step = amz.script[resource]?.shift()
    if (step?.throw) throw new Error(step.throw)
    const raw = step?.refuse
      ? { [resource]: { success: [], error: [{ index: 0, errors: [{ errorType: 'invalidArgument', errorValue: { invalidArgumentError: { message: step.refuse } } }] }] } }
      : { [resource]: { success: [{ index: 0, [idField]: `AMZ-${++amz.n}` }], error: [] } }
    const made = real.v3CreateResult(raw, resource, idField)
    return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: raw, error: made.error }
  }
  const autoOf = (adGroupId: string): Clause[] => {
    if (amz.noAuto.has(adGroupId)) return []
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
    listTargets: async (_ctx: unknown, opts: { adGroupIds?: string[]; campaignIds?: string[] }) => {
      if (opts.adGroupIds?.length) { amz.calls.push('targets/list'); return opts.adGroupIds.flatMap(autoOf) }
      return amz.lists.targets
    },
    updateTarget: async (_ctx: unknown, externalId: string, patch: Record<string, unknown>, kind: unknown) => {
      amz.calls.push('targets/update')
      amz.targetUpdates.push({ externalId, patch, kind })
      const answer = amz.targetUpdateAnswer ?? { ok: true }
      if (answer.ok) {
        for (const list of amz.autoGroups.values()) {
          const c = list.find((x) => x.targetId === externalId)
          if (c && patch.state) c.state = String(patch.state).toUpperCase()
          if (c && patch.bid != null) c.bid = Number(patch.bid)
        }
      }
      return { ok: answer.ok, mode: 'live', rawResponse: {}, error: answer.error ?? null }
    },
    listCampaignsV3: async (_ctx: unknown, opts?: { campaignIds?: string[] }) => [
      ...(opts?.campaignIds ?? []).filter((id) => !(amz.lists.campaigns as Array<{ campaignId: string }>).some((c) => c.campaignId === id))
        .map((campaignId) => ({ campaignId, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: amz.placements.get(campaignId) ?? [] } })),
      ...amz.lists.campaigns as never[],
    ],
    updateCampaign: async (_ctx: unknown, externalId: string, patch: { placementBidding?: Array<{ placement: string; percentage: number }> }) => {
      amz.calls.push('campaigns/update')
      if (patch.placementBidding) amz.placements.set(externalId, patch.placementBidding)
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    listAdGroupsV3: async () => amz.lists.adGroups,
    listKeywords: async () => amz.lists.keywords,
    listProductAds: async () => amz.lists.productAds,
    listNegativeKeywords: async () => amz.lists.negKeywords,
    listNegativeTargets: async () => amz.lists.negTargets,
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: '99.00' } })
    await database.client.product.create({ data: { sku: 'TEST-SKU-2', name: 'Test gloves', basePrice: '29.00' } })
    await database.client.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it' } })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: routes } = await import('../../routes/advertising.routes.js')
  await app.register(routes)
  await app.ready()
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await app?.close(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.script = {}; amz.calls = []; amz.targetUpdates = []; amz.targetUpdateAnswer = null
  amz.noAuto.clear()
  amz.lists = { campaigns: [], adGroups: [], targets: [], keywords: [], productAds: [], negKeywords: [], negTargets: [] }
})

/** A campaign + ad group on Amazon (fake ids) in IT, allowlisted, for the auto-group link. */
async function autoAdGroup(key: string, defaultBidCents = 75) {
  return inside(async () => {
    await db().campaign.create({ data: { id: `c-${key}`, name: `Auto ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-c-${key}`, dailyBudget: '10.00', startDate: new Date(), liveBidWritesEnabled: true, targetingType: 'AUTO' } })
    await db().adGroup.create({ data: { id: `g-${key}`, campaignId: `c-${key}`, name: `Auto ${key} group`, externalAdGroupId: `EXT-g-${key}`, defaultBidCents } })
    return `g-${key}`
  })
}
const autoRows = (adGroupId: string) => inside(() => db().adTarget.findMany({ where: { adGroupId, kind: 'AUTO' }, orderBy: { expressionValue: 'asc' }, select: { expressionValue: true, externalTargetId: true, status: true, bidCents: true, lastSyncStatus: true, lastSyncError: true } }))

describe('CC-1 — Amazon\'s own auto groups are linked and set as asked', () => {
  it('links all four by expression, sends only what differs (Loose match off at 0.49, Substitutes 0.80), and POSTs no target', async () => {
    const { linkAutoTargeting } = await import('./ads-create.service.js')
    const g = await autoAdGroup('a1')
    const r = await inside(() => linkAutoTargeting({ adGroupId: g, groups: [
      { key: 'CLOSE_MATCH', enabled: true, bidEur: 0.75 },
      { key: 'LOOSE_MATCH', enabled: false, bidEur: 0.49 },
      { key: 'SUBSTITUTES', enabled: true, bidEur: 0.8 },
    ] }))
    expect(r.ok).toBe(true)
    expect(amz.calls).not.toContain('targetingClauses')
    expect(amz.targetUpdates).toEqual([
      { externalId: 'AUTO-EXT-g-a1-QUERY_BROAD_REL_MATCHES', patch: { state: 'paused', bid: 0.49 }, kind: 'AUTO' },
      { externalId: 'AUTO-EXT-g-a1-ASIN_SUBSTITUTE_RELATED', patch: { bid: 0.8 }, kind: 'AUTO' },
    ])
    // Complements was not mentioned: Nexus still holds it, as Amazon has it.
    expect(await autoRows(g)).toEqual([
      { expressionValue: 'CLOSE_MATCH', externalTargetId: 'AUTO-EXT-g-a1-QUERY_HIGH_REL_MATCHES', status: 'ENABLED', bidCents: 75, lastSyncStatus: 'SUCCESS', lastSyncError: null },
      { expressionValue: 'COMPLEMENTS', externalTargetId: 'AUTO-EXT-g-a1-ASIN_ACCESSORY_RELATED', status: 'ENABLED', bidCents: 75, lastSyncStatus: 'SUCCESS', lastSyncError: null },
      { expressionValue: 'LOOSE_MATCH', externalTargetId: 'AUTO-EXT-g-a1-QUERY_BROAD_REL_MATCHES', status: 'PAUSED', bidCents: 49, lastSyncStatus: 'SUCCESS', lastSyncError: null },
      { expressionValue: 'SUBSTITUTES', externalTargetId: 'AUTO-EXT-g-a1-ASIN_SUBSTITUTE_RELATED', status: 'ENABLED', bidCents: 80, lastSyncStatus: 'SUCCESS', lastSyncError: null },
    ])
  })

  it('a change Amazon refuses is put back: the row says what Amazon kept, FAILED with the reason, and the link is not ok', async () => {
    const { linkAutoTargeting } = await import('./ads-create.service.js')
    const g = await autoAdGroup('a2')
    amz.targetUpdateAnswer = { ok: false, error: 'amazon_rejected: bid below the minimum' }
    const r = await inside(() => linkAutoTargeting({ adGroupId: g, groups: [{ key: 'LOOSE_MATCH', enabled: false, bidEur: 0.01 }] }))
    expect(r.ok).toBe(false)
    expect(r.links[0]).toMatchObject({ label: 'Loose match', ok: false, status: 'ENABLED', bidCents: 75 })
    expect(r.links[0].reason).toContain('bid below the minimum')
    const loose = (await autoRows(g)).find((x) => x.expressionValue === 'LOOSE_MATCH')
    expect(loose).toMatchObject({ status: 'ENABLED', bidCents: 75, lastSyncStatus: 'FAILED', externalTargetId: 'AUTO-EXT-g-a2-QUERY_BROAD_REL_MATCHES' })
  })

  it('a group Amazon does not list (after one more read) is not linked: Amazon\'s default is shown, never the unsent setting', async () => {
    const { linkAutoTargeting } = await import('./ads-create.service.js')
    const g = await autoAdGroup('a3')
    amz.noAuto.add('EXT-g-a3')
    const r = await inside(() => linkAutoTargeting({ adGroupId: g, groups: [{ key: 'LOOSE_MATCH', enabled: false, bidEur: 0.3 }], retryDelayMs: 0 }))
    expect(r.ok).toBe(false)
    expect(amz.calls.filter((c) => c === 'targets/list')).toHaveLength(2)
    expect(await autoRows(g)).toEqual([
      expect.objectContaining({ expressionValue: 'LOOSE_MATCH', externalTargetId: null, status: 'ENABLED', bidCents: 75, lastSyncStatus: 'FAILED' }),
    ])
    expect(r.links[0].reason).toContain('was not linked')
  })

  it('an ad group not on Amazon keeps the rows as asked, with no Amazon id and nothing sent', async () => {
    const { linkAutoTargeting } = await import('./ads-create.service.js')
    await inside(async () => {
      await db().campaign.create({ data: { id: 'c-a4', name: 'Auto a4', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date() } })
      await db().adGroup.create({ data: { id: 'g-a4', campaignId: 'c-a4', name: 'Auto a4 group' } })
    })
    const r = await inside(() => linkAutoTargeting({ adGroupId: 'g-a4', groups: [{ key: 'COMPLEMENTS', enabled: false, bidEur: 0.4 }] }))
    expect(r.ok).toBe(false)
    expect(amz.calls).toEqual([])
    expect(await autoRows('g-a4')).toEqual([expect.objectContaining({ expressionValue: 'COMPLEMENTS', externalTargetId: null, status: 'PAUSED', bidCents: 40 })])
  })
})

describe('CC-3 — a refused campaign create is not stored as a live campaign', () => {
  it('Amazon\'s 207 refusal: the row is FAILED with Amazon\'s words, the audit row is FAILED, and the reason is returned', async () => {
    const { createCampaignLocal } = await import('./ads-create.service.js')
    amz.script.campaigns = [{ refuse: 'A campaign with this name already exists' }]
    const r = await inside(() => createCampaignLocal({ name: 'Refused one', type: 'SP', marketplace: 'IT', targetingType: 'MANUAL', dailyBudgetEur: 10 }))
    expect(r.externalCampaignId).toBeNull()
    expect(r.reason).toBe('Amazon refused it: A campaign with this name already exists')
    const row = await inside(() => db().campaign.findUniqueOrThrow({ where: { id: r.id } }))
    expect(row).toMatchObject({ externalCampaignId: null, lastSyncStatus: 'FAILED', lastSyncError: 'Amazon refused it: A campaign with this name already exists' })
    const log = await inside(() => db().advertisingActionLog.findFirstOrThrow({ where: { entityId: r.id, actionType: 'create_campaign' } }))
    expect(log.amazonResponseStatus).toBe('FAILED')
  })

  it('no connection for the market: FAILED with that reason, nothing sent', async () => {
    const { createCampaignLocal } = await import('./ads-create.service.js')
    const r = await inside(() => createCampaignLocal({ name: 'Nowhere', type: 'SP', marketplace: 'ES', dailyBudgetEur: 10 }))
    expect(amz.calls).toEqual([])
    expect(r.reason).toContain('No active Amazon Ads connection for ES')
    expect(await inside(() => db().campaign.findUniqueOrThrow({ where: { id: r.id }, select: { lastSyncStatus: true } }))).toEqual({ lastSyncStatus: 'FAILED' })
  })

  it('a created campaign keeps SUCCESS and no reason', async () => {
    const { createCampaignLocal } = await import('./ads-create.service.js')
    const r = await inside(() => createCampaignLocal({ name: 'Made one', type: 'SP', marketplace: 'IT', dailyBudgetEur: 10 }))
    expect(r).toMatchObject({ externalCampaignId: expect.stringMatching(/^AMZ-/), reason: null })
    expect(await inside(() => db().campaign.findUniqueOrThrow({ where: { id: r.id }, select: { lastSyncStatus: true, lastSyncError: true } }))).toEqual({ lastSyncStatus: 'SUCCESS', lastSyncError: null })
  })
})


const spwCampaign = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name, name, kind: 'keyword', matchType: 'Exact', bidEur: 0.6, budgetEur: 10, keywords: ['race jacket'],
  negKeywords: [{ text: 'cheap', matchType: 'EXACT' }], ...extra,
})
type LaunchBody = {
  ok: boolean; error?: string; created: Array<{ campaignId: string }>
  launch: { ok: boolean; asked: number; live: number; partial: number; failed: number; campaigns: Array<{ name: string; campaignId: string | null; status: string; reason: string | null; made: Record<string, unknown>; failed: Array<{ step: string; item: string; reason: string }> }> }
}

describe('CC-2 — the SP Super Wizard / Quick / Guided launch answers every campaign', () => {
  it('a refused campaign, a throwing one and a partly made one are all listed with why; ok is false', async () => {
    amz.script.campaigns = [{ refuse: 'Budget is below the minimum' }, { throw: '[ADS-LIVE] POST /sp/campaigns → 500: upstream timeout' }, null]
    // The third campaign's ads: SKU 1 made, SKU 2 refused by Amazon.
    amz.script.productAds = [null, { refuse: 'This product is not eligible for advertising' }]
    const res = await app.inject({
      method: 'POST', url: '/advertising/campaign-builder/sp-super-wizard/launch', headers: { 'x-actor-id': 'u-w2a' },
      payload: {
        market: 'IT', productGroupName: 'W2A',
        products: [{ sku: 'TEST-SKU-1' }, { sku: 'TEST-SKU-2' }],
        campaigns: [
          spwCampaign('W2A refused'), spwCampaign('W2A throws'),
          spwCampaign('W2A partly', { kind: 'auto', keywords: [], autoGroups: [{ key: 'LOOSE_MATCH', enabled: false, bidEur: 0.4 }, { key: 'CLOSE_MATCH', enabled: true, bidEur: 0.6 }] }),
        ],
        placementBids: { tos: '50' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as LaunchBody
    expect(body.ok).toBe(false)
    expect(body.error).toContain('0 of 3 campaigns live on Amazon')
    expect(body.launch).toMatchObject({ ok: false, asked: 3, live: 0, partial: 1, failed: 2 })
    const [refused, threw, partly] = body.launch.campaigns
    expect(refused).toMatchObject({ name: 'W2A refused', status: 'failed', reason: 'Amazon refused it: Budget is below the minimum', campaignId: expect.any(String) })
    expect(threw).toMatchObject({ name: 'W2A throws', status: 'failed', campaignId: null, reason: '[ADS-LIVE] POST /sp/campaigns → 500: upstream timeout' })
    expect(partly).toMatchObject({ name: 'W2A partly', status: 'partial', made: { adGroups: 1, productAds: 1, autoTargeting: 2, negativeKeywords: 1, placement: true } })
    expect(partly.failed).toEqual([{ step: 'product_ad', item: 'TEST-SKU-2', reason: 'Amazon refused it: This product is not eligible for advertising' }])
    // Both campaigns Nexus holds are in the answer (the refused one is FAILED, not a live-looking row).
    expect(body.created.map((c) => c.campaignId)).toEqual([refused.campaignId, partly.campaignId])
    expect(await inside(() => db().campaign.findUniqueOrThrow({ where: { id: refused.campaignId! }, select: { lastSyncStatus: true, externalCampaignId: true } }))).toEqual({ lastSyncStatus: 'FAILED', externalCampaignId: null })
    // …and nothing is built under a campaign Amazon does not hold.
    expect(await inside(() => db().adGroup.count({ where: { campaignId: refused.campaignId! } }))).toBe(0)
    // The refused ad keeps its row (no Amazon id): the read-back and the launch repair can see it.
    const ads = await inside(() => db().adProductAd.findMany({ where: { adGroup: { campaignId: partly.campaignId! } }, orderBy: { sku: 'asc' }, select: { sku: true, externalAdId: true } }))
    expect(ads).toEqual([{ sku: 'TEST-SKU-1', externalAdId: expect.stringMatching(/^AMZ-/) }, { sku: 'TEST-SKU-2', externalAdId: null }])
    // CC-17 — negatives before the ads; CC-1 — the auto groups are linked and set, never POSTed.
    const after = amz.calls.slice(amz.calls.lastIndexOf('adGroups'))
    expect(after.indexOf('negativeKeywords')).toBeLessThan(after.indexOf('productAds'))
    expect(amz.calls).not.toContain('targetingClauses')
    expect(amz.targetUpdates.map((u) => u.patch)).toEqual([{ state: 'paused', bid: 0.4 }])
  })

  it('a launch where everything reached Amazon is ok, with every campaign live', async () => {
    const res = await app.inject({
      method: 'POST', url: '/advertising/campaign-builder/sp-super-wizard/launch',
      payload: { market: 'IT', productGroupName: 'W2A ok', products: [{ sku: 'TEST-SKU-1' }], campaigns: [spwCampaign('W2A all live')] },
    })
    const body = JSON.parse(res.payload) as LaunchBody
    expect(body.ok).toBe(true)
    expect(body.error).toBeUndefined()
    expect(body.launch).toMatchObject({ ok: true, asked: 1, live: 1, partial: 0, failed: 0 })
    expect(body.launch.campaigns[0]).toMatchObject({ status: 'live', reason: null, failed: [], made: { adGroups: 1, productAds: 1, keywords: 1, negativeKeywords: 1, placement: null } })
  })

  it('an ad group Amazon refuses after the campaign is live: the campaign is listed as partly made, with why', async () => {
    amz.script.adGroups = [{ refuse: 'Default bid is above the budget' }]
    const res = await app.inject({
      method: 'POST', url: '/advertising/campaign-builder/sp-super-wizard/launch',
      payload: { market: 'IT', productGroupName: 'W2A ag', products: [{ sku: 'TEST-SKU-1' }], campaigns: [spwCampaign('W2A no group')] },
    })
    const body = JSON.parse(res.payload) as LaunchBody
    expect(body.launch.campaigns[0]).toMatchObject({ status: 'partial', failed: [{ step: 'ad_group', item: 'W2A no group Ad Group' }] })
    expect(body.launch.campaigns[0].failed[0].reason).toContain('Default bid is above the budget')
    expect(body.launch.campaigns[0].failed[0].reason).toContain('cannot serve')
  })
})

describe('CC-2 — the Single builder launch says what reached Amazon', () => {
  it('a refused product ad: ok false, the campaign partly made with the reason, the row kept without an Amazon id', async () => {
    amz.script.productAds = [{ refuse: 'SKU is not active in this marketplace' }]
    const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market: 'IT', name: 'W2A single', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'winter gloves', matchType: 'EXACT' }] } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as LaunchBody & { campaignId: string }
    expect(body.ok).toBe(false)
    expect(body.launch.campaigns[0]).toMatchObject({ status: 'partial', failed: [{ step: 'product_ad', item: 'TEST-SKU-1', reason: 'Amazon refused it: SKU is not active in this marketplace' }], made: { keywords: 1 } })
    expect(await inside(() => db().adProductAd.count({ where: { adGroup: { campaignId: body.campaignId }, externalAdId: null } }))).toBe(1)
  })

  it('a campaign Amazon refuses: ok false with Amazon\'s words, a FAILED record and nothing built under it', async () => {
    amz.script.campaigns = [{ refuse: 'Name is too long' }]
    const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market: 'IT', name: 'W2A single refused', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'x' }] } })
    const body = JSON.parse(res.payload) as LaunchBody & { campaignId: string }
    expect(body).toMatchObject({ ok: false, externalCampaignId: null, launch: { failed: 1, campaigns: [{ status: 'failed', reason: 'Amazon refused it: Name is too long' }] } })
    expect(amz.calls).toEqual(['campaigns'])
    expect(await inside(() => db().adGroup.count({ where: { campaignId: body.campaignId } }))).toBe(0)
  })

  it('a campaign create that throws: 200 with ok false and the campaign listed as not made (it was a bare 500)', async () => {
    amz.script.campaigns = [{ throw: 'socket hang up' }]
    const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market: 'IT', name: 'W2A single throws', keywords: [{ text: 'x' }] } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as LaunchBody
    expect(body).toMatchObject({ ok: false, error: 'socket hang up', launch: { asked: 1, failed: 1, campaigns: [{ status: 'failed', campaignId: null, reason: 'socket hang up' }] } })
  })
})

describe('CC-1 / CC-2 — the AI Goal launch links Amazon\'s auto groups and answers every campaign', () => {
  it('auto groups get the evidence bids through the link (nothing POSTed); `launch` lists both scaffold campaigns', async () => {
    const goal = await inside(() => db().adProductGoal.create({ data: { name: 'W2A goal', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 2000, marketplace: 'IT', products: [{ sku: 'TEST-SKU-1' }] as never } }))
    const { materializeProductGoal } = await import('./ai-goal-materialize.service.js')
    const out = await inside(() => materializeProductGoal(goal.id, 'user:u-w2a'))
    expect(amz.calls).not.toContain('targetingClauses')
    expect(out.launch).toMatchObject({ ok: true, asked: 2, live: 2 })
    const auto = out.launch.campaigns.find((c) => c.name.endsWith('Auto'))!
    expect(auto.made.autoTargeting).toBe(4)
    // Close match sits at the ad group's default bid (nothing to send); the other three get their own.
    expect(amz.targetUpdates).toHaveLength(3)
    expect(amz.targetUpdates.every((u) => u.kind === 'AUTO' && typeof u.patch.bid === 'number' && u.patch.state === undefined)).toBe(true)
  })
})

describe('CC-17 / CC-1 — the read-back checks auto groups by expression, negatives and placements (launch only)', () => {
  it('reports what Amazon really serves, and the reconcile scope is unchanged', async () => {
    await inside(async () => {
      await db().campaign.create({ data: { id: 'c-v', name: 'Verify me', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-v', dailyBudget: '10.00', startDate: new Date(), dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] } as never } })
      await db().adGroup.create({ data: { id: 'g-v', campaignId: 'c-v', name: 'Verify group', externalAdGroupId: 'EXT-g-v', defaultBidCents: 75 } })
      // Linked and right; not linked (no id) but Nexus says paused — Amazon serves it enabled at the default bid.
      await db().adTarget.create({ data: { id: 't-v-close', adGroupId: 'g-v', kind: 'AUTO', expressionType: 'AUTO', expressionValue: 'CLOSE_MATCH', externalTargetId: 'AUTO-V-CLOSE', status: 'ENABLED', bidCents: 75 } })
      await db().adTarget.create({ data: { id: 't-v-loose', adGroupId: 'g-v', kind: 'AUTO', expressionType: 'AUTO', expressionValue: 'LOOSE_MATCH', status: 'PAUSED', bidCents: 49 } })
      await db().adTarget.create({ data: { id: 't-v-neg', adGroupId: 'g-v', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'cheap', externalTargetId: 'NK-V', isNegative: true, negativeLevel: 'AD_GROUP', bidCents: 0 } })
      await db().adTarget.create({ data: { id: 't-v-negasin', adGroupId: 'g-v', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0TESTNEG9', isNegative: true, negativeLevel: 'AD_GROUP', bidCents: 0 } })
    })
    amz.lists.campaigns = [{ campaignId: 'EXT-c-v', name: 'Verify me', state: 'ENABLED', budget: { budget: 10 }, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] } }]
    amz.lists.adGroups = [{ adGroupId: 'EXT-g-v', name: 'Verify group', state: 'ENABLED', defaultBid: 0.75 }]
    amz.lists.targets = [
      { targetId: 'AUTO-V-CLOSE', adGroupId: 'EXT-g-v', expressionType: 'AUTO', state: 'ENABLED', expression: [{ type: 'QUERY_HIGH_REL_MATCHES' }] },
      { targetId: 'AUTO-V-LOOSE', adGroupId: 'EXT-g-v', expressionType: 'AUTO', state: 'ENABLED', expression: [{ type: 'QUERY_BROAD_REL_MATCHES' }] },
    ]
    amz.lists.negKeywords = [{ keywordId: 'NK-V', adGroupId: 'EXT-g-v', keywordText: 'cheap', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }]
    const { verifyLaunch } = await import('./ads-launch-verify.service.js')
    const v = await inside(() => verifyLaunch(['c-v']))
    const by = (id: string) => v.entities.find((e) => e.localId === id)
    expect(by('t-v-close')).toMatchObject({ entityType: 'TARGET', label: 'Close match (auto)', verdict: 'VERIFIED' })
    expect(by('t-v-loose')).toMatchObject({ verdict: 'MISMATCH', externalId: 'AUTO-V-LOOSE', deltas: [{ field: 'state', intended: 'paused', observed: 'enabled' }, { field: 'bid', intended: '0.49', observed: '0.75' }] })
    expect(by('t-v-neg')).toMatchObject({ entityType: 'NEGATIVE_KEYWORD', verdict: 'VERIFIED' })
    expect(by('t-v-negasin')).toMatchObject({ entityType: 'NEGATIVE_TARGET', verdict: 'NOT_PUSHED' })
    expect(v.entities.find((e) => e.entityType === 'PLACEMENT')).toMatchObject({ localId: 'c-v', verdict: 'MISMATCH', deltas: [{ field: 'PLACEMENT_TOP', intended: '50', observed: '0' }] })
    expect(v.ok).toBe(false)

    const r = await inside(() => verifyLaunch(['c-v'], 'RECONCILE'))
    expect(r.entities.map((e) => e.entityType).sort()).toEqual(['AD_GROUP', 'CAMPAIGN'])
  })
})

describe('CC-1 — Replicate keeps working, through the same auto-group link', () => {
  it('a floored replica of an Auto campaign links Amazon\'s groups (no POST), remembers each planned bid, and stays APPLIED', async () => {
    const autoTarget = (clause: string, type: string, bidCents: number) => ({ kind: 'AUTO', expressionType: type, expression: '', bidCents, isNegative: false, negativeLevel: null, targetClass: 'AUTO', autoClause: clause })
    const doc = {
      version: 1, productToken: 'TESTJACKET', sharedTargets: [],
      stats: { campaigns: 1, adGroups: 1, positives: 2, negatives: 0, productAds: 1, byClass: { BRAND: 0, CATEGORY: 0, COMPETITOR: 0, ASIN: 0, AUTO: 2, UNKNOWN: 0 }, orphanedInSource: 0 },
      campaigns: [{
        role: 'Auto', namePattern: '{{product}} - W2A replica - Auto', dailyBudget: 5, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [], targetingType: 'AUTO',
        adGroups: [{ namePattern: '{{product}} auto group', defaultBidCents: 60, productAdCount: 1, targets: [autoTarget('CLOSE_MATCH', 'SEARCH_CLOSE_MATCH', 70), autoTarget('LOOSE_MATCH', 'SEARCH_LOOSE_MATCH', 40)] }],
      }],
    }
    const bp = await inside(() => db().adBlueprint.create({ data: { name: 'W2A replica', marketplace: 'IT', productToken: 'TESTJACKET', doc: doc as never } }))
    const { applyBlueprint } = await import('./ads-blueprint-apply.service.js')
    const out = await inside(() => applyBlueprint({ blueprintId: bp.id, target: { productToken: 'TESTJACKET', asins: ['TEST-SKU-1'] }, marketplace: 'IT', dryRun: false, actor: 'user:u-w2a' }))
    expect(amz.calls).not.toContain('targetingClauses')
    expect(out.errors.filter((e) => e.startsWith('auto clause'))).toEqual([])
    expect(out.created.targets).toBe(2)
    const campaignId = out.created.campaigns ? (await inside(() => db().campaign.findFirstOrThrow({ where: { name: 'TESTJACKET - W2A replica - Auto' }, select: { id: true } }))).id : ''
    const rows = await inside(() => db().adTarget.findMany({ where: { kind: 'AUTO', adGroup: { campaignId } }, orderBy: { expressionValue: 'asc' }, select: { expressionValue: true, externalTargetId: true, bidCents: true, suppressedFromBidCents: true } }))
    // Floor launch: the ad group and every group serve at the 2¢ floor (Amazon's group already has it: nothing sent);
    // each planned bid is remembered for the raise.
    expect(rows).toEqual([
      { expressionValue: 'CLOSE_MATCH', externalTargetId: expect.stringMatching(/^AUTO-/), bidCents: 2, suppressedFromBidCents: 70 },
      { expressionValue: 'COMPLEMENTS', externalTargetId: expect.stringMatching(/^AUTO-/), bidCents: 2, suppressedFromBidCents: null },
      { expressionValue: 'LOOSE_MATCH', externalTargetId: expect.stringMatching(/^AUTO-/), bidCents: 2, suppressedFromBidCents: 40 },
      { expressionValue: 'SUBSTITUTES', externalTargetId: expect.stringMatching(/^AUTO-/), bidCents: 2, suppressedFromBidCents: null },
    ])
  })
})
