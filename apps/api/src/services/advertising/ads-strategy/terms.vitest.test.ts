/**
 * ADS AUTONOMY W1-7 — the strategy's search-term thresholds and its protected products, read by the engines, on a real
 * PostgreSQL with the production schema and every business policy (PGlite), business profiles ON, two businesses.
 * Values are made up (public repo).
 *
 *   terms        each ad group's harvest and negate groups (its products together; the market row for an ad group
 *                Nexus does not know); a market without a group is left out; the windows in play
 *   preview      a caller naming no numbers gets the strategy's groups, each over its own window, and the defaults
 *                elsewhere; a caller naming its own keeps them WHOLE; the harvest bar is asked first
 *   protect      a protected product's ASIN is never a negative candidate and is refused by every writer (the gate,
 *                the negative write service, the wire), a person's own add included; another business's protection
 *                does not leak; an unknown market binds every market's protection; an opt-out wins over a category
 *   page         the Keyword Harvest read: the stricter of the saved policy and the strategy, whole; one market only
 *   rules        harvest_and_negate without its own numbers reads the strategy, with them keeps its own; the stop rules
 *                (pause, archive, floor) skip a protected product's keyword; the optimiser holds its zero-sales cut
 *   feed         recommendations name the strategy's window and row
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
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

import { harvestForScope, openTermsStrategy, protectedAdGroups, protectedAsinRefusal, protectedAsins, termsForAdGroups } from './terms.js'
import { previewHarvest } from '../ads-harvest.service.js'
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { negativeWireRefusal } from '../ads-negation-policy.js'
import { writeNegativeProductTarget } from '../ads-negative-kw.service.js'
import { getKeywordHarvest } from '../keyword-harvest.service.js'
import { previewBidOptimization } from '../ads-bid-optimizer.service.js'

const A = 'w1_terms_alpha'
const B = 'w1_terms_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { leaf: '', parent: '', v1: '', v2: '', q: '', r: '', c1: '', c2: '', g1: '', g2: '', g3: '', g4: '', t1: '', t2: '', tZero1: '', tZero2: '', tSells1: '' }
const daysAgo = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d }
const queries = (list: Array<{ query: string }>) => list.map((c) => c.query).sort()

type Run = { ok: boolean; output?: Record<string, any> }
const handler = async (type: string, action: Record<string, unknown>, context: Record<string, unknown> = {}, dryRun = true): Promise<Run> => {
  const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
  return inA(() => ACTION_HANDLERS[type]({ type, ...action }, context, { dryRun, ruleId: 'tstrule-w17' })) as Promise<Run>
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await import('../automation-action-handlers.js')
  await inA(async () => {
    const c = db()
    const top = (await c.category.create({ data: { slug: 'w17-top', name: { en: { name: 'Test top' }, it: {} } } })).id
    ids.leaf = (await c.category.create({ data: { slug: 'w17-leaf', parentId: top, depth: 1, name: { en: { name: 'Test leaf' }, it: {} } } })).id
    await c.categoryClosure.createMany({ data: [
      { ancestorId: top, descendantId: top, depth: 0 }, { ancestorId: ids.leaf, descendantId: ids.leaf, depth: 0 }, { ancestorId: top, descendantId: ids.leaf, depth: 1 },
    ] })
    ids.parent = (await c.product.create({ data: { sku: 'TEST-T-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v1 = (await c.product.create({ data: { sku: 'TEST-T-V1', name: 'Test variation one', basePrice: '10.00', parentId: ids.parent, amazonAsin: 'B0TESTV001' } })).id
    ids.v2 = (await c.product.create({ data: { sku: 'TEST-T-V2', name: 'Test variation two', basePrice: '10.00', parentId: ids.parent, amazonAsin: 'B0TESTV002' } })).id
    ids.q = (await c.product.create({ data: { sku: 'TEST-T-Q', name: 'Test standalone', basePrice: '10.00', amazonAsin: 'B0TESTQ001' } })).id
    ids.r = (await c.product.create({ data: { sku: 'TEST-T-R', name: 'Test plain', basePrice: '10.00', amazonAsin: 'B0TESTR001' } })).id
    await c.productCategory.create({ data: { productId: ids.parent, categoryId: ids.leaf, isPrimary: true } })

    // The Keyword Harvest read serves the markets whose Amazon Ads account Nexus reads.
    await c.amazonAdsConnection.create({ data: { profileId: 'P-TEST-IT', marketplace: 'IT', isActive: true } })
    const campaign = (name: string, marketplace: string, externalCampaignId: string) =>
      c.campaign.create({ data: { name, type: 'SP', marketplace, dailyBudget: '10.00', startDate: new Date(), externalCampaignId, targetingType: 'MANUAL', adProduct: 'SPONSORED_PRODUCTS' } as never })
    const adGroup = (campaignId: string, name: string, externalAdGroupId: string) => c.adGroup.create({ data: { campaignId, name, externalAdGroupId } as never })
    ids.c1 = (await campaign('Test terms one', 'IT', 'TC1')).id
    ids.g1 = (await adGroup(ids.c1, 'Test group V', 'TG1')).id
    ids.g2 = (await adGroup(ids.c1, 'Test group R', 'TG2')).id
    ids.c2 = (await campaign('Test terms two', 'IT', 'TC2')).id
    ids.g3 = (await adGroup(ids.c2, 'Test group Q', 'TG3')).id
    const c3 = (await campaign('Test terms DE', 'DE', 'TC3')).id
    ids.g4 = (await adGroup(c3, 'Test group DE', 'TG4')).id
    await c.adProductAd.createMany({ data: [
      { adGroupId: ids.g1, productId: ids.v1, asin: 'B0TESTV001' }, { adGroupId: ids.g2, productId: ids.r, asin: 'B0TESTR001' },
      { adGroupId: ids.g3, productId: ids.q, asin: 'B0TESTQ001' }, { adGroupId: ids.g4, productId: ids.r, asin: 'B0TESTR001' },
    ] })
    const target = (adGroupId: string, value: string, extra: object = {}) =>
      c.adTarget.create({ data: { adGroupId, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: value, bidCents: 80, ...extra } })
    ids.t1 = (await target(ids.g1, 'test keyword v')).id
    ids.t2 = (await target(ids.g2, 'test keyword r')).id
    // The optimiser's view (legacy columns): no sales in a protected ad group, the same unprotected, sales protected.
    ids.tZero1 = (await target(ids.g1, 'test spender v', { spendCents: 500, clicks: 10 })).id
    ids.tZero2 = (await target(ids.g2, 'test spender r', { spendCents: 500, clicks: 10 })).id
    ids.tSells1 = (await target(ids.g1, 'test seller v', { spendCents: 500, salesCents: 1000, clicks: 10, ordersCount: 1 })).id

    const strategy = (level: string, scopeId: string, label: string, set: object) =>
      c.adsStrategy.create({ data: { market: 'IT', level, scopeId, label, updatedBy: 'user:test', ...set } })
    await strategy('MARKET', '*', 'Test market (IT)', {
      harvestMinOrders: 3, harvestMinClicks: 5, harvestMaxAcosPct: 40, harvestWindowDays: 30,
      negateMinClicks: 10, negateMinSpendCents: 500, negateMaxOrders: 0, negateWindowDays: 30,
    })
    await strategy('CATEGORY', ids.leaf, 'Test leaf (IT)', { protect: true })
    await strategy('PRODUCT', ids.v2, 'TEST-T-V2 (IT)', { protect: false })
    await strategy('PRODUCT', ids.q, 'TEST-T-Q (IT)', {
      harvestMinOrders: 4, harvestMinClicks: 0, harvestWindowDays: 90,
      negateMinClicks: 20, negateMinSpendCents: 2000, negateMaxOrders: 1, negateWindowDays: 90,
    })

    const term = (query: string, campaignId: string, adGroupId: string, ago: number, m: { clicks: number; cost: number; orders?: number; sales?: number }, marketplace = 'IT') =>
      c.amazonAdsSearchTerm.create({ data: {
        profileId: 'P-TEST', marketplace, adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(ago), campaignId, adGroupId, matchType: 'BROAD', query,
        impressions: 100, clicks: m.clicks, costMicros: BigInt(m.cost) * 10_000n, currencyCode: 'EUR', orders7d: m.orders ?? 0, sales7dCents: m.sales ?? 0,
      } })
    await term('alpha jacket', 'TC1', 'TG2', 10, { clicks: 6, cost: 300, orders: 3, sales: 3000 })
    await term('beta gloves', 'TC1', 'TG2', 10, { clicks: 6, cost: 200, orders: 2, sales: 2000 })
    await term('gamma boots', 'TC1', 'TG2', 10, { clicks: 12, cost: 600 })
    await term('eta visor', 'TC1', 'TG1', 10, { clicks: 5, cost: 300, orders: 3, sales: 3000 })
    await term('delta helmet', 'TC2', 'TG3', 45, { clicks: 3, cost: 400, orders: 2, sales: 4000 })
    await term('delta helmet', 'TC2', 'TG3', 80, { clicks: 3, cost: 400, orders: 2, sales: 4000 })
    await term('epsilon pants', 'TCX', 'TGX', 10, { clicks: 11, cost: 700 })
    await term('zeta coat', 'TC3', 'TG4', 10, { clicks: 12, cost: 700 }, 'DE')
    await term('b0testv001', 'TC1', 'TG2', 10, { clicks: 12, cost: 1600 })
    await term('b0testr001', 'TC1', 'TG2', 10, { clicks: 12, cost: 1600 })
    await term('b0testv002', 'TC1', 'TG2', 10, { clicks: 12, cost: 1600 })
  })
  await inB(async () => {
    const c = db()
    const own = (await c.product.create({ data: { sku: 'BRAVO-T-R', name: 'BRAVO product', basePrice: '10.00', amazonAsin: 'B0TESTR001' } })).id
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: own, label: 'BRAVO-T-R (IT)', protect: true, updatedBy: 'user:bravo' } })
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('thresholds per ad group', () => {
  it('each ad group takes its products\' groups whole; an unknown ad group its market\'s; a market without a group is left out', async () => {
    await inA(async () => {
      const strategy = (await openTermsStrategy())!
      expect([...strategy.views.keys()]).toEqual(['IT'])
      expect(strategy.windows).toEqual([30, 90])
      const terms = await termsForAdGroups(strategy, [
        { market: 'IT', externalAdGroupId: 'TG2' }, { market: 'it', externalAdGroupId: 'TG3' }, { market: 'IT', externalAdGroupId: 'TGX' }, { market: 'DE', externalAdGroupId: 'TG4' },
      ])
      expect(terms.get('IT|TG2')).toMatchObject({
        harvest: { group: { minOrders: 3, minClicks: 5, maxAcosPct: 40, windowDays: 30 }, source: { level: 'market', label: 'Test market (IT)' } },
        negate: { group: { minClicks: 10, minSpendCents: 500, maxOrders: 0, windowDays: 30 } },
      })
      expect(terms.get('IT|TG3')).toMatchObject({
        harvest: { group: { minOrders: 4, minClicks: 0, maxAcosPct: null, windowDays: 90 }, source: { level: 'product', label: 'TEST-T-Q (IT)' } },
        negate: { group: { minClicks: 20, minSpendCents: 2000, maxOrders: 1, windowDays: 90 } },
      })
      expect(terms.get('IT|TGX')?.harvest?.source).toMatchObject({ level: 'market' })
      expect(terms.has('DE|TG4')).toBe(false)
    })
  })

  it('another business without a group answers nothing', async () => {
    expect(await inB(() => openTermsStrategy())).toBeNull()
  })

  it('one subject for a page: an ad group, campaigns (the stricter across them), the market\'s own row', async () => {
    await inA(async () => {
      expect(await harvestForScope('IT', {})).toMatchObject({ group: { minOrders: 3 }, source: { level: 'market' } })
      expect(await harvestForScope('IT', { campaignIds: [ids.c1, ids.c2] })).toMatchObject({ group: { minOrders: 4, windowDays: 90 }, source: { level: 'product' } })
      expect(await harvestForScope('IT', { adGroupId: ids.g2 })).toMatchObject({ group: { minOrders: 3 } })
      expect(await harvestForScope('DE', {})).toBeNull()
    })
  })
})

describe('the harvest preview', () => {
  it('a caller naming no numbers: the strategy\'s groups over their own windows, the defaults elsewhere, protected ASINs held', async () => {
    const p = await inA(() => previewHarvest({ defaults: { windowDays: 60, minSpendCents: 1000, minOrders: 2 } }))
    expect(p.criteria).toMatchObject({ from: 'strategy', defaults: { windowDays: 60, minSpendCents: 1000, minOrders: 2 } })
    expect(queries(p.graduations)).toEqual(['alpha jacket', 'delta helmet', 'eta visor'])
    expect(p.graduations.find((g) => g.query === 'delta helmet')).toMatchObject({ orders: 4, strategy: { windowDays: 90, level: 'product', label: 'TEST-T-Q (IT)', version: 1 } })
    expect(p.graduations.find((g) => g.query === 'alpha jacket')).toMatchObject({ market: 'IT', strategy: { windowDays: 30, level: 'market' } })
    // 2 orders: under the strategy's 3, though over the defaults' 2. 600 and 700 of spend: over the strategy's 500.
    expect(queries(p.negatives)).toEqual(['epsilon pants', 'gamma boots'])
    expect(queries(p.productNegatives)).toEqual(['b0testr001', 'b0testv002'])
    expect(p.protectedAsins).toHaveLength(1)
    expect(p.protectedAsins[0]).toMatchObject({ query: 'b0testv001', reason: expect.stringMatching(/^TEST-T-V1 is protected by the ads strategy in IT \(Test leaf \(IT\), version 1/) })
    expect(p.criteria.strategy.find((s) => s.group === 'negate' && s.source.level === 'market')).toMatchObject({ thresholds: { minSpendCents: 500 }, candidates: 4 })
  })

  it('a caller naming its own numbers keeps them whole: no strategy threshold is read, protection still holds', async () => {
    const p = await inA(() => previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 2 }))
    expect(p.criteria).toMatchObject({ from: 'caller', strategy: [] })
    expect(queries(p.graduations)).toEqual(['alpha jacket', 'beta gloves', 'delta helmet', 'eta visor'])
    expect(p.graduations.every((g) => !g.strategy)).toBe(true)
    expect(p.graduations.find((g) => g.query === 'delta helmet')).toMatchObject({ orders: 2 })
    expect(p.negatives).toEqual([])
    expect(queries(p.productNegatives)).toEqual(['b0testr001', 'b0testv002'])
    expect(queries(p.protectedAsins)).toEqual(['b0testv001'])
  })

  it('another business: its own strategy only — its protection binds its own ASIN', async () => {
    const p = await inB(() => previewHarvest({}))
    expect(p).toMatchObject({ graduations: [], negatives: [], productNegatives: [], protectedAsins: [] })
  })
})

describe('a protected product\'s ASIN is never negated', () => {
  it('resolves through the catalog: a variation by its category, an opt-out wins, another business\'s protection does not leak', async () => {
    await inA(async () => {
      const it = await protectedAsins('IT', ['b0testv001', 'B0TESTV002', 'B0TESTR001', 'B0TESTQ001', 'not an asin'])
      expect([...it.keys()]).toEqual(['B0TESTV001'])
      expect(it.get('B0TESTV001')).toMatchObject({ sku: 'TEST-T-V1', market: 'IT', source: { level: 'category', label: 'Test leaf (IT)' } })
      expect((await protectedAsins(null, ['B0TESTV001'])).size).toBe(1)
      expect((await protectedAsins('DE', ['B0TESTV001'])).size).toBe(0)
      expect(await protectedAsinRefusal('B0TESTR001', 'IT')).toBeNull()
      // The ad groups a stop engine asks about: one protected product protects its ad group; no market → every market.
      const groups = await protectedAdGroups([{ id: ids.g1, market: null }, { id: ids.g2, market: 'IT' }, { id: ids.g3, market: 'IT' }, { id: ids.g4, market: 'DE' }])
      expect([...groups.keys()]).toEqual([ids.g1])
      expect(groups.get(ids.g1)).toMatchObject({ level: 'category', label: 'Test leaf (IT)' })
    })
    expect([...(await inB(() => protectedAsins('IT', ['B0TESTR001']))).keys()]).toEqual(['B0TESTR001'])
  })

  it('the write gate refuses it for every writer — sandbox, a person\'s own add, a write Nexus cannot place — and names the row', async () => {
    await inA(async () => {
      const base = { marketplace: 'IT', payloadValueCents: 0, isNegation: true }
      expect(await checkAdsWriteGate({ ...base, keywordText: 'B0TESTV001' })).toEqual({
        allowed: false, deniedAt: 'product_protected',
        reason: '"B0TESTV001" cannot be negated: it is the ASIN of TEST-T-V1, a product the ads strategy protects in IT (Test leaf (IT), version 1).',
      })
      expect(await checkAdsWriteGate({ ...base, keywordText: 'b0testv001', manual: true })).toMatchObject({ allowed: false, deniedAt: 'product_protected' })
      expect(await checkAdsWriteGate({ ...base, marketplace: null, keywordText: 'B0TESTV001' })).toMatchObject({ allowed: false, deniedAt: 'product_protected' })
      expect(await checkAdsWriteGate({ ...base, marketplace: 'DE', keywordText: 'B0TESTV001' })).toEqual({ allowed: true, mode: 'sandbox' })
      expect(await checkAdsWriteGate({ ...base, keywordText: 'B0TESTR001' })).toEqual({ allowed: true, mode: 'sandbox' })
    })
    expect(await inB(() => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, isNegation: true, keywordText: 'B0TESTR001' }))).toMatchObject({ allowed: false, deniedAt: 'product_protected' })
  })

  it('the negative write service and the wire refuse it too; nothing is written', async () => {
    await inA(async () => {
      const r = await writeNegativeProductTarget({ adGroupId: ids.g2, asin: 'B0TESTV001', userId: 'user:test' })
      expect(r).toMatchObject({ outcome: 'refused', reachedAmazon: false, adTargetId: null, refusal: { deniedAt: 'product_protected' } })
      expect(await db().adTarget.count({ where: { isNegative: true } })).toBe(0)
      const wire = await negativeWireRefusal({ method: 'POST', path: '/sp/negativeTargets', body: { negativeTargetingClauses: [{ campaignId: 'TC1', expression: [{ type: 'asinSameAs', value: 'B0TESTV001' }] }] } })
      expect(wire).toMatch(/TEST-T-V1, a product the ads strategy protects in IT/)
    })
  })
})

describe('the Keyword Harvest read', () => {
  it('one market: the stricter of the saved policy and the strategy is in force, whole', async () => {
    const out = await inA(() => getKeywordHarvest({ market: 'IT' }))
    expect(out.criteria.policy).toMatchObject({
      criteria: { minOrders: 3, minClicks: 5, maxAcosPct: 40, windowDays: 30, excludeExactMatched: true },
      stored: { minOrders: 2, minClicks: 3, maxAcosPct: 45, windowDays: 60 }, source: 'default',
      strategy: { minOrders: 3, binds: true, source: { level: 'market', label: 'Test market (IT)', version: 1 } },
    })
    expect(out.criteria.inForce).toMatchObject({ minOrders: 3, windowDays: 30 })
    expect(out.rows.map((r) => r.term).sort()).toEqual(['alpha jacket', 'eta visor'])
  })

  it('a campaign: its products\' group; a stricter saved policy binds instead; every market in view: no strategy', async () => {
    const two = await inA(() => getKeywordHarvest({ market: 'IT', campaign: ids.c2 }))
    expect(two.criteria.policy).toMatchObject({ criteria: { minOrders: 4, minClicks: 0, maxAcosPct: null, windowDays: 90 }, strategy: { binds: true, source: { label: 'TEST-T-Q (IT)' } } })
    expect(two.rows.map((r) => r.term)).toEqual(['delta helmet'])
    await inA(() => db().adsHarvestPolicy.create({ data: { scopeGrain: 'market', scopeId: 'IT', minOrders: 5, minClicks: 1, maxAcosPct: 60, windowDays: 60, updatedBy: 'user:test' } }))
    try {
      const saved = await inA(() => getKeywordHarvest({ market: 'IT' }))
      expect(saved.criteria.policy).toMatchObject({ criteria: { minOrders: 5, windowDays: 60 }, source: 'market', strategy: { minOrders: 3, binds: false } })
    } finally {
      await inA(() => db().adsHarvestPolicy.deleteMany({}))
    }
    const all = await inA(() => getKeywordHarvest({ market: 'all' }))
    expect(all.criteria.policy).toMatchObject({ criteria: { minOrders: 2, windowDays: 60 }, strategy: null })
  })
})

describe('rules and the optimiser', () => {
  it('harvest_and_negate without numbers of its own reads the strategy; with them it keeps its own', async () => {
    const bare = await handler('harvest_and_negate', {})
    expect(bare.output).toMatchObject({
      dryRun: true, thresholdsFrom: 'strategy-and-defaults', wouldGraduate: 3, wouldNegate: 2, wouldNegateProduct: 2, protectedProducts: 1,
      topProtected: [{ query: 'b0testv001', why: expect.stringContaining('TEST-T-V1') }],
    })
    const own = await handler('harvest_and_negate', { minOrders: 2 })
    expect(own.output).toMatchObject({ thresholdsFrom: 'rule', wouldGraduate: 4, wouldNegate: 0, wouldNegateProduct: 2, protectedProducts: 1 })
    expect(own.output!.strategy).toBeUndefined()
  })

  it('a rule never pauses, archives or floors a protected product\'s keyword; an unprotected one is offered as before', async () => {
    for (const type of ['pause_target', 'archive_keyword', 'lower_bid_to_floor']) {
      const held = await handler(type, { adTargetId: ids.t1 })
      expect(held, type).toMatchObject({ ok: true, output: { skipped: 'protected-product', adTargetId: ids.t1, why: expect.stringMatching(/^The ads strategy protects a product this ad group advertises \(Test leaf \(IT\), version 1/) } })
      expect((await handler(type, { adTargetId: ids.t2 })).output, type).toMatchObject({ dryRun: true, adTargetId: ids.t2 })
    }
    // A re-enable is not a stop.
    await inA(() => db().adTarget.update({ where: { id: ids.t1 }, data: { status: 'PAUSED' } }))
    expect((await handler('enable_target', { adTargetId: ids.t1 })).output).toMatchObject({ dryRun: true, wouldSet: 'ENABLED' })
    await inA(() => db().adTarget.update({ where: { id: ids.t1 }, data: { status: 'ENABLED' } }))
  })

  it('the optimiser holds its zero-sales cut on a protected product; it still steers one that sells, and cuts the rest', async () => {
    const out = await inA(() => previewBidOptimization({ source: 'legacy' }))
    const proposed = new Map(out.proposals.map((p) => [p.targetId, p.proposedBidCents]))
    expect(proposed.has(ids.tZero1)).toBe(false)
    expect(proposed.get(ids.tZero2)).toBe(40)
    expect(proposed.get(ids.tSells1)).toBeLessThan(80)
    expect(out.held).toEqual([{ targetId: ids.tZero1, expression: 'test spender v', currentBidCents: 80, wouldBeCents: 40, why: expect.stringContaining('no optimiser stops it') }])
  })
})

describe('the recommendations feed', () => {
  it('names the strategy\'s window and row on the search terms it chose; a protected ASIN is left out', async () => {
    const { buildRecommendations } = await import('../ads-recommendations.service.js')
    const feed = await inA(() => buildRecommendations({}))
    expect(feed.searchTerms).toMatchObject({ criteria: { from: 'strategy', defaults: { windowDays: 30 } }, protectedAsins: 1 })
    const gamma = feed.recommendations.find((r) => r.id === 'neg:TG2:gamma boots')
    expect(gamma?.detail).toBe('12 clicks, 0 orders, €6.00 spent with no return. Over 30 days, by the ads strategy\'s thresholds (Test market (IT), version 1).')
    expect(feed.recommendations.find((r) => r.id === 'grad:TG3:delta helmet')?.detail).toMatch(/4 orders, .* Over 90 days, by the ads strategy's thresholds \(TEST-T-Q \(IT\), version 1\)\.$/)
    expect(feed.recommendations.some((r) => r.id.includes('beta gloves'))).toBe(false)
    expect(feed.recommendations.some((r) => r.id === `bid:${ids.tZero1}`)).toBe(false)
  })
})
