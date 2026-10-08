/**
 * Ads autonomy W0 — the target ACoS the Owner set steers Nexus's own bid optimiser (PGlite, production schema).
 *
 * Before: `previewBidOptimization` used the caller's flat target (30 % by default) or profit data, and auto-bid passed
 * neither the campaign's target nor the account default. Proven here, through the real reads, in the order the Owner
 * set (a number someone configured beats a more general one): a caller's explicit target (a rule's, a plan's, a typed
 * one) → the campaign's own `dynamicBidding.targetAcos` → the account default → profit data → the fallback. A stored
 * value outside what the screens take (above 0, at most 500 %) is skipped and named, never converted; a launch target
 * above 100 % is read; the Bayesian path still runs and says whose target it used; callers without a target of their
 * own get the same target for the same campaign. Made-up values only.
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
    // Two keywords that spent, 20 clicks, 2 orders, ACoS 50 % — read from the AdTarget columns (the `legacy` source). Both
    // paid 50¢ a click: t-it at a 45¢ bid (r̂ held to 1.0), t-uk at a 60¢ bid (r̂ 0.83, review 2026-10-08 A).
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
    // ACoS 50 % > 30 %: the goal is 30 % of €1.00 sales a click = 30¢ (C3: before, 45¢ × 30/50 = 27¢, again every run).
    expect(of(out, 't-it')).toMatchObject({ currentBidCents: 45, proposedBidCents: 30, targetAcosUsed: 0.3, targetBasis: 'flat', targetSource: 'flat', reason: 'ACOS 50% > target 30% — lower toward 30¢ (30% of €1.00 sales a click ÷ r̂ 1.00 (paid CPC ÷ bid: its own, 20 clicks))' })
  })

  it("a campaign's own target ACoS changes its proposal; a campaign without one keeps the flat target", async () => {
    // Written as the screens and Claude's set-campaign-target-acos write it: a fraction, through the same service.
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    const out = await preview()
    // 50 % > 40 %: the goal is 40¢ (it was 30¢ toward the flat 30 %).
    expect(of(out, 't-it')).toMatchObject({ proposedBidCents: 40, targetAcosUsed: 0.4, targetBasis: 'campaign', targetSource: 'campaign', reason: 'ACOS 50% > target 40% (campaign target) — lower toward 40¢ (40% of €1.00 sales a click ÷ r̂ 1.00 (paid CPC ÷ bid: its own, 20 clicks))' })
    // 60¢ toward its goal: a 30¢ CPC, bought at 36¢ (it pays 83 % of its bid); the 50 % step reaches it.
    expect(of(out, 't-uk')).toMatchObject({ proposedBidCents: 36, targetAcosUsed: 0.3, targetBasis: 'flat' })
  })

  it('the account default covers every campaign without its own target; the campaign target still wins', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    const out = await preview()
    expect(of(out, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetSource: 'campaign' })
    // 50 % > 45 %: the goal is a 45¢ CPC, bought at 54¢ (it pays 83 % of its 60¢ bid).
    expect(of(out, 't-uk')).toMatchObject({ proposedBidCents: 54, targetAcosUsed: 0.45, targetBasis: 'account', targetSource: 'account', reason: 'ACOS 50% > target 45% (account default) — lower toward 54¢ (45% of €1.00 sales a click ÷ r̂ 0.83 (paid CPC ÷ bid: its own, 20 clicks))' })
  })

  it("a caller's explicit target wins over the campaign's and the account default, and the reason names it", async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    const out = await preview({ targetAcos: 0.2, targetAcosFrom: 'the target asked for' })
    expect(out.targetAcos).toBe(0.2)
    // 50 % > 20 %: the goal is 20¢, and one step (50 %) reaches 45¢ × 0.5 ≈ 23¢ on the way.
    expect(of(out, 't-it')).toMatchObject({ proposedBidCents: 23, targetAcosUsed: 0.2, targetBasis: 'explicit', targetSource: 'explicit', reason: 'ACOS 50% > target 20% (the target asked for) — lower toward 20¢ (20% of €1.00 sales a click ÷ r̂ 1.00 (paid CPC ÷ bid: its own, 20 clicks))' })
    expect(of(out, 't-uk')).toMatchObject({ targetAcosUsed: 0.2, targetSource: 'explicit' })
    // A fallback is not explicit: it comes last, so it never masks the campaign's target.
    const fallback = await preview({ fallbackTargetAcos: 0.2 })
    expect(of(fallback, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetSource: 'campaign' })
  })

  it('a launch target above 100 % is read; a campaign storing 30 (a percent in the fraction field) is skipped, never converted', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 1.5 }))
    // 50 % < 150 % with orders: toward the 150¢ goal, one step (+25 %) → 45¢ × 1.25 ≈ 56¢.
    expect(of(await preview(), 't-it')).toMatchObject({ proposedBidCents: 56, targetAcosUsed: 1.5, targetSource: 'campaign' })
    await storeRaw('c-it', 30)
    // (40 %, not 45 %: t-it's 45¢ is its goal at 45 %, and a bid at its goal proposes nothing — C3.)
    await inside(() => setDefaultTargetAcosPct(40, 'test'))
    expect(of(await preview(), 't-it')).toMatchObject({
      targetAcosUsed: 0.4, targetSource: 'account',
      reason: 'ACOS 50% > target 40% (account default) [campaign target 30 skipped: not a fraction above 0 and at most 5] — lower toward 40¢ (40% of €1.00 sales a click ÷ r̂ 1.00 (paid CPC ÷ bid: its own, 20 clicks))',
    })
    // An account default of 150 % is read too.
    await inside(() => setDefaultTargetAcosPct(150, 'test'))
    expect(of(await preview(), 't-it')).toMatchObject({ targetAcosUsed: 1.5, targetSource: 'account', reason: expect.stringContaining('campaign target 30 skipped') })
  })

  it("profit mode: a configured target wins over profit data, which is only worked out for the ad groups left open", async () => {
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
    expect(of(out, 't-it')).toMatchObject({ targetAcosUsed: 0.4, targetBasis: 'bayesian', targetSource: 'campaign', reason: expect.stringMatching(/target 40% \(campaign target\) — (lower|raise) toward \d+¢ \(Bayesian CR/) })
    expect(of(out, 't-uk')).toMatchObject({ targetAcosUsed: 0.3, targetBasis: 'bayesian', targetSource: 'flat' })
  })
})

describe('W0 — every caller of the optimiser', () => {
  it('without a target of its own, gets the same target for the same campaign', async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    await inside(() => setDefaultTargetAcosPct(45, 'test'))
    profit.byAdGroup = { 'g-c-it': 0.12, 'g-c-uk': 0.12 }
    const used = (out: Preview) => ({ it: of(out, 't-it').targetAcosUsed, uk: of(out, 't-uk').targetAcosUsed })
    const autoBid = await preview(AUTO_BID_OPTIMIZER_OPTIONS) // ads-auto-bid.service.ts and the A4 preview
    const recommendations = await preview({}) // ads-recommendations.service.ts, with no ?targetAcos
    const screen = await preview({ profitMode: true }) // GET /advertising/bid-optimizer/preview, with no ?targetAcos
    const autopilotSimulate = await preview({ profitMode: true, bayesian: true, mode: 'growth' }) // ads-autopilot.service.ts, with none
    const planWithoutTarget = await preview({ campaignId: 'c-it', fallbackTargetAcos: 0.48, bayesian: true }) // autopilot/apply.ts
    for (const out of [autoBid, recommendations, screen, autopilotSimulate]) expect(used(out)).toEqual({ it: 0.4, uk: 0.45 })
    expect(of(planWithoutTarget, 't-it').targetAcosUsed).toBe(0.4)
    // A `bid_to_target_acos` rule without a target of its own (its dry run shows the proposals it would apply).
    const rule = await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', campaignId: 'c-it', bayesian: true }, {} as never, { dryRun: true, ruleId: 'r-test' } as never))
    expect((rule.output as { sample: Array<{ targetId: string; targetAcosUsed: number; targetSource: string }> }).sample[0]).toMatchObject({ targetId: 't-it', targetAcosUsed: 0.4, targetSource: 'campaign' })
  })

  it("with a target of its own (a rule's, a typed one), moves toward that one — 150 % included", async () => {
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    const rule = await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', targetAcos: 0.2, campaignId: 'c-it', bayesian: true }, {} as never, { dryRun: true, ruleId: 'r-test' } as never))
    expect(rule).toMatchObject({ ok: true, output: { dryRun: true, wouldChange: 1 } })
    expect((rule.output as { sample: Array<{ targetAcosUsed: number; targetSource: string; reason: string }> }).sample[0]).toMatchObject({ targetAcosUsed: 0.2, targetSource: 'explicit', reason: expect.stringContaining("(this rule's target)") })
    const launch = await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', targetAcos: 1.5, campaignId: 'c-it' }, {} as never, { dryRun: true, ruleId: 'r-test' } as never))
    expect((launch.output as { sample: Array<{ targetAcosUsed: number }> }).sample[0]).toMatchObject({ targetAcosUsed: 1.5 })
    // 30 stored in the fraction field is still refused, never read as 3,000 %.
    expect(await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', targetAcos: 30, campaignId: 'c-it' }, {} as never, { dryRun: true, ruleId: 'r-test' } as never)))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^targetAcos must be a fraction above 0 and at most 5/) })
    expect(of(await preview({ targetAcos: 0.25, profitMode: true }), 't-it')).toMatchObject({ targetAcosUsed: 0.25, targetSource: 'explicit' })
  })

  it('an autopilot plan: its own stored target wins; without one, its goal default comes last; the decision records which', async () => {
    const plan = { planId: 'plan-test', goal: 'BALANCED' as const, marketplace: 'IT', guardrails: DEFAULT_GUARDRAILS, signals: [], actions: [{ module: 'bid' as const, campaignId: 'c-it', action: 'BID_LOWER' as const, reason: 'test', priority: 60 }] }
    // No campaign target, no target of the plan's own: its goal default (30 % at BALANCED with the default guardrails).
    let out = await inside(() => applyPlanActions(plan))
    expect(out.decisions[0]).toMatchObject({ status: 'APPLIED', after: { targets: 1, targetAcosPct: 30, targetSource: 'flat' }, reason: "Optimised 1 keyword bids → 30% target ACoS (this plan's goal default)" })
    await inside(() => setBidAutomation('c-it', { targetAcos: 0.4 }))
    out = await inside(() => applyPlanActions(plan))
    expect(out.decisions[0]).toMatchObject({ status: 'APPLIED', after: { targets: 1, targetAcosPct: 40, targetSource: 'campaign' }, reason: "Optimised 1 keyword bids → 40% target ACoS (this campaign's target ACoS)" })
    // The plan stores its own target: it wins over the campaign's.
    out = await inside(() => applyPlanActions({ ...plan, guardrails: { ...DEFAULT_GUARDRAILS, targetAcosPct: 25 }, planSetsTargetAcos: true }))
    expect(out.decisions[0]).toMatchObject({ status: 'APPLIED', after: { targets: 1, targetAcosPct: 25, targetSource: 'explicit' }, reason: "Optimised 1 keyword bids → 25% target ACoS (this plan's target)" })
    expect(writes.entries.every((e) => e.adTargetId === 't-it')).toBe(true)
  })

  it("auto-bid's preview runs with auto-bid's own options (profit mode + Bayesian), not the bare flat call", () => {
    expect(AUTO_BID_OPTIMIZER_OPTIONS).toEqual({ profitMode: true, bayesian: true })
  })
})
