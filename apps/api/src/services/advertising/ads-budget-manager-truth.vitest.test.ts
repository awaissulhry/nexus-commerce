/**
 * W3-B part 2 — the Budget Manager says what the engine really does, and its numbers match the rest of the console.
 *
 *   AM-8   the engine's mode is read from the engine's own gate (env + this business's switch, the dial, the write
 *          mode) — and the job reads the same gate, so the screen and the run can never disagree;
 *   AM-17  pace and the month-end forecast count COMPLETE budget days (00:00–24:00 UTC), never today;
 *   AM-18  the Marketing Stream's duplicate daily rows are not counted as spend;
 *   AM-20  an ACoS alert measures against the campaign's own Target ACoS, then the account default, then 50 % — and
 *          says which; the alert windows are complete days.
 * PGlite with the production schema.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// The engine's work is not what this file proves; the job's gate is.
const work = vi.hoisted(() => ({
  enforce: vi.fn(async (opts: { dryRun: boolean }) => ({ result: { totals: { plans: 0, budgetChanges: 0 } }, budgetApplied: 0, suppressed: 0, restored: 0, failed: 0, dryRun: opts.dryRun })),
}))
vi.mock('./ads-budget-enforce.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), applyBudgetEnforcement: work.enforce }))
vi.mock('./ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withEngineLock: async (_workspaceId: string, _engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const day = (d: string) => new Date(`${d}T00:00:00Z`)
const ENV = ['NEXUS_BUDGET_ENFORCE_APPLY', 'NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_ADS_AUTOMATION_KILL'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await inside(() => database.client.automationSwitch.deleteMany({}))
})
afterAll(async () => { await database?.close() }, 30_000)

const perf = (data: Record<string, unknown>) => inside(() => database.client.amazonAdsDailyPerformance.create({ data: {
  profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', adProduct: 'SPONSORED_PRODUCTS', reportRunId: 'RUN-1', reportedAt: new Date(), ...data,
} as never }))

describe('AM-8 — the Budget Manager reads the engine\'s real mode, the one the job runs at', () => {
  const live = () => {
    process.env.NEXUS_ENABLE_AMAZON_ADS_CRON = '1'
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    process.env.NEXUS_BUDGET_ENFORCE_APPLY = '1'
    delete process.env.NEXUS_ADS_AUTOMATION_KILL
  }
  const dial = (autonomy: string) => inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy } as never, update: { autonomy } as never }))

  it('env applies, no switch, dial AUTO, live writes: Live — and the job runs LIVE', async () => {
    live(); await dial('AUTO')
    const { budgetEnforceMode } = await import('./ads-budget-enforce.service.js')
    const { runBudgetEnforceOnce } = await import('../../jobs/ad-budget-enforce.job.js')
    const m = await inside(() => budgetEnforceMode())
    expect(m).toMatchObject({ mode: 'AUTO', live: true, label: 'Live' })
    expect(m.sentence).toMatch(/^Live: every 30 minutes it changes campaign daily budgets on Amazon/)
    expect(await inside(() => runBudgetEnforceOnce())).toContain('(LIVE)')
  })

  it('this business switched to OBSERVE: Observe only — and the job stays dry', async () => {
    live(); await dial('AUTO')
    const { setEngineSwitch } = await import('../automation/engine-switch.service.js')
    await inside(() => setEngineSwitch('budget-enforce', 'OBSERVE', 'user:owner'))
    const { budgetEnforceMode } = await import('./ads-budget-enforce.service.js')
    const { runBudgetEnforceOnce } = await import('../../jobs/ad-budget-enforce.job.js')
    expect(await inside(() => budgetEnforceMode())).toMatchObject({ mode: 'OBSERVE', live: false, label: 'Observe only' })
    expect(await inside(() => runBudgetEnforceOnce())).toContain('(dry-run)')
  })

  it('the env does not apply (only exactly "1" does): Observe only, and it says why', async () => {
    live(); process.env.NEXUS_BUDGET_ENFORCE_APPLY = 'true'
    const { budgetEnforceMode } = await import('./ads-budget-enforce.service.js')
    const m = await inside(() => budgetEnforceMode())
    expect(m).toMatchObject({ mode: 'OBSERVE', live: false })
    expect(m.sentence).toContain('NEXUS_BUDGET_ENFORCE_APPLY is not 1')
  })

  it('sandbox writes, a SUGGEST dial, or no ads crons: never called live', async () => {
    const { budgetEnforceMode } = await import('./ads-budget-enforce.service.js')
    live(); process.env.NEXUS_AMAZON_ADS_MODE = 'sandbox'; await dial('AUTO')
    expect(await inside(() => budgetEnforceMode())).toMatchObject({ live: false, label: 'Sandbox' })
    live(); await dial('SUGGEST')
    expect(await inside(() => budgetEnforceMode())).toMatchObject({ live: false, label: 'Suggest only' })
    live(); delete process.env.NEXUS_ENABLE_AMAZON_ADS_CRON; await dial('AUTO')
    expect(await inside(() => budgetEnforceMode())).toMatchObject({ live: false, label: 'Off' })
  })
})

describe('AM-17 / AM-18 — pace and forecast over complete budget days, without the stream\'s duplicate rows', () => {
  beforeAll(async () => {
    // Italy, October 2026: €10.00 on each of the first four days; the stream's own daily row for the 3rd is a duplicate.
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      await perf({ marketplace: 'IT', date: day(d), entityId: 'EXT-BM-1', localEntityId: null, costMicros: 10_000_000n })
    }
    await perf({ marketplace: 'IT', date: day('2026-10-03'), entityId: 'EXT-BM-1', localEntityId: null, reportRunId: 'ams-stream', profileId: 'ams', costMicros: 99_000_000n })
    await inside(() => database.client.adBudgetPlan.create({ data: { marketplace: 'IT', month: '2026-10', monthlyBudgetCents: 31_000 } as never }))
  })

  it('on 5 October at noon UTC, today is not an elapsed day: 4 complete days, forecast €310 (it was €248)', async () => {
    const { analyzeBudgetManager } = await import('./ads-budget-manager.service.js')
    const r = await inside(() => analyzeBudgetManager({ month: '2026-10', now: new Date('2026-10-05T12:00:00Z') }))
    expect(r).toMatchObject({ dayOfMonth: 5, elapsedDays: 4, dataThrough: '2026-10-04', dayBoundary: '00:00–24:00 UTC' })
    const it_ = r.rows.find((x) => x.marketplace === 'IT')!
    expect(it_.spendCents).toBe(4_000) // not €139: the stream's duplicate row is excluded
    expect(it_.forecastSpendCents).toBe(31_000)
    expect(it_.expectedPct).toBeCloseTo(4 / 31, 10)
    expect(it_.status).toBe('on-track')
  })

  it('before yesterday\'s report arrives, pace stops at the last reported day', async () => {
    const { analyzeBudgetManager } = await import('./ads-budget-manager.service.js')
    const r = await inside(() => analyzeBudgetManager({ month: '2026-10', now: new Date('2026-10-06T00:30:00Z') }))
    expect(r).toMatchObject({ dayOfMonth: 6, elapsedDays: 4, dataThrough: '2026-10-04' })
  })

  it('the first day of a month has no complete day: no forecast rather than a made-up one', async () => {
    const { analyzeBudgetManager } = await import('./ads-budget-manager.service.js')
    const r = await inside(() => analyzeBudgetManager({ month: '2026-10', now: new Date('2026-10-01T15:00:00Z') }))
    expect(r.elapsedDays).toBe(0)
    expect(r.rows.find((x) => x.marketplace === 'IT')!.forecastSpendCents).toBeNull()
  })
})

describe('AM-20 — an ACoS alert measures against his own Target ACoS, and says whose number it used', () => {
  const NOW = new Date('2026-09-20T10:00:00Z')
  beforeAll(async () => {
    await inside(async () => {
      const db = database.client
      // Two campaigns at 45 % ACoS over the last 7 complete days (€9 spend, €20 sales): one targets 25 %, one has no target.
      await db.campaign.create({ data: { id: 'al-1', name: 'Targets 25', type: 'SP', marketplace: 'IT', externalCampaignId: 'EXT-AL-1', dailyBudget: '10.00', startDate: day('2026-01-01'), dynamicBidding: { targetAcos: 0.25 } } as never })
      await db.campaign.create({ data: { id: 'al-2', name: 'No target', type: 'SP', marketplace: 'IT', externalCampaignId: 'EXT-AL-2', dailyBudget: '10.00', startDate: day('2026-01-01') } as never })
    })
    for (const id of ['al-1', 'al-2']) {
      await perf({ marketplace: 'IT', date: day('2026-09-15'), entityId: `EXT-${id}`, localEntityId: id, costMicros: 9_000_000n, sales7dCents: 2_000, orders7d: 1 })
    }
    // Today's (partial) row is not in a complete-days window.
    await perf({ marketplace: 'IT', date: day('2026-09-20'), entityId: 'EXT-al-2', localEntityId: 'al-2', costMicros: 90_000_000n, sales7dCents: 0, orders7d: 0 })
  })

  it('his campaign target first, then the fixed 50 % — named as a default, never as "target"', async () => {
    const { buildAlerts } = await import('./ads-alerts.service.js')
    const r = await inside(() => buildAlerts({ now: NOW }))
    expect(r.window).toEqual({ from: '2026-09-13', to: '2026-09-19', priorFrom: '2026-09-06', priorTo: '2026-09-12' })
    const byId = Object.fromEntries(r.alerts.filter((a) => a.type === 'acos_breach').map((a) => [a.campaignId, a]))
    expect(byId['al-1']).toMatchObject({ acosTarget: 0.25, acosTargetSource: 'campaign', message: "ACOS 45% is over this campaign's Target ACoS 25% (€9.00 spend)." })
    expect(byId['al-2']).toBeUndefined() // 45 % is under the 50 % default — and today's €90 is not counted
    expect(r.acosThresholdSource).toBe('default')
  })

  it('the account default Target ACoS, when he set one, before the fixed 50 %', async () => {
    await inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', defaultTargetAcosPct: 30 } as never, update: { defaultTargetAcosPct: 30 } as never }))
    const { buildAlerts } = await import('./ads-alerts.service.js')
    const r = await inside(() => buildAlerts({ now: NOW }))
    expect(r).toMatchObject({ acosThreshold: 0.3, acosThresholdSource: 'account' })
    const a = r.alerts.find((x) => x.campaignId === 'al-2' && x.type === 'acos_breach')
    expect(a).toMatchObject({ acosTarget: 0.3, acosTargetSource: 'account', message: "ACOS 45% is over the account's default Target ACoS 30% (no campaign target set) (€9.00 spend)." })
  })
})
