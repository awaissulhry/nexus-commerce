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
  ['product targets', (name) => ({ market: 'UK', name, targetMode: 'product', products: [{ sku: 'TEST-SKU-1' }], productTargets: [{ asin: 'B0TESTPT01' }, { sku: 'TEST-SKU-1' }], biddingStrategy: 'fixed' })],
]

describe('A11 — the route answers what singleLaunch returns', () => {
  BODIES.forEach(([label, body], i) => {
    it(label, async () => {
      const viaRoute = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: body(`route-${i}`), headers: { 'x-actor-id': 'u-parity' } })
      // CC-7 — the route's launch is the screen's: on the live-write allowlist at birth.
      const viaService = await inside(() => singleLaunch(body(`service-${i}`), 'user:u-parity' as never, { allowlistAtBirth: true }))
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
    const out = await inside(() => singleLaunch({ market: 'UK', name: 'Plain launch', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'plain', bidEur: 0.8 }] }, 'user:u-approver' as never))
    const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: String(out.body.campaignId) }, include: { adGroups: { include: { targets: true } } } }))
    expect(camp).toMatchObject({ bidsSuppressedAt: null, bidsSuppressedBy: null })
    expect(camp.adGroups[0]).toMatchObject({ defaultBidCents: 75, suppressedFromBidCents: null, targets: [expect.objectContaining({ bidCents: 80, suppressedFromBidCents: null })] })
  })
})

describe('a new campaign is labelled with its market\'s currency (it was EUR for every market)', () => {
  it('the builder route labels a UK campaign GBP and an IT one EUR; Amazon reads the budget in the market\'s currency', async () => {
    for (const [market, currency] of [['UK', 'GBP'], ['IT', 'EUR'], ['DE', 'EUR']]) {
      const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market, name: `Currency ${market}`, budgetEur: 12, products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'gloves' }] } })
      expect(res.statusCode).toBe(200)
      const camp = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: String(JSON.parse(res.payload).campaignId) } }))
      expect([market, camp.dailyBudgetCurrency, String(camp.dailyBudget)]).toEqual([market, currency, '12'])
    }
  })
})

const campaignNamed = (name: string) => inside(() => database.client.campaign.findFirst({ where: { name }, select: { id: true, liveBidWritesEnabled: true } }))

describe('CC-7 — the Single builder\'s campaign is on the live-write allowlist at birth, like every other builder\'s', () => {
  it('the screen\'s route: allowlisted, and the answer says so and what became of the placement multipliers', async () => {
    const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: {
      market: 'IT', name: 'CC7 screen', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'cc7 jacket' }], placementBids: { tos: '40' },
    } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ ok: true, liveWrites: true, placement: { mode: 'sandbox', sent: false } })
    expect(await campaignNamed('CC7 screen')).toMatchObject({ liveBidWritesEnabled: true })
  })

  it('create-ad-campaign (the same service, no option): still born off the allowlist until a person approves it', async () => {
    const out = await inside(() => singleLaunch({ market: 'UK', name: 'CC7 claude', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'cc7 claude' }] }, 'user:u-approver' as never, { bornSuppressed: { floorCents: 2, by: 'user:u-asker' as never } }))
    expect(out).toMatchObject({ status: 200, body: { liveWrites: false } })
    expect(await campaignNamed('CC7 claude')).toMatchObject({ liveBidWritesEnabled: false })
  })
})

describe('CC-21 — a launch that cannot serve is refused before anything is created', () => {
  const launch = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market: 'IT', ...payload } })

  it('no products: 400 with the reason, no campaign', async () => {
    const res = await launch({ name: 'CC21 no products', keywords: [{ text: 'gloves' }] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toMatchObject({ ok: false, refusals: [expect.stringMatching(/^A campaign needs at least one product/)] })
    expect(await campaignNamed('CC21 no products')).toBeNull()
  })

  it('a manual keyword campaign with no keywords, or a product-targeting one with no targets: 400, no campaign', async () => {
    const noKw = await launch({ name: 'CC21 no keywords', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: '   ' }] })
    expect(noKw.statusCode).toBe(400)
    expect(JSON.parse(noKw.payload).error).toMatch(/needs at least one keyword/)
    const noPt = await launch({ name: 'CC21 no targets', products: [{ sku: 'TEST-SKU-1' }], targetMode: 'product', productTargets: [] })
    expect(noPt.statusCode).toBe(400)
    expect(JSON.parse(noPt.payload).error).toMatch(/needs at least one product to target/)
    expect(await campaignNamed('CC21 no keywords')).toBeNull()
    expect(await campaignNamed('CC21 no targets')).toBeNull()
  })

  it('the review step\'s dry run answers the same refusals, and creates nothing', async () => {
    const res = await launch({ name: 'CC21 preview', dryRun: true })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toMatchObject({ ok: true, dryRun: true })
    expect(body.checks.refusals).toEqual([expect.stringMatching(/at least one product/), expect.stringMatching(/at least one keyword/)])
    expect(await campaignNamed('CC21 preview')).toBeNull()
  })
})

describe('CC-13 / CC-24 — one campaign per name in a market', () => {
  it('a second launch with a name the market already uses is refused, whatever its case; nothing is created twice', async () => {
    const body = { market: 'IT', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'name check' }] }
    const first = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { ...body, name: 'CC13 Taken' } })
    expect(first.statusCode).toBe(200)
    const again = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { ...body, name: '  cc13 taken ' } })
    expect(again.statusCode).toBe(400)
    expect(JSON.parse(again.payload).error).toMatch(/IT already has a campaign named "CC13 Taken"/)
    expect(await inside(() => database.client.campaign.count({ where: { name: { equals: 'cc13 taken', mode: 'insensitive' } } }))).toBe(1)
  })

  it('a name with the middle dot Amazon refuses is refused before launch', async () => {
    const res = await app.inject({ method: 'POST', url: '/advertising/campaign-builder/single/launch', payload: { market: 'IT', name: 'Gloves · Exact', products: [{ sku: 'TEST-SKU-1' }], keywords: [{ text: 'dot' }] } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toMatch(/contains "·", which Amazon refuses in names/)
  })
})

describe('SP Super Wizard / Quick / Guided — the same checks on their shared launch route', () => {
  const spw = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/advertising/campaign-builder/sp-super-wizard/launch', payload: { market: 'IT', ...payload } })
  const camp = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, name, kind: 'auto', bidEur: 0.5, budgetEur: 10, autoGroups: [], ...extra })

  it('🔴 CC-21 — no products: 400 with the reason, and no campaign is created (it was created ENABLED, unable to serve)', async () => {
    const res = await spw({ productGroupName: 'SPW empty', campaigns: [camp('SPW empty - SP - Auto')] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toMatch(/^A campaign needs at least one product/)
    expect(await campaignNamed('SPW empty - SP - Auto')).toBeNull()
  })

  it('CC-13 — two campaigns of one launch with one name are refused before anything is created', async () => {
    const res = await spw({ products: [{ sku: 'TEST-SKU-1' }], campaigns: [camp('SPW Twin'), camp('spw twin', { kind: 'keyword' })] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).refusals).toEqual([expect.stringMatching(/^Two campaigns in this launch are named "SPW Twin"/)])
    expect(await campaignNamed('SPW Twin')).toBeNull()
  })

  it('the review step\'s dry run answers the checks and creates nothing', async () => {
    const res = await spw({ dryRun: true, products: [{ sku: 'TEST-SKU-1' }], campaigns: [camp('SPW preview', { bidEur: 0.01 })] })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).checks).toEqual({ refusals: [expect.stringMatching(/bid of €0\.01 is below Amazon's minimum of €0\.02 in IT/)], warnings: [] })
    expect(await campaignNamed('SPW preview')).toBeNull()
  })
})

describe('CM-33 / CC-24 — every create route is a keyed command (one launch click, one run)', () => {
  it('the launch, goal and add routes honour an Idempotency-Key', async () => {
    const { COMMAND_SCOPE_ROUTES } = await import('../../lib/command-idempotency.js')
    expect(COMMAND_SCOPE_ROUTES).toEqual(expect.arrayContaining([
      '/api/advertising/campaign-builder/sp-super-wizard/launch', '/api/advertising/campaign-builder/single/launch',
      '/api/advertising/ai-goals', '/api/advertising/ai-goals/:id/materialize', '/api/advertising/blueprints/replicate',
      '/api/advertising/campaigns/create', '/api/advertising/adgroups/create', '/api/advertising/keywords/create',
      '/api/advertising/product-ads/create', '/api/advertising/targets/create', '/api/advertising/negative-targets/create',
      '/api/advertising/negative-keywords', '/api/advertising/sb-creatives/create',
    ]))
  })
})
