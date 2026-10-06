/**
 * Ads autonomy W0 — the target ACoS the Owner set steers Nexus's own bid optimiser (PGlite, production schema).
 *
 * Before: `previewBidOptimization` used the caller's flat target (30 % by default) or profit data, and auto-bid passed
 * neither the campaign's target nor the account default. Proven here, through the real reads: a campaign's own
 * `dynamicBidding.targetAcos` moves its proposals, the account default covers campaigns without one, profit data and the
 * caller's target come after; a stored value in the wrong unit is skipped and named, never converted; the Bayesian path
 * still runs and still says whose target it used; and every caller — auto-bid, a target-ACoS rule, an autopilot plan,
 * the previews — gets the same target for the same campaign. Made-up values only.
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
    redis: { connection: null },
  }
})
// Profit data is a stand-in: which ad groups it is asked for, and what it answers, is what is under test.
const profit = vi.hoisted(() => ({ byAdGroup: {} as Record<string, number>, asked: [] as string[] }))
vi.mock('./ads-target-acos.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeAdGroupTargetAcos: async (adGroupId: string) => {
    profit.asked.push(adGroupId)
    return { targetAcos: profit.byAdGroup[adGroupId] ?? null, products: 1 }
  },
}))

// The autopilot apply path: the gate lets the campaign through and the bid write is a recorder (nothing leaves the process).
vi.mock('./ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkAdsWriteGate: async () => ({ allowed: true, mode: 'live', profileId: 'P-TEST' }),
}))
const writes = vi.hoisted(() => ({ entries: [] as Array<{ adTargetId: string; bidCents: number }> }))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bulkUpdateAdTargetBids: async (args: { entries: Array<{ adTargetId: string; bidCents: number }> }) => {
    writes.entries.push(...args.entries)
    return { applied: args.entries.length, skipped: 0, failed: 0, chunks: 1, outcomes: args.entries.map((_e, i) => ({ actionLogId: `log-${i}` })) }
  },
}))

const { previewBidOptimization } = await import('./ads-bid-optimizer.service.js')
const { applyPlanActions } = await import('./autopilot/apply.js')
const { DEFAULT_GUARDRAILS } = await import('./autopilot/presets.js')
const { AUTO_BID_OPTIMIZER_OPTIONS } = await import('./ads-auto-bid.service.js')
const { setBidAutomation } = await import('./campaign-settings.service.js')
const { setDefaultTargetAcosPct } = await import('./ads-automation-state.service.js')
const { ACTION_HANDLERS } = await import('../automation-rule.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Preview = Awaited<ReturnType<typeof previewBidOptimization>>
const preview = (opts: Parameters<typeof previewBidOptimization>[0] = {}) => inside(() => previewBidOptimization(opts))
const of = (out: Preview, targetId: string) => out.proposals.find((p) => p.targetId === targetId)!
/** A campaign's stored target exactly as a writer left it (the rule action stores whatever its config holds). */
const storeRaw = (campaignId: string, targetAcos: unknown) =>
  inside(() => database.client.campaign.update({ where: { id: campaignId }, data: { dynamicBidding: { targetAcos } } }))
const clearCampaignTargets = () => inside(async () => {
  for (const id of ['c-it', 'c-uk', 'c-off', 'c-sb', 'c-pin']) await database.client.campaign.update({ where: { id }, data: { dynamicBidding: {} } })
})

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    // Two keywords that spent, 20 clicks, 2 orders, ACoS 50 % — read from the AdTarget columns (the `legacy` source).
    for (const id of ['t-it', 't-uk']) {
      await database.client.adTarget.update({ where: { id }, data: { clicks: 20, spendCents: 1000, salesCents: 2000, ordersCount: 2 } })
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(async () => {
  delete process.env.NEXUS_BID_OPTIMIZER_SOURCE
  profit.byAdGroup = {}
  profit.asked = []
  await clearCampaignTargets()
  await inside(() => setDefaultTargetAcosPct(null, 'test'))
})

describe('W0 — whose target the optimiser moves a bid toward', () => {
  it('no target set anywhere: exactly as before (flat 30 %, no label)', async () => {
    const out = await preview()
    expect(out.targetAcos).toBe(0.3)
    // ACoS 50 % > 30 %: ratio 0.6 → 45¢ × 0.6 = 27¢.
    expect(of(out, 't-it')).toMatchObject({ currentBidCents: 45, proposedBidCents: 27, targetAcosUsed: 0.3, targetBasis: 'flat', targetSource: 'flat', reason: 'ACOS 50% > target 30% — lower' })
  })

  it("a campaign's own target ACoS changes its proposal; a campaign without one keeps the flat target", async () => {
    // Written as the screens and Claude's set-campaign-target-acos write it: a fraction, through the same service.
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    const out = await preview()
    // 50 % > 40 %: ratio 0.8 → 45¢ × 0.8 = 36¢ (it was 27¢ toward the flat 30 %).
    expect(of(out, 't-it')).toMatchObject({ proposedBidCents: 36, targetAcosUsed: 0.4, targetBasis: 'campaign', targetSource: 'campaign', reason: 'ACOS 50% > target 40% (campaign target) — lower' })
    expect(of(out, 't-uk')).toMatchObject({ proposedBidCents: 36, targetAcosUsed: 0.3, targetBasis: 'flat' })
  })

  it('the account default covers every campaign without its own target; the campaign target still wins', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    const out = await preview({ targetAcos: 0.2 })
    expect(of(out, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetSource: 'campaign' })
    // 50 % > 45 %: ratio 0.9 → 60¢ × 0.9 = 54¢. The caller's 20 % comes after the Owner's numbers.
    expect(of(out, 't-uk')).toMatchObject({ proposedBidCents: 54, targetAcosUsed: 0.45, targetBasis: 'account', targetSource: 'account', reason: 'ACOS 50% > target 45% (account default) — lower' })
  })

  it('a campaign storing 30 (a percent in the fraction field) is skipped, never read as 3,000 % or guessed as 30 %', async () => {
    await storeRaw('c-it', 30)
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    expect(of(await preview(), 't-it')).toMatchObject({
      targetAcosUsed: 0.45, targetSource: 'account',
      reason: 'ACOS 50% > target 45% (account default) [campaign target 30 skipped: not a fraction above 0 and at most 1] — lower',
    })
    // An account default above 100 % is skipped as well: the flat target answers, and both skips are named.
    await inside(() => setDefaultTargetAcosPct(150, 'test'))
    expect(of(await preview(), 't-it')).toMatchObject({ targetAcosUsed: 0.3, targetSource: 'flat', reason: expect.stringContaining('account default 150 skipped') })
  })

  it('profit mode: the Owner\'s target wins over profit data, which is only worked out for the ad groups left open', async () => {
    profit.byAdGroup = { 'g-c-it': 0.12, 'g-c-uk': 0.25 }
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    const out = await preview({ profitMode: true })
    expect(profit.asked).toEqual(['g-c-uk'])
    expect(of(out, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetSource: 'campaign' })
    expect(of(out, 't-uk')).toMatchObject({ targetAcosUsed: 0.25, targetBasis: 'profit', targetSource: 'profit', reason: expect.stringContaining('(profit-derived)') })
    // With an account default, no profit target is needed at all.
    profit.asked = []
    await inside(() => setDefaultTargetAcosPct(35, 'test'))
    expect(of(await preview({ profitMode: true }), 't-uk')).toMatchObject({ targetAcosUsed: 0.35, targetSource: 'account' })
    expect(profit.asked).toEqual([])
  })

  it('the Bayesian sparse-data path still runs: its basis stays "bayesian", and targetSource says whose target it used', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    const out = await preview({ bayesian: true })
    expect(of(out, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetBasis: 'bayesian', targetSource: 'campaign', reason: expect.stringMatching(/target 40% \(campaign target\) — (lower|raise) \(Bayesian CR/) })
    expect(of(out, 't-uk')).toMatchObject({ targetAcosUsed: 0.3, targetBasis: 'bayesian', targetSource: 'flat' })
  })
})

describe('W0 — every caller gets the same target for the same campaign', () => {
  it('auto-bid, a target-ACoS rule, an autopilot plan, the previews and the recommendations', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    profit.byAdGroup = { 'g-c-it': 0.12, 'g-c-uk': 0.12 }
    const used = (out: Preview) => ({ it: of(out, 't-it').targetAcosUsed, uk: of(out, 't-uk').targetAcosUsed })

    const autoBid = await preview(AUTO_BID_OPTIMIZER_OPTIONS) // ads-auto-bid.service.ts and the A4 preview
    const recommendations = await preview({ targetAcos: undefined }) // ads-recommendations.service.ts
    const screen = await preview({ targetAcos: 0.25, profitMode: true }) // GET /advertising/bid-optimizer/preview
    const autopilotSimulate = await preview({ profitMode: true, bayesian: true, mode: 'growth', targetAcos: 0.6 }) // ads-autopilot.service.ts
    const autopilotPlan = await preview({ campaignId: 'c-it', targetAcos: 1.2, bayesian: true, profitMode: false }) // autopilot/apply.ts
    for (const out of [autoBid, recommendations, screen, autopilotSimulate]) expect(used(out)).toEqual({ it: 0.4, uk: 0.45 })
    expect(of(autopilotPlan, 't-it').targetAcosUsed).toBe(0.4)

    // A `bid_to_target_acos` rule with a target of its own (its dry run shows the proposals it would apply).
    const rule = await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', targetAcos: 0.2, campaignId: 'c-it', bayesian: true }, {} as never, { dryRun: true, ruleId: 'r-test' } as never))
    expect(rule).toMatchObject({ ok: true, output: { dryRun: true, wouldChange: 1 } })
    expect((rule.output as { sample: Array<{ targetId: string; targetAcosUsed: number; targetSource: string }> }).sample[0]).toMatchObject({ targetId: 't-it', targetAcosUsed: 0.4, targetSource: 'campaign' })
  })

  it('an autopilot plan records the target its bids actually moved toward, not its own when the campaign has one', async () => {
    const plan = { planId: 'plan-test', goal: 'BALANCED' as const, marketplace: 'IT', guardrails: DEFAULT_GUARDRAILS, signals: [], actions: [{ module: 'bid' as const, campaignId: 'c-it', action: 'BID_LOWER' as const, reason: 'test', priority: 60 }] }
    // No campaign target: the plan's own (30 % at BALANCED with the default guardrails).
    let out = await inside(() => applyPlanActions(plan))
    expect(out.decisions[0]).toMatchObject({ status: 'APPLIED', after: { targets: 1, targetAcosPct: 30, targetSource: 'flat' }, reason: "Optimised 1 keyword bids → 30% target ACoS (this plan's target)" })
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    out = await inside(() => applyPlanActions(plan))
    expect(out.decisions[0]).toMatchObject({ status: 'APPLIED', after: { targets: 1, targetAcosPct: 40, targetSource: 'campaign' }, reason: "Optimised 1 keyword bids → 40% target ACoS (this campaign's target ACoS)" })
    expect(writes.entries.every((e) => e.adTargetId === 't-it')).toBe(true)
  })

  it("auto-bid's preview runs with auto-bid's own options (profit mode + Bayesian), not the bare flat call", () => {
    expect(AUTO_BID_OPTIMIZER_OPTIONS).toEqual({ profitMode: true, bayesian: true })
  })
})
