/**
 * Group 1 (1d) — budget enforcement, budget schedules, pools, top-of-search defense, the coverage engine, autopilot
 * and auto-bid honour the account dial and their own caps, end to end (1c did rank-defend and dayparting:
 * ad-engine-dial-caps.vitest.test.ts).
 *
 * The hole this closes for budget enforcement: 1a lets a FLOOR pass a halt at the gate, but enforcement called
 * `restoreCampaignBids` with no dial check — it moves Nexus's own bids and clears its memory BEFORE the gate refuses
 * the raise, so Nexus would show the old bids while Amazon stays at 2¢. Its pacing writes were refused the same way,
 * after the local change. While stopped neither runs now; `bidsSuppressedAt` stays set and the first run after
 * Resume restores.
 *
 * The real jobs, the real write services, the real enqueue and the real worker on PGlite with the production schema.
 * The gate is a stand-in that answers as the real one does on the halt alone (stopped: only a suppression passes);
 * Amazon is a recorder. The optimiser's maths (auto-bid) and the conductor's (autopilot) are stand-ins too: what is
 * under test is what the engine does with their answer. Nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
const gate = vi.hoisted(() => ({ halted: false }))
// 1e — the Run-now guard (switch, scheduler arm flags, engine lock) is proven in ads-engine-lock.vitest.test.ts; every
// run gets through it here (budget enforcement takes the lock only, ToS and auto-bid the whole guard).
vi.mock('../services/advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
  withEngineLock: async (_workspaceId: string, _engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => (gate.halted && !ctx.isSuppression
    ? { allowed: false, deniedAt: 'automation_halted', reason: 'ads automation is stopped (halted: test)' }
    : { allowed: true, mode: 'live', profileId: 'P-TEST' }),
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, _externalId: string, patch: Record<string, unknown>) => { amazon.calls.push(patch); return { ok: true, rawResponse: {} } }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record }
})
const optimiser = vi.hoisted(() => ({ proposals: [] as Array<{ targetId: string; currentBidCents: number; proposedBidCents: number; deltaCents: number }> }))
vi.mock('../services/advertising/ads-bid-optimizer.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewBidOptimization: async () => ({ targetAcos: 0.3, profitMode: true, bayesian: true, proposals: optimiser.proposals }),
}))
const conductor = vi.hoisted(() => ({ actions: [] as Array<Record<string, unknown>> }))
vi.mock('../services/advertising/autopilot/conductor.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runConductorCycle: () => ({ targetAcosByCampaign: {}, actions: conductor.actions, skipped: [] }),
}))

const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
const { runBudgetEnforceOnce } = await import('./ad-budget-enforce.job.js')
const { runBudgetScheduleOnce, budgetScheduleSummaryLine } = await import('./ad-budget-schedule.job.js')
const { runBudgetPoolRebalanceOnce } = await import('./budget-pool-rebalance.job.js')
const { runTosDefenseOnce } = await import('./ads-tos-defense.job.js')
const { runAutopilotOnce, autopilotSummaryLine } = await import('./ad-autopilot.job.js')
const { runCoverageEngineOnce, coverageEngineSummaryLine } = await import('../services/advertising/ads-coverage-engine.service.js')
const { runAutoBidOnce, autoBidSummaryLine } = await import('../services/advertising/ads-auto-bid.service.js')
const { currentMonth } = await import('../services/advertising/ads-budget-manager.service.js')
const { ENGINE_CAPS_ENV } = await import('../services/advertising/ads-engine-actors.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** The account dial, as the Control Room would leave it. */
const dial = (autonomy: 'AUTO' | 'SUGGEST' | 'OFF', halted = false) => {
  gate.halted = halted || autonomy === 'OFF'
  return inside(() => db().adsAutomationState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', autonomy, halted, haltReason: halted ? 'test halt' : null },
    update: { autonomy, halted, haltReason: halted ? 'test halt' : null },
  }))
}

/** One campaign: an ad group (default bid) and keyword targets (bids). `suppressedBy` seeds a campaign already floored. */
async function seedCampaign(id: string, groupBid: number, targetBids: number[], o: { marketplace?: string; dailyBudget?: number; suppressedBy?: string; portfolioId?: string } = {}) {
  const suppressed = o.suppressedBy != null
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: o.marketplace ?? 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: String(o.dailyBudget ?? 20), startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        ...(o.portfolioId ? { portfolioId: o.portfolioId } : {}),
        ...(suppressed ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: o.suppressedBy } : {}),
      },
    })
    await db().adGroup.create({
      data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: suppressed ? 2 : groupBid, ...(suppressed ? { suppressedFromBidCents: groupBid } : {}) },
    })
    for (const [i, bid] of targetBids.entries()) {
      await db().adTarget.create({
        data: {
          id: `${id}-t${i}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw ${i}`,
          bidCents: suppressed ? 2 : bid, externalTargetId: `EXT-${id}-t${i}`, ...(suppressed ? { suppressedFromBidCents: bid } : {}),
        },
      })
    }
  })
}
const campaign = (id: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id }, select: { bidsSuppressedAt: true, dailyBudget: true, dynamicBidding: true } })
  const g = await db().adGroup.findMany({ where: { campaignId: id }, select: { defaultBidCents: true, suppressedFromBidCents: true } })
  const t = await db().adTarget.findMany({ where: { adGroup: { campaignId: id } }, orderBy: { id: 'asc' }, select: { bidCents: true, suppressedFromBidCents: true } })
  return { suppressed: c.bidsSuppressedAt != null, budget: Number(c.dailyBudget), placement: c.dynamicBidding, group: g[0], targets: t }
})
/** Drain the queue: what reached Amazon, and how the rows settled. */
async function drain() {
  amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(100))
  const rows = await inside(() => db().outboundSyncQueue.findMany({ where: { id: { in: out.results.map((r: { queueId: string }) => r.queueId) } }, select: { syncStatus: true } }))
  return { processed: out.processed as number, statuses: rows.map((r: { syncStatus: string }) => r.syncStatus), calls: amazon.calls }
}
const sortCalls = (calls: Array<Record<string, unknown>>) => calls.map((c) => JSON.stringify(c)).sort()
const caps = (value: Record<string, Record<string, number>>) => { process.env[ENGINE_CAPS_ENV] = JSON.stringify(value) }

const ENV = [ENGINE_CAPS_ENV, 'NEXUS_BUDGET_ENFORCE_APPLY', 'NEXUS_COVERAGE_ENGINE_MODE', 'NEXUS_TOS_TARGET_ACOS', 'NEXUS_TOS_TARGET_IS'] as const
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  await database?.close()
})
beforeEach(async () => {
  for (const k of ENV) delete process.env[k]
  await dial('AUTO')
  await drain() // nothing from an earlier arm is left in the queue
})

describe('budget enforcement (the known hole): while stopped the floor lands and nothing else is attempted', () => {
  it('halt → floor lands, pacing not written → restore not attempted while halted → after Resume the restore lands', async () => {
    process.env.NEXUS_BUDGET_ENFORCE_APPLY = '1'
    // FR is this arm's own market: enforcement reads every enabled campaign of the plan's market.
    await seedCampaign('en-a', 40, [35, 60], { marketplace: 'FR' })
    const month = currentMonth()
    const first = new Date(`${month}-01T00:00:00Z`)
    await inside(async () => {
      await db().adBudgetPlan.create({ data: { id: 'en-plan', marketplace: 'FR', month, monthlyBudgetCents: 1_000, autoPacing: true, stopOverSpend: true } })
      await db().amazonAdsDailyPerformance.create({
        data: { profileId: 'P-FR', marketplace: 'FR', adProduct: 'SPONSORED_PRODUCTS', date: first, entityType: 'CAMPAIGN', entityId: 'EXT-en-a', localEntityId: 'en-a', costMicros: 20_000_000n, currencyCode: 'EUR', reportedAt: new Date() },
      })
    })
    await dial('AUTO', true)

    // 1. Halted, €20 spent of a €10 cap: the floor is the one change allowed; pacing (€20 → €1) is not attempted.
    const floorRun = await inside(() => runBudgetEnforceOnce())
    expect(floorRun).toContain('applied=0 suppress=1 restore=0 failed=0 (LIVE)')
    expect(floorRun).toContain(' waiting=1 (stopped — halted: test halt: only bid floors land when a cap is reached; restores and budget pacing wait for Resume)')
    expect(await campaign('en-a')).toMatchObject({ suppressed: true, budget: 20, group: { defaultBidCents: 2 }, targets: [{ bidCents: 2 }, { bidCents: 2 }] })
    const floored = await drain()
    expect(floored.statuses).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS'])
    expect(sortCalls(floored.calls)).toEqual(sortCalls([{ bid: 0.02 }, { bid: 0.02 }, { defaultBid: 0.02 }]))

    // 2. Still halted, back under the cap: the restore is NOT attempted. Before 1d it ran here — Nexus back at
    //    35/60/40, its memory cleared — and the gate refused all three: Amazon stranded at 2¢.
    await inside(() => db().adBudgetPlan.update({ where: { id: 'en-plan' }, data: { monthlyBudgetCents: 1_000_000 } }))
    const heldRun = await inside(() => runBudgetEnforceOnce())
    expect(heldRun).toContain('restore=0')
    expect(heldRun).toContain(' waiting=1 (stopped')
    expect(await campaign('en-a')).toMatchObject({
      suppressed: true, group: { defaultBidCents: 2, suppressedFromBidCents: 40 },
      targets: [{ bidCents: 2, suppressedFromBidCents: 35 }, { bidCents: 2, suppressedFromBidCents: 60 }],
    })
    expect((await drain()).processed).toBe(0)

    // 3. Resume: the first run restores exactly, and Amazon gets the raises. A normal run's line is unchanged.
    await dial('AUTO', false)
    const restoreRun = await inside(() => runBudgetEnforceOnce())
    expect(restoreRun).toMatch(/restore=1 failed=0 \(LIVE\)$/)
    expect(await campaign('en-a')).toMatchObject({
      suppressed: false, group: { defaultBidCents: 40, suppressedFromBidCents: null },
      targets: [{ bidCents: 35, suppressedFromBidCents: null }, { bidCents: 60, suppressedFromBidCents: null }],
    })
    const restored = await drain()
    expect(restored.statuses).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS'])
    expect(sortCalls(restored.calls)).toEqual(sortCalls([{ bid: 0.35 }, { bid: 0.6 }, { defaultBid: 0.4 }]))

    // 4. SUGGEST (Owner S2): over the cap, no new floor (would-apply); back under it, its own floor is still given back.
    await seedCampaign('en-b', 40, [35], { marketplace: 'FR', suppressedBy: 'automation:budget-manager-cron' })
    await inside(() => db().adBudgetPlan.update({ where: { id: 'en-plan' }, data: { monthlyBudgetCents: 1_000, autoPacing: false } }))
    await dial('SUGGEST')
    const suggestOver = await inside(() => runBudgetEnforceOnce())
    expect(suggestOver).toContain('suppress=0')
    expect(suggestOver).toContain(' would-apply=1 (the account ads dial is SUGGEST: no pacing and no new floors; it still restores bids it floored over the cap)')
    expect((await campaign('en-a')).suppressed).toBe(false)
    await inside(() => db().adBudgetPlan.update({ where: { id: 'en-plan' }, data: { monthlyBudgetCents: 1_000_000 } }))
    expect(await inside(() => runBudgetEnforceOnce())).toContain('restore=1')
    expect(await campaign('en-b')).toMatchObject({ suppressed: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 35 }] })
    await inside(() => db().adBudgetPlan.delete({ where: { id: 'en-plan' } }))
  })
})

describe('budget schedules: SUGGEST enters no window and does not commit the entry; a give-back waits while stopped', () => {
  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '', end: '', adj: 'set', value: 30 }))
  const memo = (id: string) => inside(async () => ((await db().budgetSchedule.findUnique({ where: { id }, select: { lastApplied: true } })).lastApplied ?? {}) as Record<string, { windowKey?: string; state?: string }>)

  it('SUGGEST → nothing written, no key → AUTO enters properly → stopped: the give-back waits, its key kept → Resume gives back', async () => {
    await seedCampaign('bs-a', 40, [35], { dailyBudget: 20 })
    await inside(() => db().budgetSchedule.create({ data: { id: 'bs-s', name: 'bs-s', timezone: 'UTC', windows: EVERY_DAY, campaigns: [{ id: 'bs-a', dailyBudget: 20 }] } }))

    await dial('SUGGEST')
    const suggest = await inside(() => runBudgetScheduleOnce())
    expect(suggest).toMatchObject({ changed: 0, guard: { posture: 'suggest', wouldApply: 1, changes: 0 } })
    expect(budgetScheduleSummaryLine(suggest)).toBe('evaluated=1 changed=0 yielded=0 refused=0 would-apply=1 (the account ads dial is SUGGEST: no window is entered; a budget it set is still given back when its window closes)')
    expect((await campaign('bs-a')).budget).toBe(20)
    expect((await memo('bs-s'))['bs-a']).toBeUndefined() // the entry key is NOT committed

    await dial('AUTO')
    const entered = await inside(() => runBudgetScheduleOnce())
    expect(entered).toMatchObject({ changed: 1, guard: { posture: 'auto', changes: 1 } })
    expect(budgetScheduleSummaryLine(entered)).toBe('evaluated=1 changed=1 yielded=0 refused=0')
    expect((await campaign('bs-a')).budget).toBe(30)
    const key = (await memo('bs-s'))['bs-a'].windowKey!
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}#/)
    expect((await drain()).statuses).toEqual(['SUCCESS'])

    // The window closes while halted: the give-back (€30 → €20) would be refused at the gate after Nexus moved.
    await inside(() => db().budgetSchedule.update({ where: { id: 'bs-s' }, data: { windows: [] } }))
    await dial('AUTO', true)
    const held = await inside(() => runBudgetScheduleOnce())
    expect(held).toMatchObject({ changed: 0, guard: { posture: 'stopped', waiting: 1 } })
    expect((await campaign('bs-a')).budget).toBe(30)
    expect((await memo('bs-s'))['bs-a'].windowKey).toBe(key) // still owed
    expect((await drain()).processed).toBe(0)

    await dial('AUTO', false)
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 1 })
    expect((await campaign('bs-a')).budget).toBe(20)
    expect((await memo('bs-s'))['bs-a'].windowKey).toBe(`${key}#restore`)
    expect((await drain()).statuses).toEqual(['SUCCESS'])
    await inside(() => db().budgetSchedule.update({ where: { id: 'bs-s' }, data: { enabled: false } }))
  })

  it('the run cap defers a whole campaign to the next run, its entry uncommitted', async () => {
    caps({ 'budget-schedules': { perTick: 1 } })
    await seedCampaign('bs-c1', 40, [35], { dailyBudget: 20 })
    await seedCampaign('bs-c2', 40, [35], { dailyBudget: 20 })
    await inside(() => db().budgetSchedule.create({ data: { id: 'bs-cap', name: 'bs-cap', timezone: 'UTC', windows: EVERY_DAY, campaigns: [{ id: 'bs-c1', dailyBudget: 20 }, { id: 'bs-c2', dailyBudget: 20 }] } }))
    const first = await inside(() => runBudgetScheduleOnce())
    expect(first).toMatchObject({ changed: 1, guard: { deferredByCap: 1 } })
    expect([(await campaign('bs-c1')).budget, (await campaign('bs-c2')).budget]).toEqual([30, 20])
    expect((await memo('bs-cap'))['bs-c2']).toBeUndefined()
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 1, guard: { deferredByCap: 0 } })
    expect((await campaign('bs-c2')).budget).toBe(30)
    await inside(() => db().budgetSchedule.update({ where: { id: 'bs-cap' }, data: { enabled: false } }))
  })
})

describe('budget pools: one rebalance is never split; SUGGEST records a dry run, stopped and the cap leave no trace', () => {
  it('SUGGEST → dry-run audit only → halted → nothing, no cool-down → Resume → applied whole', async () => {
    await seedCampaign('bp-a', 40, [35], { dailyBudget: 30 })
    await seedCampaign('bp-b', 40, [35], { dailyBudget: 10 })
    await inside(async () => {
      await db().budgetPool.create({ data: { id: 'bp', name: 'bp', totalDailyBudgetCents: 4_000, strategy: 'STATIC', maxShiftPerRebalancePct: 100, enabled: true, dryRun: false } })
      for (const c of ['bp-a', 'bp-b']) await db().budgetPoolAllocation.create({ data: { budgetPoolId: 'bp', marketplace: 'IT', campaignId: c, targetSharePct: '50' } })
    })
    const audits = () => inside(() => db().budgetPoolRebalance.findMany({ where: { budgetPoolId: 'bp' }, orderBy: { createdAt: 'asc' }, select: { dryRun: true, appliedAt: true } }))
    const pool = () => inside(() => db().budgetPool.findUnique({ where: { id: 'bp' }, select: { lastRebalancedAt: true } }))

    await dial('SUGGEST')
    const suggest = await inside(() => runBudgetPoolRebalanceOnce())
    expect(suggest).toMatchObject({ poolsRebalanced: 1, poolsAppliedLive: 0, guard: { posture: 'suggest', wouldApply: 1 } })
    expect(await audits()).toEqual([{ dryRun: true, appliedAt: null }])
    expect([(await campaign('bp-a')).budget, (await campaign('bp-b')).budget]).toEqual([30, 10])

    await inside(() => db().budgetPool.update({ where: { id: 'bp' }, data: { lastRebalancedAt: null } }))
    await dial('AUTO', true)
    const stopped = await inside(() => runBudgetPoolRebalanceOnce())
    expect(stopped).toMatchObject({ poolsSkipped: 1, guard: { posture: 'stopped', waiting: 1 } })
    expect(await audits()).toHaveLength(1) // no audit row, so…
    expect((await pool()).lastRebalancedAt).toBeNull() // …no cool-down: the first run after Resume applies it

    await dial('AUTO', false)
    const live = await inside(() => runBudgetPoolRebalanceOnce())
    expect(live).toMatchObject({ poolsAppliedLive: 1, guard: { posture: 'auto', changes: 2 } })
    expect([(await campaign('bp-a')).budget, (await campaign('bp-b')).budget]).toEqual([20, 20])
    expect((await audits())[1]).toMatchObject({ dryRun: false, appliedAt: expect.any(Date) })
    // Queued in the grace window as before (the pool writes without applyImmediately).
    expect(await inside(() => db().outboundSyncQueue.count({ where: { externalListingId: { in: ['EXT-bp-a', 'EXT-bp-b'] }, syncStatus: 'PENDING' } }))).toBe(2)
    await inside(() => db().budgetPool.update({ where: { id: 'bp' }, data: { enabled: false } }))
  })
})

describe('top-of-search defense: SUGGEST and stopped move nothing; the cap defers whole campaigns', () => {
  it('counts what it would move, then writes only up to its run cap', async () => {
    const day = new Date(Date.now() - 3 * 86_400_000)
    for (const id of ['tos-a', 'tos-b']) {
      await seedCampaign(id, 40, [35])
      // ACOS 10% on the top slot, well under the 25% default target: each wants Top 0 → 15%.
      await inside(() => db().amazonAdsPlacementReport.create({
        data: { profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, campaignId: `EXT-${id}`, placement: 'Top of Search on-Amazon', impressions: 1_000, clicks: 50, costMicros: 10_000_000n, sales7dCents: 10_000, currencyCode: 'EUR' },
      }))
    }
    const top = async (id: string) => (((await campaign(id)).placement ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding?.find((p) => p.placement === 'PLACEMENT_TOP')?.percentage ?? 0

    await dial('SUGGEST')
    expect(await inside(() => runTosDefenseOnce())).toBe('evaluated=2 changed=2 applied=0 skipped=0 would-apply=2 (the account ads dial is SUGGEST: nothing is written)')
    await dial('AUTO', true)
    expect(await inside(() => runTosDefenseOnce())).toContain('applied=0 skipped=0 waiting=2 (stopped — halted: test halt: nothing is written; placement moves wait for Resume)')
    expect([await top('tos-a'), await top('tos-b')]).toEqual([0, 0])

    await dial('AUTO', false)
    caps({ 'tos-defense': { perTick: 1 } })
    const capped = await inside(() => runTosDefenseOnce())
    expect(capped).toContain('applied=1 skipped=0 deferred-by-cap=1 (cap 1 a run, 300 a day;')
    expect([await top('tos-a'), await top('tos-b')].sort()).toEqual([0, 15])
    await inside(() => db().amazonAdsPlacementReport.deleteMany({}))
  })
})

describe('coverage engine (auto mode): the dial holds a step as a would-do, the cap defers it', () => {
  it('SUGGEST logs would-do rows and writes nothing; AUTO writes up to its run cap and logs nothing for the deferred term', async () => {
    process.env.NEXUS_COVERAGE_ENGINE_MODE = 'auto'
    await seedCampaign('cov-a', 40, [40], { portfolioId: 'PF-COV' })
    await seedCampaign('cov-b', 40, [40], { portfolioId: 'PF-COV' })
    await inside(async () => {
      await db().keywordCoverageSet.create({
        data: { id: 'cov-set', portfolioId: 'PF-COV', marketplace: 'IT', name: 'cov', enabled: true, terms: { create: [{ term: 'cov-a kw 0' }, { term: 'cov-b kw 0' }] } },
      })
      // €25 in 30 days with no sales on each term: the waste guard steps the bid down 40 → 38.
      for (const id of ['cov-a', 'cov-b']) {
        await db().amazonAdsDailyPerformance.create({
          data: { profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 2 * 86_400_000), entityType: 'AD_TARGET', entityId: `EXT-${id}-t0`, costMicros: 25_000_000n, sales7dCents: 0, currencyCode: 'EUR', reportedAt: new Date() },
        })
      }
    })
    const observed = () => inside(() => db().advertisingActionLog.count({ where: { actionType: 'coverage_engine_observe' } }))
    const bid = async (id: string) => (await campaign(id)).targets[0].bidCents

    await dial('SUGGEST')
    const suggest = await inside(() => runCoverageEngineOnce())
    expect(suggest).toMatchObject({ mode: 'auto', downs: 2, applied: 0, guard: { posture: 'suggest', wouldApply: 2 } })
    expect(coverageEngineSummaryLine(suggest)).toContain(' would-apply=2 (the account ads dial is SUGGEST: nothing is written; the bids it would set are logged, as in observe mode)')
    expect(await observed()).toBe(2)
    expect([await bid('cov-a'), await bid('cov-b')]).toEqual([40, 40])

    await dial('AUTO')
    caps({ 'coverage-engine': { perTick: 1 } })
    const capped = await inside(() => runCoverageEngineOnce())
    expect(capped).toMatchObject({ applied: 1, guard: { posture: 'auto', changes: 1, deferredByCap: 1 } })
    expect([await bid('cov-a'), await bid('cov-b')].sort()).toEqual([38, 40])
    expect(await observed()).toBe(2) // no would-do row for the deferred term
    await inside(() => db().keywordCoverageSet.update({ where: { id: 'cov-set' }, data: { enabled: false } }))
  })
})

describe('autopilot: an AUTO plan applies only while the dial is AUTO, campaign by campaign inside the caps', () => {
  it('SUGGEST and stopped record proposals and write nothing; AUTO applies one campaign under a run cap of 1', async () => {
    await seedCampaign('ap-a', 40, [35], { dailyBudget: 20 })
    await seedCampaign('ap-b', 40, [35], { dailyBudget: 20 })
    await inside(() => db().autopilotPlan.create({ data: { id: 'ap', name: 'ap', marketplace: 'IT', campaignIds: ['ap-a', 'ap-b'], autonomy: 'AUTO' } }))
    conductor.actions = ['ap-a', 'ap-b'].map((campaignId) => ({ module: 'budget', campaignId, action: 'BUDGET_UP', beforeCents: 2_000, afterCents: 2_500, reason: 'test raise', priority: 50 }))
    const proposed = () => inside(() => db().autopilotDecision.count({ where: { planId: 'ap', status: 'PROPOSED' } }))
    const budgets = async () => [(await campaign('ap-a')).budget, (await campaign('ap-b')).budget]

    await dial('SUGGEST')
    const suggest = await inside(() => runAutopilotOnce())
    expect(autopilotSummaryLine(suggest)).toBe('plans=1 decisions=2 would-apply=2 (the account ads dial is SUGGEST: AUTO plans record proposals and write nothing)')
    expect(await proposed()).toBe(2)
    await dial('AUTO', true)
    expect(await inside(() => runAutopilotOnce())).toMatchObject({ guard: { posture: 'stopped', waiting: 2 } })
    expect(await budgets()).toEqual([20, 20])
    expect((await drain()).processed).toBe(0)

    await dial('AUTO', false)
    caps({ autopilot: { perTick: 1 } })
    const capped = await inside(() => runAutopilotOnce())
    expect(capped).toMatchObject({ decisions: 1, guard: { posture: 'auto', changes: 1, deferredByCap: 1 } })
    expect(await budgets()).toEqual([25, 20])
    expect(await proposed()).toBe(0)
    expect(await inside(() => db().autopilotDecision.count({ where: { planId: 'ap', status: 'APPLIED' } }))).toBe(1)
    await inside(() => db().autopilotPlan.update({ where: { id: 'ap' }, data: { enabled: false } }))
  })
})

describe('auto-bid: its dial behaviour kept, and whole campaigns inside its caps', () => {
  it('stopped stands down, SUGGEST only counts, AUTO writes the first campaign and defers the next whole', async () => {
    await seedCampaign('ab-a', 40, [35, 60])
    await seedCampaign('ab-b', 40, [35])
    optimiser.proposals = [
      { targetId: 'ab-a-t1', currentBidCents: 60, proposedBidCents: 50, deltaCents: -10 },
      { targetId: 'ab-b-t0', currentBidCents: 35, proposedBidCents: 28, deltaCents: -7 },
      { targetId: 'ab-a-t0', currentBidCents: 35, proposedBidCents: 30, deltaCents: -5 },
    ]
    const bids = async () => [...(await campaign('ab-a')).targets.map((t) => t.bidCents), ...(await campaign('ab-b')).targets.map((t) => t.bidCents)]

    await dial('AUTO', true)
    expect(await inside(() => runAutoBidOnce())).toMatchObject({ skipped: 'halted-or-off', guard: { posture: 'stopped' } })
    await dial('SUGGEST')
    const suggest = await inside(() => runAutoBidOnce())
    expect(suggest).toMatchObject({ proposed: 3, applied: 0, dryRun: true, guard: { wouldApply: 2 } })
    expect(autoBidSummaryLine(suggest)).toBe('proposed=3 applied=0 dryRun=true would-apply=2 (the account ads dial is SUGGEST: nothing is written; the bids it would set are counted)')
    expect(await bids()).toEqual([35, 60, 35])

    await dial('AUTO')
    caps({ 'auto-bid': { perTick: 2 } })
    const capped = await inside(() => runAutoBidOnce())
    expect(capped).toMatchObject({ proposed: 3, applied: 2, dryRun: false, guard: { changes: 2, deferredByCap: 1 } })
    // ab-a (its biggest move first) whole, both targets; ab-b untouched until the next run.
    expect(await bids()).toEqual([30, 50, 35])
    expect(autoBidSummaryLine(capped)).toContain('deferred-by-cap=1 (cap 2 a run, 1,200 a day;')
    optimiser.proposals = []
  })
})
