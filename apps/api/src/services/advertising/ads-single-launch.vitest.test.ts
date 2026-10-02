/**
 * MCP full control A11 — the Single Campaign builder launch, moved out of advertising.routes.ts into
 * ads-single-launch.service.ts. Proven here on PGlite (production schema; sandbox, so nothing leaves Nexus):
 *
 *   route parity   `POST /advertising/campaign-builder/single/launch` answers exactly what `singleLaunch` returns, and
 *                  both leave the same rows behind (campaign, ad group, product ads, keywords, targets, negatives,
 *                  rules, audit) — for a missing name, a dry run, a keyword launch with every option, a product launch.
 *   born suppressed  create-ad-campaign's option: the campaign is created ENABLED (never paused) and flagged as
 *                  suppressed by the person who asked; every bid above the floor starts at the floor with the bid asked
 *                  for remembered, exactly as suppressCampaignBids would leave it, so restoreCampaignBids puts them back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('./ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

import { singleLaunch, type SingleLaunchBody } from './ads-single-launch.service.js'
import { restoreCampaignBids } from './ads-bid-suppression.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance

/** Generated ids, sandbox Amazon ids, times and the two campaign names are not part of what is compared. */
const norm = (text: string) => text
  .replace(/c[a-z0-9]{24}/g, 'ID').replace(/sb-[a-z]+-[0-9a-f]{8}/g, 'SANDBOX-ID').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'TIME')
  .replace(/(route|service)-\d/g, 'NAME')
const IGNORED = new Set(['id', 'campaignId', 'adGroupId', 'entityId', 'createdAt', 'updatedAt', 'startDate', 'workspaceId'])
async function rowsOf(name: string) {
  return inside(async () => {
    const db = database.client
    const camp = await db.campaign.findFirst({ where: { name }, include: { adGroups: { include: { targets: { orderBy: { expressionValue: 'asc' } }, productAds: true } } } })
    const rules = await db.automationRule.findMany({ where: { name: { startsWith: name } }, orderBy: { name: 'asc' } })
    const ids = camp ? [camp.id, ...camp.adGroups.flatMap((g: { id: string; targets: Array<{ id: string }>; productAds: Array<{ id: string }> }) => [g.id, ...g.targets.map((t) => t.id), ...g.productAds.map((a) => a.id)])] : []
    const logs = await db.advertisingActionLog.findMany({ where: { entityId: { in: ids } }, orderBy: [{ actionType: 'asc' }, { createdAt: 'asc' }] })
    const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (k, v) => (IGNORED.has(k) ? undefined : v)))
    return norm(JSON.stringify(strip({ camp, rules, logs: logs.map((l: { actionType: string; userId: string | null; amazonResponseStatus: string; payloadAfter: unknown }) => ({ a: l.actionType, u: l.userId, s: l.amazonResponseStatus, after: l.payloadAfter })) })))
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: '99.00' } })
    // The markets' own currencies (Marketplace.currency): a campaign is labelled with its market's.
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR']]) {
      await database.client.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
    await database.client.automationRule.create({ data: { id: 'rule-attach', name: 'Attach me', domain: 'advertising', trigger: 'SCHEDULE', conditions: [] as never, actions: [{ type: 'bid_down', campaignIds: ['x'] }] as never, enabled: false, dryRun: true, maxExecutionsPerDay: 1 } })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: routes } = await import('../../routes/advertising.routes.js')
  await app.register(routes)
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)

const BODIES: Array<[string, (name: string) => SingleLaunchBody]> = [
  ['a missing name', () => ({ market: 'IT' })],
  ['a dry run', (name) => ({ market: 'IT', name, dryRun: true, keywords: [{ text: 'a' }] })],
  ['keywords with every option: negatives, placements, boosts, a bid rule, a negative rule, an attached rule', (name) => ({
    market: 'IT', name, adGroupName: 'grp', biddingStrategy: 'updown', sites: 'business', placementBids: { tos: '50', pdp: '10' },
    bidBoosts: { video: true, amazonBusinessPct: '5' }, products: [{ sku: 'TEST-SKU-1' }], sponsoredVideoAsins: ['B0TESTVID1'], budgetEur: 12.5, defaultBidEur: 0.6,
    bidConfig: { strategy: 'targetAcos', targetAcos: '25', minBid: '0.2', maxBid: '1.5' },
    keywords: [{ text: 'race jacket', matchType: 'EXACT', bidEur: 0.9 }, { text: 'moto jacket', matchType: 'PHRASE' }, { text: 'jacket' }],
    negKeywords: [{ text: 'cheap', matchType: 'PHRASE' }, { text: 'free' }], negProducts: [{ asin: 'B0TESTNEG1' }],
    addNegativeRule: true, attachRuleIds: ['rule-attach'], autoBidAdjust: true,
  })],
  ['product targets', (name) => ({ market: 'UK', name, targetMode: 'product', productTargets: [{ asin: 'B0TESTPT01' }, { sku: 'TEST-SKU-1' }], biddingStrategy: 'fixed' })],
]

describe('A11 — the route answers what singleLaunch returns', () => {
  BODIES.forEach(([label, body], i) => {
    it(label, async () => {
      const viaRoute = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: body(`route-${i}`), headers: { 'x-actor-id': 'u-parity' } })
      const viaService = await inside(() => singleLaunch(body(`service-${i}`), 'user:u-parity' as never))
      expect(viaRoute.statusCode).toBe(viaService.status)
      expect(norm(viaRoute.payload)).toBe(norm(JSON.stringify(viaService.body)))
      expect(await rowsOf(`route-${i}`)).toBe(await rowsOf(`service-${i}`))
    })
  })
})

describe('A11 — born suppressed (create-ad-campaign only)', () => {
  it('creates the campaign ENABLED and flagged, every bid above the floor at the floor with the bid asked for remembered; restore puts them back', async () => {
    const out = await inside(() => singleLaunch({
      market: 'UK', name: 'Born low', biddingStrategy: 'down', products: [{ sku: 'TEST-SKU-1' }], budgetEur: 8, defaultBidEur: 0.5,
      keywords: [{ text: 'winter gloves', matchType: 'EXACT', bidEur: 0.8 }, { text: 'gloves', matchType: 'BROAD' }, { text: 'tiny bid', matchType: 'PHRASE', bidEur: 0.01 }],
      negKeywords: [{ text: 'free' }],
    }, 'user:u-approver' as never, { bornSuppressed: { floorCents: 2, by: 'user:u-asker' as never }, currency: 'GBP' }))
    expect(out.status).toBe(200)
    const campaignId = String(out.body.campaignId)
    const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: campaignId } }))
    expect(camp).toMatchObject({ status: 'ENABLED', liveBidWritesEnabled: false, dailyBudgetCurrency: 'GBP', bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'user:u-asker' })
    expect(camp.bidsSuppressedAt).toBeInstanceOf(Date)
    const group = await inside(() => database.client.adGroup.findFirstOrThrow({ where: { campaignId }, include: { targets: { orderBy: { expressionValue: 'asc' } } } }))
    expect([group.defaultBidCents, group.suppressedFromBidCents]).toEqual([2, 50])
    expect(group.targets.map((t: { expressionValue: string; bidCents: number; suppressedFromBidCents: number | null; isNegative: boolean }) => [t.expressionValue, t.bidCents, t.suppressedFromBidCents, t.isNegative])).toEqual([
      ['free', 0, null, true],
      ['gloves', 2, 50, false],
      ['tiny bid', 1, null, false],
      ['winter gloves', 2, 80, false],
    ])
    expect(await inside(() => restoreCampaignBids(campaignId, { actor: 'user:u-approver' as never }))).toBe(3)
    const after = await inside(() => database.client.adTarget.findMany({ where: { adGroupId: group.id, isNegative: false }, orderBy: { expressionValue: 'asc' }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(after).toEqual([{ bidCents: 50, suppressedFromBidCents: null }, { bidCents: 1, suppressedFromBidCents: null }, { bidCents: 80, suppressedFromBidCents: null }])
    expect((await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: campaignId } }))).bidsSuppressedAt).toBeNull()
  })

  it('without the option nothing is floored or flagged (the route\'s launch)', async () => {
    const out = await inside(() => singleLaunch({ market: 'UK', name: 'Plain launch', keywords: [{ text: 'plain', bidEur: 0.8 }] }, 'user:u-approver' as never))
    const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: String(out.body.campaignId) }, include: { adGroups: { include: { targets: true } } } }))
    expect(camp).toMatchObject({ bidsSuppressedAt: null, bidsSuppressedBy: null })
    expect(camp.adGroups[0]).toMatchObject({ defaultBidCents: 75, suppressedFromBidCents: null, targets: [expect.objectContaining({ bidCents: 80, suppressedFromBidCents: null })] })
  })
})

describe('a new campaign is labelled with its market\'s currency (it was EUR for every market)', () => {
  it('the builder route labels a UK campaign GBP and an IT one EUR; Amazon reads the budget in the market\'s currency', async () => {
    for (const [market, currency] of [['UK', 'GBP'], ['IT', 'EUR'], ['DE', 'EUR']]) {
      const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market, name: `Currency ${market}`, budgetEur: 12, keywords: [{ text: 'gloves' }] } })
      expect(res.statusCode).toBe(200)
      const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: String(JSON.parse(res.payload).campaignId) } }))
      expect([market, camp.dailyBudgetCurrency, String(camp.dailyBudget)]).toEqual([market, currency, '12'])
    }
  })
})
