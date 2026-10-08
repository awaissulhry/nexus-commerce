/**
 * ADS AUTONOMY W1-6 — the ads strategy's monthly market cap in the budget engine, the strategy's stop bid for engine
 * stops, and the market's own "most actions per run". Real PostgreSQL with the production schema and every business
 * policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   caps        which cap stops a market and which one pacing paces: the lower of the plan's and the strategy's; a
 *               strategy cap stops with no plan at all; a plan cap of 0 is "no budget", a strategy cap of 0 is a cap
 *   preview     month-to-date spend and the day it covers, the cap where bids
 *               drop and which one; each campaign about to be floored with its stop bid (the lower across its
 *               products) and its source; floors this engine did not set are never lifted
 *   restore     on the 1st (a new month starts from 0), and in a market whose cap is gone — only this engine's floors
 *   apply       a floor lands at the stop bid with the cap named; the market's own cap per run defers the next campaign
 *   retail      the retail guard floors at the strategy's stop bid too, else 2¢
 *   business    another business's cap and spend are invisible
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// What a floor or a restore writes is the suppression service's own business (ads-bid-suppression tests); here, what
// the engines ask it for.
const writes = vi.hoisted(() => ({
  suppress: vi.fn(async (_id: string, _opts: Record<string, unknown>) => 3),
  restore: vi.fn(async (_id: string, _opts: Record<string, unknown>) => 2),
}))
vi.mock('./ads-bid-suppression.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  suppressCampaignBids: writes.suppress,
  restoreCampaignBids: writes.restore,
}))

import { applyBudgetEnforcement, computeBudgetEnforcement, marketCaps, type PlanDecision } from './ads-budget-enforce.service.js'
import { applyRetailGuard } from './ads-retail-readiness.service.js'

const A = 'w16_spend_alpha'
const B = 'w16_spend_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { p1: '', p2: '', cA: '', cB: '', cRank: '', cOld: '', cDe: '', cFr: '', marketRow: '' }
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const nextMonth = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })()
const firstDay = new Date(`${month}-01T00:00:00Z`)
const MARKET_WORDS = 'ads strategy: Test market (IT) v1'
const PRODUCT_WORDS = 'ads strategy: TEST-W16-P2 (IT) v1'

const market = (r: { plans: PlanDecision[] }, code: string) => r.plans.find((p) => p.marketplace === code)!
const campaign = (p: PlanDecision, id: string) => p.campaigns.find((c) => c.id === id)!

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.p1 = (await c.product.create({ data: { sku: 'TEST-W16-P1', name: 'Test product one', basePrice: '10.00' } })).id
    ids.p2 = (await c.product.create({ data: { sku: 'TEST-W16-P2', name: 'Test product two', basePrice: '10.00' } })).id
    const camp = (name: string, marketplace: string, extra: object = {}) =>
      c.campaign.create({ data: { name, type: 'SP', marketplace, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ENABLED', ...extra } as never })
    ids.cA = (await camp('Test IT one', 'IT')).id
    ids.cB = (await camp('Test IT two', 'IT')).id
    ids.cRank = (await camp('Test IT rank floor', 'IT', { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:rank-defend-test' })).id
    ids.cOld = (await camp('Test IT budget floor', 'IT', { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:budget-manager-cron' })).id
    ids.cDe = (await camp('Test DE budget floor', 'DE', { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:budget-manager-cron' })).id
    ids.cFr = (await camp('Test FR', 'FR')).id
    const gA = await c.adGroup.create({ data: { campaignId: ids.cA, name: 'Test group one' } })
    const gB = await c.adGroup.create({ data: { campaignId: ids.cB, name: 'Test group two' } })
    await c.adProductAd.createMany({ data: [{ adGroupId: gA.id, productId: ids.p1, asin: 'B0TESTW161' }, { adGroupId: gB.id, productId: ids.p2, asin: 'B0TESTW162' }] })

    ids.marketRow = (await c.adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test',
      monthlySpendCapCents: 5_000, stopMethod: 'LOW_BIDS', stopBidCents: 9, maxActionsPerRun: 3,
    } })).id
    // A lower stop bid on one product: its campaign takes the lower (the safer) one.
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p2, label: 'TEST-W16-P2 (IT)', updatedBy: 'user:test', stopMethod: 'LOW_BIDS', stopBidCents: 5 } })

    const perf = (localEntityId: string, cents: number) => c.amazonAdsDailyPerformance.create({ data: {
      profileId: 'P-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: firstDay, entityType: 'CAMPAIGN', entityId: `EXT-${localEntityId}`,
      localEntityId, costMicros: BigInt(cents) * 10_000n, currencyCode: 'EUR', reportRunId: 'RUN-TEST', reportedAt: new Date(),
    } as never })
    await perf(ids.cA, 3_000)
    await perf(ids.cB, 2_500)
    // AA-W2-2b — a Marketing Stream duplicate of a campaign-day (AM-18): never counted, as on the Budget Manager.
    await c.amazonAdsDailyPerformance.create({ data: {
      profileId: 'ams', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: firstDay, entityType: 'CAMPAIGN', entityId: `EXT-${ids.cA}`,
      localEntityId: null, costMicros: 9_000n * 10_000n, currencyCode: 'EUR', reportRunId: 'ams-stream', reportedAt: new Date(),
    } as never })
    await c.adsAutomationState.create({ data: { autonomy: 'AUTO' } as never })
  })
  await inB(async () => {
    const c = db()
    await c.campaign.create({ data: { name: 'BRAVO IT', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ENABLED' } as never })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'BRAVO market (IT)', updatedBy: 'user:bravo', monthlySpendCapCents: 1 } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => { writes.suppress.mockClear(); writes.restore.mockClear() })

describe('marketCaps — which cap stops a market, which one pacing paces (pure)', () => {
  const plan = (monthlyBudgetCents: number, flags: { autoPacing?: boolean; stopOverSpend?: boolean } = {}) =>
    ({ monthlyBudgetCents, autoPacing: flags.autoPacing ?? false, stopOverSpend: flags.stopOverSpend ?? false })

  it('a strategy cap stops the market with no plan at all; no cap anywhere: no stop', () => {
    expect(marketCaps(null, 5_000)).toEqual({ capCents: 5_000, stopCapCents: 5_000, stopBy: 'strategy', pacingCapCents: null })
    expect(marketCaps(null, null)).toEqual({ capCents: null, stopCapCents: null, stopBy: null, pacingCapCents: null })
  })

  it('a plan with Stop Over Spend and a strategy cap: the lower one stops, and is named', () => {
    expect(marketCaps(plan(4_000, { stopOverSpend: true }), 5_000)).toMatchObject({ stopCapCents: 4_000, stopBy: 'plan' })
    expect(marketCaps(plan(6_000, { stopOverSpend: true }), 5_000)).toMatchObject({ stopCapCents: 5_000, stopBy: 'strategy', capCents: 5_000 })
  })

  it('a plan without Stop Over Spend only paces; the strategy cap still stops, and pacing never paces above it', () => {
    expect(marketCaps(plan(3_000, { autoPacing: true }), 5_000)).toEqual({ capCents: 3_000, stopCapCents: 5_000, stopBy: 'strategy', pacingCapCents: 3_000 })
    expect(marketCaps(plan(8_000, { autoPacing: true }), 5_000)).toMatchObject({ pacingCapCents: 5_000, stopCapCents: 5_000 })
    expect(marketCaps(plan(8_000, { autoPacing: true }), null)).toEqual({ capCents: 8_000, stopCapCents: null, stopBy: null, pacingCapCents: 8_000 })
  })

  it('a cap of 0 is NO cap, in the plan and in the strategy alike (the Budget Manager\'s €0 = "no budget set")', () => {
    const none = { capCents: null, stopCapCents: null, stopBy: null, pacingCapCents: null }
    expect(marketCaps(plan(0, { stopOverSpend: true, autoPacing: true }), null)).toEqual(none)
    expect(marketCaps(null, 0)).toEqual(none)
    expect(marketCaps(plan(0, { stopOverSpend: true }), 0)).toEqual(none)
    // A plan cap still stops, and paces, with a strategy cap of 0 beside it.
    expect(marketCaps(plan(4_000, { stopOverSpend: true, autoPacing: true }), 0)).toEqual({ capCents: 4_000, stopCapCents: 4_000, stopBy: 'plan', pacingCapCents: 4_000 })
  })
})

describe('the preview — what the engine would do now', () => {
  it('a market over its strategy cap: every campaign not yet floored drops to its stop bid; other owners\' floors stay', async () => {
    const r = await inA(() => computeBudgetEnforcement({ month }))
    expect(r.plans.map((p) => p.marketplace)).toEqual(['DE', 'IT'])
    const it_ = market(r, 'IT')
    expect(it_).toMatchObject({
      mtdSpendCents: 5_500, // the stream's duplicate row is left out
      spendThrough: `${month}-01`,
      planCapCents: null, strategyCap: { cents: 5_000, from: MARKET_WORDS },
      capCents: 5_000, stopCapCents: 5_000, stopBy: 'strategy', stopOverSpend: true, autoPacing: false, capReached: true, todayTargetCents: null,
    })
    expect(campaign(it_, ids.cA)).toMatchObject({ suppress: true, restore: false, stopBidCents: 9, stopBidFrom: MARKET_WORDS })
    expect(campaign(it_, ids.cB)).toMatchObject({ suppress: true, restore: false, stopBidCents: 5, stopBidFrom: PRODUCT_WORDS })
    // Rank's floor is not this engine's: not stamped, not lifted. Its own floor stays while over the cap.
    expect(campaign(it_, ids.cRank)).toMatchObject({ suppress: false, restore: false, currentlySuppressed: true })
    expect(campaign(it_, ids.cOld)).toMatchObject({ suppress: false, restore: false, currentlySuppressed: true })
    expect(r.totals).toMatchObject({ suppressing: 2, restoring: 1 })
  })

  it('BID BRAIN pre-go-live — on a campaign the brain owns, its own Min-bid mark is no stop: over the cap the stop is declared', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    try {
      await inA(() => db().bidBrainEnrollment.create({ data: { campaignId: ids.cRank, marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:test' } }))
      const it_ = market(await inA(() => computeBudgetEnforcement({ month })), 'IT')
      expect(campaign(it_, ids.cRank)).toMatchObject({ suppress: true, restore: false, currentlySuppressed: false })
    } finally {
      vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
      await inA(() => db().bidBrainEnrollment.deleteMany({ where: { campaignId: ids.cRank } }))
    }
    // Not owned: rank's own floor is left as it is, as before.
    expect(campaign(market(await inA(() => computeBudgetEnforcement({ month })), 'IT'), ids.cRank)).toMatchObject({ suppress: false, currentlySuppressed: true })
  })

  it('a market whose cap is gone still gets this engine\'s floors back — never another engine\'s', async () => {
    const de = market(await inA(() => computeBudgetEnforcement({ month })), 'DE')
    expect(de).toMatchObject({ stopCapCents: null, stopBy: null, strategyCap: null, planCapCents: null, stopOverSpend: false, capReached: false })
    expect(de.campaigns).toEqual([expect.objectContaining({ id: ids.cDe, restore: true, suppress: false })])
  })

  it('on the 1st, the new month starts from 0: this engine\'s floors are given back, rank\'s stay', async () => {
    const it_ = market(await inA(() => computeBudgetEnforcement({ month: nextMonth })), 'IT')
    expect(it_).toMatchObject({ mtdSpendCents: 0, spendThrough: null, capReached: false, stopCapCents: 5_000 })
    expect(campaign(it_, ids.cOld)).toMatchObject({ restore: true, suppress: false })
    expect(campaign(it_, ids.cRank)).toMatchObject({ restore: false, suppress: false })
    expect(campaign(it_, ids.cA)).toMatchObject({ restore: false, suppress: false })
  })

  it('a budget plan with a lower cap and Stop Over Spend: the plan stops the market, and is named', async () => {
    const plan = await inA(() => db().adBudgetPlan.create({ data: { marketplace: 'IT', month, monthlyBudgetCents: 4_000, stopOverSpend: true } }))
    try {
      const it_ = market(await inA(() => computeBudgetEnforcement({ month })), 'IT')
      expect(it_).toMatchObject({ planCapCents: 4_000, strategyCap: { cents: 5_000 }, capCents: 4_000, stopCapCents: 4_000, stopBy: 'plan', capReached: true })
      // The stop bid is the strategy's whichever cap stopped the market.
      expect(campaign(it_, ids.cA)).toMatchObject({ suppress: true, stopBidCents: 9 })
    } finally {
      await inA(() => db().adBudgetPlan.delete({ where: { id: plan.id } }))
    }
  })

  it('a strategy cap of 0 is no cap: nothing is floored, and this engine\'s own floors are given back', async () => {
    await inA(() => db().adsStrategy.update({ where: { id: ids.marketRow }, data: { monthlySpendCapCents: 0 } }))
    try {
      const it_ = market(await inA(() => computeBudgetEnforcement({ month })), 'IT')
      expect(it_).toMatchObject({ strategyCap: null, stopCapCents: null, stopBy: null, stopOverSpend: false, capReached: false, mtdSpendCents: 5_500 })
      expect(it_.campaigns.filter((c) => c.suppress)).toEqual([])
      expect(campaign(it_, ids.cOld)).toMatchObject({ restore: true })
      expect(campaign(it_, ids.cRank)).toMatchObject({ restore: false })
    } finally {
      await inA(() => db().adsStrategy.update({ where: { id: ids.marketRow }, data: { monthlySpendCapCents: 5_000 } }))
    }
  })

  it('another business sees neither this business\'s spend nor its cap', async () => {
    const it_ = market(await inB(() => computeBudgetEnforcement({ month })), 'IT')
    expect(it_).toMatchObject({ mtdSpendCents: 0, strategyCap: { cents: 1, from: 'ads strategy: BRAVO market (IT) v1' }, capReached: false })
    expect(it_.campaigns.map((c) => c.name)).toEqual(['BRAVO IT'])
    expect(market(await inA(() => computeBudgetEnforcement({ month })), 'IT').strategyCap).toMatchObject({ cents: 5_000 })
  })
})

describe('a live run — the stop bid, the cap named, the market\'s own cap per run', () => {
  it('floors at the stop bid with the cap named; the market\'s "most actions per run" moves the next campaign to the next run', async () => {
    const run = await inA(() => applyBudgetEnforcement({ month, dryRun: false, actor: 'automation:budget-manager-cron' }))
    // The first IT campaign writes 3 changes, the market's cap (3 a run): the second waits. DE has no cap of its own.
    expect(run).toMatchObject({ dryRun: false, suppressed: 1, restored: 1, failed: 0 })
    expect(writes.suppress).toHaveBeenCalledTimes(1)
    const [floored, opts] = writes.suppress.mock.calls[0]!
    const want = floored === ids.cA ? { floorCents: 9, words: MARKET_WORDS } : { floorCents: 5, words: PRODUCT_WORDS }
    expect(opts).toMatchObject({ actor: 'automation:budget-manager-cron', floorCents: want.floorCents })
    expect(opts.reason).toBe(`stop over spend: IT monthly cap reached (${MARKET_WORDS}) → bids to ${want.floorCents}¢ (${want.words})`)
    expect(writes.restore).toHaveBeenCalledWith(ids.cDe, expect.objectContaining({ reason: 'stop over spend: DE has no monthly cap in force any more' }))
    expect(run.guard).toMatchObject({ posture: 'auto', deferredByCap: 1, marketCaps: [{ market: 'IT', perRun: 3, source: MARKET_WORDS, changes: 3, deferred: 1 }] })
  })

  it('a dry run writes nothing and asks nothing', async () => {
    const run = await inA(() => applyBudgetEnforcement({ month, dryRun: true }))
    expect(run).toMatchObject({ dryRun: true, suppressed: 0, restored: 0 })
    expect(writes.suppress).not.toHaveBeenCalled()
    expect(writes.restore).not.toHaveBeenCalled()
  })
})

describe('the retail guard stops at the strategy\'s stop bid too', () => {
  it('each campaign at its own market\'s stop bid (the lower across its products), else the 2¢ floor', async () => {
    await inA(() => applyRetailGuard({ campaignIds: [ids.cA, ids.cB, ids.cFr], actor: 'retail-guard-test' }))
    const asked = new Map(writes.suppress.mock.calls.map(([id, opts]) => [id, opts]))
    expect(asked.get(ids.cA)).toMatchObject({ floorCents: 9, reason: `Retail-readiness guard: products unsellable → bids floored at 9¢ (${MARKET_WORDS}) (no-pause)` })
    expect(asked.get(ids.cB)).toMatchObject({ floorCents: 5 })
    expect(asked.get(ids.cFr)).toMatchObject({ floorCents: 2, reason: 'Retail-readiness guard: products unsellable → bids floored (no-pause)' })
  })
})
