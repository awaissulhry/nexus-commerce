/**
 * ADS AUTONOMY W1-6b — category and product monthly caps in the budget engine (Owner decision D5 = A). Real PostgreSQL
 * with the production schema and every business policy (PGlite), business profiles ON, two businesses. The ad-group
 * floor itself is the suppression service's (ads-bid-suppression-ad-group.vitest.test.ts); here, what the engine asks
 * for. Values are made up (public repo).
 *
 *   spend       each scope's month-to-date spend from the daily advertised-product rows: a variation's spend counts on
 *               its parent's cap and on its category's; an ad Nexus cannot tie to a product counts on no cap
 *   floors      every ad group holding a product under a reached cap is floored at its stop bid (the lower across its
 *               products), the other products sharing it included; ad groups under no reached cap are left alone
 *   ownership   an ad group another owner floored is neither floored again nor given back; this engine's own ad-group
 *               floor whose cap is no longer reached is given back — and on the 1st
 *   apply       the floors and give-backs the engine asks the suppression service for, with the cap named
 *   business    another business's caps, spend and ad groups are invisible
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const writes = vi.hoisted(() => ({
  suppressGroup: vi.fn(async (_id: string, _opts: Record<string, unknown>) => 2),
  restoreGroup: vi.fn(async (_id: string, _opts: Record<string, unknown>) => 2),
  suppressCampaign: vi.fn(async () => 0),
  restoreCampaign: vi.fn(async () => 0),
}))
vi.mock('./ads-bid-suppression.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  suppressAdGroupBids: writes.suppressGroup,
  restoreAdGroupBids: writes.restoreGroup,
  suppressCampaignBids: writes.suppressCampaign,
  restoreCampaignBids: writes.restoreCampaign,
}))

import { applyBudgetEnforcement, computeBudgetEnforcement, type PlanDecision } from './ads-budget-enforce.service.js'

const A = 'w16b_caps_alpha'
const B = 'w16b_caps_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids: Record<string, string> = {}
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const nextMonth = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })()
const firstDay = new Date(`${month}-01T00:00:00Z`)
const PARENT_WORDS = 'ads strategy: TEST-W16B-P (IT) v1'

const it_ = (r: { plans: PlanDecision[] }) => r.plans.find((p) => p.marketplace === 'IT')!
const group = (p: PlanDecision, id: string) => p.adGroups.find((g) => g.id === id)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.cat = (await c.category.create({ data: { slug: 'w16b-helmets', name: { en: { name: 'Test helmets' }, it: {} } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.cat, descendantId: ids.cat, depth: 0 } })
    ids.p = (await c.product.create({ data: { sku: 'TEST-W16B-P', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v1 = (await c.product.create({ data: { sku: 'TEST-W16B-V1', name: 'Test variation one', basePrice: '10.00', parentId: ids.p } })).id
    ids.v2 = (await c.product.create({ data: { sku: 'TEST-W16B-V2', name: 'Test variation two', basePrice: '10.00', parentId: ids.p } })).id
    ids.q = (await c.product.create({ data: { sku: 'TEST-W16B-Q', name: 'Test standalone', basePrice: '10.00' } })).id
    ids.r = (await c.product.create({ data: { sku: 'TEST-W16B-R', name: 'Test uncapped', basePrice: '10.00' } })).id
    await c.productCategory.create({ data: { productId: ids.p, categoryId: ids.cat, isPrimary: true } })

    const camp = (name: string) => c.campaign.create({ data: { name, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ENABLED' } as never })
    ids.c1 = (await camp('Test IT one')).id
    ids.c2 = (await camp('Test IT two')).id
    const adGroup = async (key: string, campaignId: string, products: string[], extra: object = {}) => {
      ids[key] = (await c.adGroup.create({ data: { campaignId, name: `Test ${key}`, ...extra } })).id
      for (const [i, productId] of products.entries()) ids[`${key}:${productId}`] = (await c.adProductAd.create({ data: { adGroupId: ids[key], productId, asin: `B0W16B${key.toUpperCase()}${i}` } })).id
    }
    await adGroup('mixed', ids.c1, [ids.v1, ids.r]) // a capped variation shares this ad group with an uncapped product
    await adGroup('uncapped', ids.c1, [ids.r])
    await adGroup('standalone', ids.c1, [ids.q])
    await adGroup('second', ids.c2, [ids.v2])
    await adGroup('person', ids.c2, [ids.v2], { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'user:test-person', bidsSuppressedFloorCents: 2 })
    await adGroup('released', ids.c2, [ids.q], { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:budget-manager-cron', bidsSuppressedFloorCents: 2 })

    const row = (level: string, scopeId: string, label: string, set: object) => c.adsStrategy.create({ data: { market: 'IT', level, scopeId, label, updatedBy: 'user:test', ...set } })
    await row('MARKET', '*', 'Test market (IT)', { stopMethod: 'LOW_BIDS', stopBidCents: 9 }) // no market cap: no campaign stops
    await row('CATEGORY', ids.cat, 'Test helmets (IT)', { monthlySpendCapCents: 10_000 })
    await row('PRODUCT', ids.p, 'TEST-W16B-P (IT)', { monthlySpendCapCents: 3_000, stopMethod: 'LOW_BIDS', stopBidCents: 6 })
    await row('PRODUCT', ids.q, 'TEST-W16B-Q (IT)', { monthlySpendCapCents: 1_000 })

    const spend = (adId: string | null, cents: number, entityId: string) => c.amazonAdsDailyPerformance.create({ data: {
      profileId: 'P-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: firstDay, entityType: 'PRODUCT_AD', entityId,
      localEntityId: adId, costMicros: BigInt(cents) * 10_000n, currencyCode: 'EUR', reportRunId: 'RUN-TEST', reportedAt: new Date(),
    } as never })
    await spend(ids[`mixed:${ids.v1}`], 2_000, 'AD-V1')
    await spend(ids[`second:${ids.v2}`], 1_500, 'AD-V2')
    await spend(ids[`mixed:${ids.r}`], 500, 'AD-R')
    await spend(ids[`standalone:${ids.q}`], 100, 'AD-Q')
    await spend(null, 999, 'AD-UNKNOWN')
    await c.adsAutomationState.create({ data: { autonomy: 'AUTO' } as never })
  })
  await inB(async () => {
    const c = db()
    const product = await c.product.create({ data: { sku: 'BRAVO-W16B', name: 'BRAVO product', basePrice: '10.00' } })
    const campaign = await c.campaign.create({ data: { name: 'BRAVO IT', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ENABLED' } as never })
    const g = await c.adGroup.create({ data: { campaignId: campaign.id, name: 'BRAVO group' } })
    await c.adProductAd.create({ data: { adGroupId: g.id, productId: product.id, asin: 'B0BRAVO16B' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: product.id, label: 'BRAVO-W16B (IT)', updatedBy: 'user:bravo', monthlySpendCapCents: 1 } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => { for (const f of Object.values(writes)) f.mockClear() })

describe('the preview — category and product caps', () => {
  it('each scope\'s spend: a variation counts on its parent\'s cap and its category\'s; an ad Nexus cannot place counts on none', async () => {
    const p = it_(await inA(() => computeBudgetEnforcement({ month })))
    expect(p.scopeCaps.map((c) => [c.label, c.level, c.capCents, c.spendCents, c.reached])).toEqual(expect.arrayContaining([
      ['Test helmets (IT)', 'category', 10_000, 3_500, false],
      ['TEST-W16B-P (IT)', 'product', 3_000, 3_500, true],
      ['TEST-W16B-Q (IT)', 'product', 1_000, 100, false],
    ]))
    expect(p.scopeCaps).toHaveLength(3)
    expect(p).toMatchObject({ unattributedSpendCents: 999, productSpendThrough: `${month}-01`, stopCapCents: null, capReached: false })
    // No market cap: no campaign is floored.
    expect(p.campaigns.every((c) => !c.suppress && !c.restore)).toBe(true)
  })

  it('every ad group holding a product under the reached cap is floored at its stop bid, the product it shares the ad group with included', async () => {
    const p = it_(await inA(() => computeBudgetEnforcement({ month })))
    const reachedBy = [{ level: 'product', label: 'TEST-W16B-P (IT)', capCents: 3_000, spendCents: 3_500, from: PARENT_WORDS }]
    // The lower stop bid across its products: the parent's 6 (the uncapped product's would be the market's 9).
    expect(group(p, ids.mixed)).toEqual({ id: ids.mixed, name: 'Test mixed', campaignId: ids.c1, suppress: true, restore: false, ownFloorBy: null, reachedBy, stopBidCents: 6, stopBidFrom: PARENT_WORDS })
    expect(group(p, ids.second)).toMatchObject({ suppress: true, stopBidCents: 6 })
    expect(group(p, ids.uncapped)).toBeUndefined()
    expect(group(p, ids.standalone)).toBeUndefined()
  })

  it('another owner\'s ad-group floor is neither floored again nor lifted; this engine\'s own is given back once its cap is not reached', async () => {
    const p = it_(await inA(() => computeBudgetEnforcement({ month })))
    expect(group(p, ids.person)).toMatchObject({ suppress: false, restore: false, ownFloorBy: 'user:test-person' })
    expect(group(p, ids.released)).toMatchObject({ suppress: false, restore: true, ownFloorBy: 'automation:budget-manager-cron', reachedBy: [] })
    expect((await inA(() => computeBudgetEnforcement({ month }))).totals).toMatchObject({ adGroupsSuppressing: 2, adGroupsRestoring: 1 })
  })

  it('on the 1st, a new month starts from 0: nothing is floored, and this engine\'s own floor is given back', async () => {
    const p = it_(await inA(() => computeBudgetEnforcement({ month: nextMonth })))
    expect(p.scopeCaps.every((c) => c.spendCents === 0 && !c.reached)).toBe(true)
    expect(p.adGroups.filter((g) => g.suppress)).toEqual([])
    expect(group(p, ids.released)).toMatchObject({ restore: true })
    expect(group(p, ids.person)).toMatchObject({ restore: false })
  })

  it('another business sees neither this business\'s spend nor its caps', async () => {
    const p = it_(await inB(() => computeBudgetEnforcement({ month })))
    expect(p.scopeCaps).toEqual([expect.objectContaining({ label: 'BRAVO-W16B (IT)', capCents: 1, spendCents: 0, reached: false })])
    expect(p).toMatchObject({ unattributedSpendCents: 0, adGroups: [] })
  })
})

describe('a live run asks the suppression service for the ad-group floors and give-backs', () => {
  it('floors at the stop bid with the reached cap named; gives back its own; leaves the person\'s', async () => {
    const run = await inA(() => applyBudgetEnforcement({ month, dryRun: false, actor: 'automation:budget-manager-cron' }))
    expect(run).toMatchObject({ adGroupsSuppressed: 2, adGroupsRestored: 1, failed: 0, suppressed: 0, restored: 0 })
    const floored = new Map(writes.suppressGroup.mock.calls.map(([id, opts]) => [id, opts]))
    expect([...floored.keys()].sort()).toEqual([ids.mixed, ids.second].sort())
    expect(floored.get(ids.mixed)).toEqual({
      actor: 'automation:budget-manager-cron', floorCents: 6,
      reason: `stop over spend: IT product cap reached (${PARENT_WORDS}) → ad group Test mixed to 6¢ (${PARENT_WORDS})`,
    })
    expect(writes.restoreGroup).toHaveBeenCalledTimes(1)
    expect(writes.restoreGroup.mock.calls[0]![0]).toBe(ids.released)
    expect(writes.suppressCampaign).not.toHaveBeenCalled()
    expect(run.guard).toMatchObject({ posture: 'auto', changes: 6 })
  })
})
