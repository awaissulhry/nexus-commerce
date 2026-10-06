/**
 * ADS AUTONOMY W1-2 — the strategy loader, the engines' view (effective.ts) and the three reads (read.ts), on a real
 * PostgreSQL with the production schema and every business policy (PGlite), business profiles ON, two businesses.
 * Values are made up (public repo).
 *
 *   engines    an empty market answers at once with nothing; a market resolves products, ad groups and campaigns
 *              through the catalog (variation → parent → primary category → market), the safer value per ad group,
 *              and gives each ad group its ACoS target as a FRACTION with its source (the W0 resolver's slot)
 *   effective  every number with its source and chain; the older settings that also bind and which is stricter; the
 *              campaigns whose own target wins; Claude's levels; the campaign's market; honest readBy
 *   rows       every row, the orphan flagged, the older settings at the same grains
 *   history    a recorded change under its field's own key
 *   refusals   one scope at a time; a deleted product is not found; views that do not take a scope say so
 *   business   another business reads only its own strategy; this business's ids are not found there
 *   money      the read tool hides exactly the money from a person without ad-spend money
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { openStrategy } from './effective.js'
import { readStrategy, PRODUCT_NOT_FOUND } from './read.js'
import { STRATEGY_MONEY } from './fields.js'
import { PRODUCT_NOT_FOUND as TOOL_PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { callTool, type UserPrincipal } from '../../agents/call-tool.js'

const A = 'w1_read_alpha'
const B = 'w1_read_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { top: '', leaf: '', parent: '', v: '', q: '', gone: '', c1: '', g1: '', c2: '', g2: '', cDe: '', vRow: '', qRow: '', goneRow: '' }
const month = () => { const n = new Date(); return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}` }

type Data = Record<string, any>
const data = (out: Awaited<ReturnType<typeof readStrategy>>) => {
  if ('error' in out) throw new Error(`refused: ${out.error}`)
  return out.data as Data
}
const fieldOf = (market: Data, key: string) => (market.fields as Data[]).find((f) => f.field === key)!

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.top = (await c.category.create({ data: { slug: 'w1-top', name: { en: { name: 'Test top' }, it: {} } } })).id
    ids.leaf = (await c.category.create({ data: { slug: 'w1-leaf', parentId: ids.top, depth: 1, name: { en: { name: 'Test leaf' }, it: {} } } })).id
    await c.categoryClosure.createMany({ data: [
      { ancestorId: ids.top, descendantId: ids.top, depth: 0 }, { ancestorId: ids.leaf, descendantId: ids.leaf, depth: 0 }, { ancestorId: ids.top, descendantId: ids.leaf, depth: 1 },
    ] })
    ids.parent = (await c.product.create({ data: { sku: 'TEST-W1-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v = (await c.product.create({ data: { sku: 'TEST-W1-V1', name: 'Test variation', basePrice: '10.00', parentId: ids.parent } })).id
    ids.q = (await c.product.create({ data: { sku: 'TEST-W1-Q', name: 'Test standalone', basePrice: '10.00' } })).id
    ids.gone = (await c.product.create({ data: { sku: 'TEST-W1-GONE', name: 'Test deleted', basePrice: '10.00', deletedAt: new Date() } })).id
    await c.productCategory.create({ data: { productId: ids.parent, categoryId: ids.leaf, isPrimary: true } })

    const campaign = (name: string, marketplace: string, dynamicBidding: object | null, extra: object = {}) =>
      c.campaign.create({ data: { name, type: 'SP', marketplace, dailyBudget: '10.00', startDate: new Date(), ...(dynamicBidding ? { dynamicBidding } : {}), ...extra } as never })
    ids.c1 = (await campaign('Test campaign one', 'IT', { targetAcos: 0.3, maxBidChangePct: 15 }, { maxBidCents: 150 })).id
    ids.g1 = (await c.adGroup.create({ data: { campaignId: ids.c1, name: 'Test ad group one' } })).id
    await c.adProductAd.createMany({ data: [
      { adGroupId: ids.g1, productId: ids.v, asin: 'B0TESTV001' }, { adGroupId: ids.g1, productId: ids.q, asin: 'B0TESTQ001' }, { adGroupId: ids.g1, productId: null, asin: 'B0TESTX001' },
    ] })
    ids.c2 = (await campaign('Test campaign two', 'IT', null)).id
    ids.g2 = (await c.adGroup.create({ data: { campaignId: ids.c2, name: 'Test ad group two' } })).id
    await c.adProductAd.create({ data: { adGroupId: ids.g2, productId: ids.q, asin: 'B0TESTQ001' } })
    ids.cDe = (await campaign('Test campaign DE', 'DE', null)).id

    const strategy = (level: string, scopeId: string, label: string, set: object) =>
      c.adsStrategy.create({ data: { market: 'IT', level, scopeId, label, updatedBy: 'user:test', ...set } })
    await strategy('MARKET', '*', 'Test market (IT)', {
      targetKind: 'ACOS', targetPct: 30, maxBidCents: 140, monthlySpendCapCents: 515151, maxActionsPerRun: 40, goal: 'PROFIT',
      claudeAutonomy: { bid: 'ask' }, harvestMinOrders: 3, harvestMinClicks: 7, harvestMaxAcosPct: 44, harvestWindowDays: 60,
    })
    await strategy('CATEGORY', ids.leaf, 'Test leaf (IT)', { targetKind: 'ACOS', targetPct: 24, maxBidCents: 121 })
    ids.vRow = (await strategy('PRODUCT', ids.v, 'TEST-W1-V1 (IT)', { minBidCents: 13, targetKind: 'TACOS', targetPct: 11 })).id
    ids.qRow = (await strategy('PRODUCT', ids.q, 'TEST-W1-Q (IT)', { targetKind: 'ACOS', targetPct: 19, maxBidCents: 97, protect: true, monthlySpendCapCents: 31313 })).id
    ids.goneRow = (await strategy('PRODUCT', ids.gone, 'TEST-W1-GONE (IT)', { maxBidCents: 55 })).id
    await c.adsStrategyVersion.create({ data: {
      strategyId: ids.qRow, channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: ids.q, version: 1, op: 'set',
      values: { maxBidCents: 97, protect: true },
      changes: [{ field: 'maxBidCents', from: null, to: 97, effectiveFrom: 140, effectiveTo: 97, direction: 'lower' }, { field: 'protect', from: null, to: true, direction: 'lower' }],
      direction: 'lower', via: 'screen', actor: 'Test person',
    } })

    await c.adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'test market policy', minBidCents: 8, maxBidCents: 160 } })
    await c.adBudgetPlan.create({ data: { marketplace: 'IT', month: month(), monthlyBudgetCents: 616161, stopOverSpend: true } })
    await c.adsHarvestPolicy.create({ data: { scopeGrain: 'market', scopeId: 'IT', minOrders: 2, minClicks: 4, maxAcosPct: 50, windowDays: 30, updatedBy: 'user:test' } })
    await c.adsAutomationState.create({ data: { defaultTargetAcosPct: 28 } })
  })
  await inB(async () => {
    const c = db()
    await c.product.create({ data: { sku: 'BRAVO-W1-SKU', name: 'BRAVO jacket', basePrice: '10.00' } })
    await c.campaign.create({ data: { name: 'BRAVO campaign', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date() } as never })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'BRAVO market (IT)', maxBidCents: 777, updatedBy: 'user:bravo' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('the engines\' view (effective.ts)', () => {
  it('a market without a strategy is empty: every subject gets nothing, and no ACoS target', async () => {
    await inA(async () => {
      const fr = await openStrategy('FR')
      expect(fr.empty).toBe(true)
      expect((await fr.forAdGroups([ids.g1])).get(ids.g1)!.values).toMatchObject({ targetAcos: null, maxBidCents: null, monthlyCaps: [] })
      expect(await fr.targetAcosByAdGroup([ids.g1])).toEqual(new Map())
    })
  })

  it('a product: variation → parent → primary category → market, each with its source; the deleted product\'s row is an orphan', async () => {
    await inA(async () => {
      const it = await openStrategy('IT')
      expect(it.empty).toBe(false)
      expect(it.orphans).toEqual([{ strategyId: ids.goneRow, level: 'PRODUCT', scopeId: ids.gone, label: 'TEST-W1-GONE (IT)', why: 'the product no longer exists or was deleted' }])
      const v = await it.forProducts([ids.v])
      expect(v.values).toMatchObject({ minBidCents: 13, maxBidCents: 121, targetAcosPct: 24, targetAcos: 0.24, maxActionsPerRun: 40 })
      expect(v.resolved.fields.get('target')!.value).toEqual({ targetKind: 'TACOS', targetPct: 11 })
      expect(v.resolved.fields.get('targetAcosPct')!.source).toMatchObject({ level: 'category', scopeId: ids.leaf, label: 'Test leaf (IT)' })
    })
  })

  it('an ad group and a campaign: the safer value per field across their products; the unknown ad is left out and said', async () => {
    await inA(async () => {
      const it = await openStrategy('IT')
      const g1 = (await it.forAdGroups([ids.g1])).get(ids.g1)!
      expect(g1.values).toMatchObject({ targetAcosPct: 19, maxBidCents: 97, minBidCents: 13, protect: true })
      expect(g1.resolved.fields.get('maxBidCents')!.source).toMatchObject({ level: 'product', product: 'TEST-W1-Q' })
      expect(g1.resolved.warnings).toContain('1 ad advertises a product Nexus does not know; it is left out')
      expect(g1.values.monthlyCaps.map((c) => c.monthlySpendCapCents).sort()).toEqual([31313, 515151])
      expect((await it.forCampaigns([ids.c1])).get(ids.c1)!.values).toEqual(g1.values)
    })
  })

  it('the W0 slot: each ad group\'s strategy ACoS target as a FRACTION, with its source', async () => {
    await inA(async () => {
      const targets = await (await openStrategy('IT')).targetAcosByAdGroup([ids.g1, ids.g2])
      expect(targets.get(ids.g1)).toMatchObject({ targetAcos: 0.19, targetAcosPct: 19, source: { level: 'product', scopeId: ids.q } })
      expect(targets.get(ids.g2)).toMatchObject({ targetAcos: 0.19, source: { scopeId: ids.q } })
    })
  })
})

describe('effective', () => {
  it('a product: each number with its source and chain, the older settings that also bind, the campaigns that keep their own target', async () => {
    const out = data(await inA(() => readStrategy({ market: 'it', productId: ids.v })))
    expect(out).toMatchObject({ channel: 'AMAZON', view: 'effective' })
    expect(out.notReadYet).toContain('maxBidCents')
    const m = out.markets[0]
    expect(m).toMatchObject({ market: 'IT', strategyRows: 4, scope: { kind: 'product', products: [{ productId: ids.v, sku: 'TEST-W1-V1', parentSku: 'TEST-W1-PARENT', category: 'Test leaf' }] } })
    const maxBid = fieldOf(m, 'maxBidCents')
    expect(maxBid).toMatchObject({
      maxBidCents: 121, source: { level: 'category', label: 'Test leaf (IT)', version: 1 },
      alsoInForce: [{ setting: "the market's bid policy", maxBidCents: 160 }], stricter: { from: 'the strategy' }, readBy: [],
    })
    expect(maxBid.chain.map((c: Data) => [c.level, c.maxBidCents])).toEqual([['product', null], ['category', 121], ['market', 140]])
    expect(fieldOf(m, 'minBidCents')).toMatchObject({ minBidCents: 13, alsoInForce: [{ minBidCents: 8 }], stricter: { from: 'the strategy' } })
    expect(fieldOf(m, 'target')).toMatchObject({ targetKind: 'TACOS', targetPct: 11, source: { level: 'product' } })
    expect(fieldOf(m, 'targetAcosPct')).toMatchObject({
      targetAcosPct: 24, campaignOwn: null, accountDefault: { targetAcosPct: 28 },
      today: { from: 'the account default (campaigns without their own target; shadowedBy lists the others)', targetAcosPct: 28 },
    })
    expect(fieldOf(m, 'harvest')).toMatchObject({
      harvestMinOrders: 3, harvestMinClicks: 7, harvestMaxAcosPct: 44, harvestWindowDays: 60,
      alsoInForce: [{ setting: 'the market harvest policy', harvestMinOrders: 2, harvestMinClicks: 4, harvestMaxAcosPct: 50, harvestWindowDays: 30 }],
      stricter: { from: 'the strategy' },
    })
    expect(fieldOf(m, 'monthlySpendCapCents')).toMatchObject({
      caps: [{ level: 'market', monthlySpendCapCents: 515151 }],
      alsoInForce: [{ setting: `the budget plan ${month()}`, monthlyBudgetCents: 616161, stopOverSpend: true }], stricter: { from: 'the market strategy' },
      // W1-6 — how this month stands against the cap where bids drop (the budget engine's rule), and who reads it.
      thisMonth: { month: month(), spendCents: 0, spendThrough: null, forecastSpendCents: null, stopCapCents: 515151, stopBy: 'the market strategy', reached: false },
      readBy: ['budget engine (the market cap)'],
    })
    expect(out.notReadYet).not.toEqual(expect.arrayContaining(['monthlySpendCapCents']))
    expect(m.shadowedBy).toEqual([{ campaignId: ids.c1, name: 'Test campaign one', targetAcosPct: 30 }])
    expect(m.claude.find((c: Data) => c.action === 'bid')).toEqual({
      action: 'bid', tools: [{ tool: 'set-target-bid', business: 'ask' }, { tool: 'bulk-ad-bid-change', business: 'ask' }],
      strategy: 'ask', source: expect.objectContaining({ level: 'market' }),
    })
    expect(m.orphans).toHaveLength(1)
  })

  it('W1-6 — a market cap says how this month stands: spend so far (whole days, never today) and whether bids drop', async () => {
    const day1 = new Date(`${month()}-01T00:00:00Z`)
    const row = await inA(() => db().amazonAdsDailyPerformance.create({ data: {
      profileId: 'P-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day1, entityType: 'CAMPAIGN', entityId: 'EXT-W1-READ',
      localEntityId: ids.c1, costMicros: 6_000_000_000n, currencyCode: 'EUR', reportRunId: 'RUN-TEST', reportedAt: new Date(),
    } as never }))
    try {
      const cap = fieldOf(data(await inA(() => readStrategy({ market: 'IT' }))).markets[0], 'monthlySpendCapCents')
      expect(cap.thisMonth).toMatchObject({ spendCents: 600_000, spendThrough: `${month()}-01`, stopCapCents: 515151, stopBy: 'the market strategy', reached: true })
      expect(cap.thisMonth.note).toMatch(/never today.*stop bid \(never a pause\) until the 1st/s)
      // Another business reads its own month only: no cap of its own, no spend of this one.
      const bravo = fieldOf(data(await inB(() => readStrategy({ market: 'IT' }))).markets[0], 'monthlySpendCapCents')
      expect(bravo.thisMonth).toBeUndefined()
    } finally {
      await inA(() => db().amazonAdsDailyPerformance.delete({ where: { id: row.id } }))
    }
  })

  it('W1-6 — a market cap of 0 is no cap (as in the Budget Manager): the plan\'s cap is the one that stops', async () => {
    const row = await inA(() => db().adsStrategy.findFirstOrThrow({ where: { market: 'IT', level: 'MARKET' }, select: { id: true } }))
    await inA(() => db().adsStrategy.update({ where: { id: row.id }, data: { monthlySpendCapCents: 0 } }))
    try {
      const cap = fieldOf(data(await inA(() => readStrategy({ market: 'IT' }))).markets[0], 'monthlySpendCapCents')
      expect(cap.caps).toEqual([expect.objectContaining({ level: 'market', monthlySpendCapCents: 0, noCap: true })])
      expect(cap.stricter).toBeUndefined()
      expect(cap.thisMonth).toMatchObject({ stopCapCents: 616161, stopBy: `the budget plan ${month()}` })
      expect(cap.note).toMatch(/A cap of 0 means no cap/)
    } finally {
      await inA(() => db().adsStrategy.update({ where: { id: row.id }, data: { monthlySpendCapCents: 515151 } }))
    }
  })

  it('a campaign answers in its own market: its products, its own limits and target, which win today', async () => {
    const m = data(await inA(() => readStrategy({ campaignId: ids.c1 }))).markets[0]
    expect(m.scope).toMatchObject({ kind: 'campaign', name: 'Test campaign one', adGroups: 1, unknownProductAds: 1 })
    expect(m.scope.products.map((p: Data) => p.sku).sort()).toEqual(['TEST-W1-Q', 'TEST-W1-V1'])
    expect(fieldOf(m, 'maxBidCents')).toMatchObject({ maxBidCents: 97, alsoInForce: [{ setting: "the campaign's own highest bid", maxBidCents: 150 }], stricter: { from: 'the strategy' } })
    expect(fieldOf(m, 'maxChangePct')).toMatchObject({ maxChangePct: null, alsoInForce: [{ maxChangePct: 15 }] })
    expect(fieldOf(m, 'targetAcosPct')).toMatchObject({
      targetAcosPct: 19, campaignOwn: { campaignId: ids.c1, targetAcosPct: 30 }, today: { from: "the campaign's own target", targetAcosPct: 30 },
    })
    expect(m.warnings).toContain('1 ad advertises a product Nexus does not know; it is left out')
  })

  it('no market and no scope: every market with a strategy or a campaign; one without a strategy says so', async () => {
    const out = data(await inA(() => readStrategy({})))
    expect(out.markets.map((m: Data) => m.market)).toEqual(['DE', 'IT'])
    expect(out.markets[0]).toMatchObject({ strategyRows: 0, note: 'No strategy is set for DE yet: every engine works as it does today.' })
  })
})

describe('rows and history', () => {
  it('rows: every row of the market with the orphan flagged, and the older settings at the same grains', async () => {
    const m = data(await inA(() => readStrategy({ market: 'IT', view: 'rows' }))).markets[0]
    expect(m.rows.map((r: Data) => [r.level, r.label, r.orphan ?? null])).toEqual([
      ['MARKET', 'Test market (IT)', null],
      ['CATEGORY', 'Test leaf (IT)', null],
      ['PRODUCT', 'TEST-W1-GONE (IT)', 'the product no longer exists or was deleted'],
      ['PRODUCT', 'TEST-W1-Q (IT)', null],
      ['PRODUCT', 'TEST-W1-V1 (IT)', null],
    ])
    expect(m.rows[0]).toMatchObject({ version: 1, updatedBy: 'user:test', targetPct: 30, claudeAutonomy: { bid: 'ask' } })
    expect(m.olderSettings).toMatchObject({
      bidPolicies: [{ grain: 'MARKET', scopeId: 'IT', minBidCents: 8, maxBidCents: 160 }],
      harvestPolicies: [{ grain: 'market', scopeId: 'IT', harvestMinOrders: 2, harvestMaxAcosPct: 50 }],
      budgetPlan: { monthlyBudgetCents: 616161, stopOverSpend: true },
    })
    expect(m.shadowedCount).toBe(1)
  })

  it('history: a recorded change, its numbers under the field\'s own key', async () => {
    const m = data(await inA(() => readStrategy({ market: 'IT', view: 'history', sku: 'TEST-W1-Q' }))).markets[0]
    expect(m.scope).toEqual({ level: 'PRODUCT', scopeId: ids.q })
    expect(m.versions).toHaveLength(1)
    expect(m.versions[0]).toMatchObject({ version: 1, op: 'set', direction: 'lower', via: 'screen', actor: 'Test person', values: { maxBidCents: 97, protect: true } })
    expect(m.versions[0].changes).toEqual([
      { field: 'maxBidCents', direction: 'lower', maxBidCents: { from: null, to: 97, effectiveFrom: 140, effectiveTo: 97 } },
      { field: 'protect', direction: 'lower', protect: { from: null, to: true, effectiveFrom: null, effectiveTo: null } },
    ])
    expect(data(await inA(() => readStrategy({ market: 'IT', view: 'history', categoryId: ids.leaf }))).markets[0]).toMatchObject({ versions: [], note: 'No change recorded yet.' })
  })
})

describe('refusals', () => {
  it('one scope at a time; each view takes only the scopes it can answer; a deleted product is not found', async () => {
    await inA(async () => {
      expect(await readStrategy({ productId: ids.v, campaignId: ids.c1 })).toMatchObject({ status: 400, error: expect.stringMatching(/^Name one scope/) })
      expect(await readStrategy({ productId: ids.v, sku: 'TEST-W1-V1' })).toMatchObject({ status: 400 })
      expect(await readStrategy({ view: 'rows', productId: ids.v })).toMatchObject({ status: 400 })
      expect(await readStrategy({ view: 'history', campaignId: ids.c1 })).toMatchObject({ status: 400 })
      expect(await readStrategy({ campaignId: ids.cDe, market: 'IT' })).toEqual({ status: 400, error: 'Campaign "Test campaign DE" advertises in DE, not IT.' })
      expect(await readStrategy({ productId: ids.gone })).toEqual({ status: 404, error: PRODUCT_NOT_FOUND })
      expect(await readStrategy({ categoryId: 'no-such-category' })).toMatchObject({ status: 404 })
      expect(await readStrategy({ channel: 'EBAY' })).toMatchObject({ status: 400 })
    })
    // The tools' one wording for a product that is not here (MCP.12).
    expect(PRODUCT_NOT_FOUND).toBe(TOOL_PRODUCT_NOT_FOUND)
  })

  it('with business profiles on, a read without a business is refused', async () => {
    await expect(readStrategy({ market: 'IT' })).rejects.toMatchObject({ code: 'workspace_required' })
  })
})

describe('one business never reads another\'s strategy', () => {
  it('B reads its own market row only; A\'s ids are not found from B; A never sees B', async () => {
    const b = data(await inB(() => readStrategy({ market: 'IT' }))).markets[0]
    expect(b).toMatchObject({ strategyRows: 1, orphans: [] })
    expect(fieldOf(b, 'maxBidCents')).toMatchObject({ maxBidCents: 777, source: { label: 'BRAVO market (IT)' } })
    expect(JSON.stringify(b)).not.toMatch(/Test (market|leaf|campaign)|TEST-W1/)
    await inB(async () => {
      expect(await readStrategy({ campaignId: ids.c1 })).toMatchObject({ status: 404 })
      expect(await readStrategy({ productId: ids.v })).toEqual({ status: 404, error: PRODUCT_NOT_FOUND })
      expect(await readStrategy({ categoryId: ids.leaf })).toMatchObject({ status: 404 })
      expect((await openStrategy('IT')).index.rows.map((r) => r.label)).toEqual(['BRAVO market (IT)'])
    })
    for (const view of ['effective', 'rows', 'history'] as const) {
      expect(JSON.stringify(data(await inA(() => readStrategy({ market: 'IT', view }))))).not.toContain('BRAVO')
    }
  })
})

describe('money through the read tool', () => {
  const person = (permissions: string[]): UserPrincipal => ({
    kind: 'user', userId: 'u-w1-read', label: 'W1 reader', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: scope(A), via: 'app',
  })
  const ACTIONS = Object.values(FEATURES)

  it('a person without ad-spend money gets the same answer minus exactly the strategy\'s money keys', async () => {
    const full = (await callTool(person([...ACTIONS, ...Object.values(FIELDS)]), 'ads-strategy', { market: 'IT', campaignId: ids.c1 })).visible as Data
    const partial = (await callTool(person(ACTIONS), 'ads-strategy', { market: 'IT', campaignId: ids.c1 })).visible as Data
    expect(full.ok).toBe(true)
    const money = new Set([...Object.keys(STRATEGY_MONEY)])
    const keys = (value: unknown, out = new Set<string>()): Set<string> => {
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keys(v, out) }
      return out
    }
    expect([...keys(full)].filter((k) => money.has(k)).sort()).toEqual(expect.arrayContaining(['maxBidCents', 'targetAcosPct', 'monthlySpendCapCents']))
    expect([...keys(partial)].filter((k) => money.has(k))).toEqual([])
    expect(JSON.stringify(partial)).toBe(JSON.stringify(full, (k, v) => (k && money.has(k) ? undefined : v)))
    // Where each number comes from stays visible.
    expect(fieldOf(partial.data.markets[0], 'maxBidCents')).toMatchObject({ source: { level: 'product' }, stricter: { from: 'the strategy' } })
    for (const amount of ['515151', '616161', '31313']) expect(JSON.stringify(partial)).not.toContain(amount)
  })
})
