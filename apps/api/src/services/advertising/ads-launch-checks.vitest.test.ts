/**
 * CC-13 / CC-14 / CC-21 — the checks every builder shows before launch (and every launch runs again).
 *
 * Refusals are only what Amazon would refuse anyway or what cannot work; his own settings (bid policies, spend
 * ceilings) and Nexus's switches (the per-write cap, a market Nexus does not send to) are warnings and never stop it.
 * Real checks, the real write gate in LIVE mode, on PGlite with the shared fake ads account (IT writes enabled).
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
vi.mock('../../lib/queue.js', () => ({ redis: null, outboundSyncQueue: { add: vi.fn() }, addJobSafely: vi.fn() }))

import { goalLaunchPlan, launchChecks, singleLaunchPlan, spwLaunchPlan, NO_PRODUCTS, type LaunchPlan } from './ads-launch-checks.service.js'
import { planGoalScaffold, GOAL_AD_GROUP_BID_CENTS } from './ai-goal-materialize.service.js'

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const check = (plan: LaunchPlan) => inside(() => launchChecks(plan))
const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  market: 'IT', portfolioId: null, productCount: 1,
  campaigns: [{ name: 'Checks - SP - Exact', adProduct: 'SP', budgetCents: 1000, bidsCents: [75, 90] }],
  ...over,
})

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(async () => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  await inside(async () => { await database.client.adBidPolicy.deleteMany(); await database.client.adSpendCeiling.deleteMany() })
})

describe('refusals: what Amazon would refuse, or what cannot work', () => {
  it('a clean launch has nothing to say', async () => {
    expect(await check(plan())).toEqual({ refusals: [], warnings: [] })
  })

  it('CC-21 — no products is refused with the reason', async () => {
    expect((await check(plan({ productCount: 0 }))).refusals).toEqual([NO_PRODUCTS])
  })

  it('CC-13 — an empty name, a "·", two campaigns with one name, and a name the market already uses', async () => {
    const r = await check(plan({ campaigns: [
      { name: '  ', budgetCents: 1000, bidsCents: [75] },
      { name: 'Gale · Auto', budgetCents: 1000, bidsCents: [75] },
      { name: 'Twin', budgetCents: 1000, bidsCents: [75] },
      { name: 'twin ', budgetCents: 1000, bidsCents: [75] },
      { name: 'italy EXACT', budgetCents: 1000, bidsCents: [75] },
    ] }))
    expect(r.refusals).toEqual([
      'Every campaign needs a name.',
      expect.stringContaining('contains "·", which Amazon refuses in names'),
      expect.stringMatching(/^Two campaigns in this launch are named "Twin"/),
      expect.stringMatching(/^IT already has a campaign named "Italy exact"/),
    ])
  })

  it('CC-14 — a budget or bid outside Amazon\'s range in the market, and a bid above the budget, in Amazon\'s numbers', async () => {
    const r = await check(plan({ campaigns: [{ name: 'Range', budgetCents: 50, bidsCents: [1, 75] }] }))
    expect(r.refusals).toEqual([
      expect.stringMatching(/daily budget of €0\.50 is below Amazon's minimum of €1\.00 in IT/),
      expect.stringMatching(/bid of €0\.01 is below Amazon's minimum of €0\.02 in IT/),
      expect.stringMatching(/In "Range" a bid of €0\.75 is above the daily budget of €0\.50/),
    ])
  })
})

describe('warnings: his settings and Nexus\'s switches — never a block', () => {
  it('🔴 a bid policy the launch\'s bids fall outside is a WARNING, not a refusal', async () => {
    await inside(() => database.client.adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'Italy bids', minBidCents: 10, maxBidCents: 80, enabled: true } }))
    const r = await check(plan())
    expect(r.refusals).toEqual([])
    expect(r.warnings).toEqual([expect.stringMatching(/^Your bid policy "Italy bids" keeps bids between €0\.10 and €0\.80; this launch has 1 bid outside it \(€0\.90 to €0\.90\)/)])
  })

  it('🔴 a spend ceiling the new budgets would pass is a WARNING, not a refusal', async () => {
    await inside(() => database.client.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'Italy cap', dailyCapCents: 500, enabled: true } }))
    const r = await check(plan())
    expect(r.refusals).toEqual([])
    expect(r.warnings).toEqual([expect.stringMatching(/adds €10\.00 a day of budget.*spend ceiling "Italy cap" of €5\.00 a day\. It is your ceiling, so the launch is not stopped\./)])
  })

  it('a budget above Nexus\'s per-write cap says the campaign would be saved in Nexus only', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '5000')
    const r = await check(plan({ campaigns: [{ name: 'Big budget', budgetCents: 60000, bidsCents: [75] }] }))
    expect(r.refusals).toEqual([])
    expect(r.warnings).toEqual([expect.stringMatching(/"Big budget": a daily budget of €600\.00 is above Nexus's limit of €50\.00 for one change, so this campaign would be saved in Nexus only/)])
  })

  it('a market Nexus does not send to is a warning (saved in Nexus only), not a refusal', async () => {
    const r = await check(plan({ market: 'UK' }))
    expect(r.refusals).toEqual([])
    expect(r.warnings).toEqual([expect.stringMatching(/^Nexus would not send this launch to Amazon now \(Nexus does not change ads in UK/)])
  })
})

describe('the plan is read from the body each launch reads', () => {
  it('SP Super Wizard / Quick / Guided: blank bid €0.75, blank budget €10, every keyword, target and auto-group bid', () => {
    const p = spwLaunchPlan({
      market: 'DE', products: [{ sku: 'A' }, {}],
      campaigns: [
        { name: 'K', kind: 'keyword', keywords: ['one', { text: 'two', bidEur: 1.2 }, '  '] },
        { name: 'P', kind: 'pat', bidEur: 0.5, budgetEur: 20, productTargets: [{ asin: 'B0X' }] },
        { name: 'A', kind: 'auto', bidEur: 0.4, autoGroups: [{ key: 'CLOSE_MATCH', bidEur: 0.6 }, { key: 'LOOSE_MATCH' }] },
      ],
    })
    expect(p).toEqual({
      market: 'DE', portfolioId: null, productCount: 1,
      campaigns: [
        { name: 'K', adProduct: 'SP', budgetCents: 1000, bidsCents: [75, 75, 120] },
        { name: 'P', adProduct: 'SP', budgetCents: 2000, bidsCents: [50, 50] },
        { name: 'A', adProduct: 'SP', budgetCents: 1000, bidsCents: [40, 60, 40] },
      ],
    })
  })

  it('Single: a manual campaign with no keywords (or no product targets) cannot serve', () => {
    expect(singleLaunchPlan({ name: 'S', products: [{ sku: 'A' }], keywords: [] }).targetingMissing).toMatch(/at least one keyword/)
    expect(singleLaunchPlan({ name: 'S', products: [{ sku: 'A' }], targetMode: 'product' }).targetingMissing).toMatch(/at least one product to target/)
    expect(singleLaunchPlan({ name: 'S', products: [{ sku: 'A' }], keywords: [{ text: 'k' }] }).targetingMissing).toBeNull()
  })

  it('CC-13 — AI Goal names use " - ", never the "·" Amazon refuses', async () => {
    const scaffold = planGoalScaffold({ name: 'Gloves', aiTarget: 'SALES', budgetMode: 'STRICT', marketplace: 'IT',
      products: [{ asin: 'B0GOAL0001', budgetCents: 1000 }, { asin: 'B0GOAL0002', budgetCents: 1000 }] as never, seedKeywords: ['gloves'] })
    expect(scaffold.campaigns.map((c) => c.name)).toContain('[AI] Gloves - B0GOAL0001 - Auto')
    expect(scaffold.campaigns.every((c) => !c.name.includes('·'))).toBe(true)
    const r = await check(goalLaunchPlan(scaffold, null, GOAL_AD_GROUP_BID_CENTS))
    expect(r.refusals).toEqual([])
  })
})
