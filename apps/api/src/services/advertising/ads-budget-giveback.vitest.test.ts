/**
 * 6.1 — a budget schedule's give-back is not a new day move.
 *
 * A schedule's boost given back on the next UTC day was refused by the day-move bound: the give-back's own
 * log row (written before the gate runs) said the day "opened" at the boost, so €15 → €10 read as a 33% drop
 * and any boost above +42.9% could never be given back. The gate now recognises a give-back from the action
 * log (ads-budget-giveback.ts).
 *
 * Two halves: the pure rule, case by case; then the whole path on real rows — the real mutation service, the
 * real ads worker, the real gate and the real AdvertisingActionLog on PGlite with the production schema.
 * Amazon is a recorder; nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  GIVE_BACK_LOOKBACK, budgetLogStepOf, budgetScheduleIdOf, dayOpeningCents, isBudgetGiveBack, type BudgetLogStep,
} from './ads-budget-giveback.js'

const SCHED = 'automation:budget-schedule-sch1'
const OTHER_SCHED = 'automation:budget-schedule-sch2'
const RULE = 'automation:cmrule0000000000000000001'
const PACER = 'automation:budget-manager-cron'
/** One log row, budgets in cents. */
const step = (actor: string | null, beforeCents: number | null, afterCents: number | null): BudgetLogStep => ({ actor, beforeCents, afterCents })
/** The give-back of a schedule's own €10 → €15 boost. */
const back = (previousCents = 1_500, newCents = 1_000, actor: string = SCHED) => ({ actor, previousCents, newCents })

describe('the pure rule', () => {
  it('reads the schedule id off a budget schedule\'s actor, and only off that', () => {
    expect(budgetScheduleIdOf(SCHED)).toBe('sch1')
    expect(budgetScheduleIdOf(RULE)).toBeNull()
    expect(budgetScheduleIdOf(PACER)).toBeNull()
    expect(budgetScheduleIdOf('automation:budget-schedule-')).toBeNull()
    expect(budgetScheduleIdOf(null)).toBeNull()
  })

  it('reads a log row\'s budgets as EUROS and hands back cents', () => {
    expect(budgetLogStepOf({ userId: SCHED, payloadBefore: { dailyBudget: 15.5 }, payloadAfter: { dailyBudget: '12.30' } }))
      .toEqual({ actor: SCHED, beforeCents: 1_550, afterCents: 1_230 })
    expect(budgetLogStepOf({ userId: null, payloadBefore: {}, payloadAfter: { dailyBudget: null } }))
      .toEqual({ actor: null, beforeCents: null, afterCents: null })
  })

  describe('isBudgetGiveBack', () => {
    it('a schedule putting back the boost it set', () => {
      expect(isBudgetGiveBack(back(), [step(SCHED, 1_000, 1_500)])).toBe(true)
    })

    it('two windows back to back, given back in one write', () => {
      expect(isBudgetGiveBack(back(), [step(SCHED, 1_200, 1_500), step(SCHED, 1_000, 1_200)])).toBe(true)
    })

    it('a window that LOWERED the budget, given back upward', () => {
      expect(isBudgetGiveBack(back(2_000, 4_000), [step(SCHED, 4_000, 2_000)])).toBe(true)
    })

    it('yesterday\'s whole cycle behind today\'s entry still reads as the schedule\'s own run', () => {
      expect(isBudgetGiveBack(back(), [step(SCHED, 1_000, 1_500), step(SCHED, 1_500, 1_000), step(SCHED, 1_000, 1_500)])).toBe(true)
    })

    it('the same values from a rule are not a give-back — the actor must be a budget schedule\'s', () => {
      expect(isBudgetGiveBack(back(1_500, 1_000, RULE), [step(RULE, 1_000, 1_500)])).toBe(false)
    })

    it('another schedule\'s boost is not this schedule\'s to give back', () => {
      expect(isBudgetGiveBack(back(), [step(OTHER_SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('another writer after the schedule ends the run', () => {
      expect(isBudgetGiveBack(back(1_600), [step(PACER, 1_500, 1_600), step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('a budget nobody logged moving since the schedule wrote ends it too', () => {
      // The schedule set €15; the budget is now €16 with no row saying who did that.
      expect(isBudgetGiveBack(back(1_600), [step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('a chain broken between two of the schedule\'s own writes is not a give-back', () => {
      // €10 → €15, then something unlogged took it to €20, then the schedule went €20 → €25. Putting back
      // €10 would undo a move that was not the schedule's.
      expect(isBudgetGiveBack(back(2_500), [step(SCHED, 2_000, 2_500), step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('only back to where the run started: €15 → €8 is not a give-back of a run that started at €10', () => {
      expect(isBudgetGiveBack(back(1_500, 800), [step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('passes over its own give-back that did not stick, so a refused give-back can be tried again', () => {
      // The first give-back (€15 → €10) was refused and the sync copied Amazon's €15 back: it moved nothing.
      expect(isBudgetGiveBack(back(), [step(SCHED, 1_500, 1_000), step(SCHED, 1_000, 1_500)])).toBe(true)
    })

    it('but another writer\'s row that did not stick still ends the run', () => {
      expect(isBudgetGiveBack(back(), [step(RULE, 1_500, 900), step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it(`looks back ${GIVE_BACK_LOOKBACK} rows and no further`, () => {
      const stuck = (n: number) => Array.from({ length: n }, () => step(SCHED, 1_500, 1_000))
      expect(isBudgetGiveBack(back(), [...stuck(GIVE_BACK_LOOKBACK - 1), step(SCHED, 1_000, 1_500)])).toBe(true)
      expect(isBudgetGiveBack(back(), [...stuck(GIVE_BACK_LOOKBACK), step(SCHED, 1_000, 1_500)])).toBe(false)
    })

    it('fails closed on a row with no budget, an unknown previous value, no history, or no move', () => {
      expect(isBudgetGiveBack(back(), [step(SCHED, null, 1_500)])).toBe(false)
      expect(isBudgetGiveBack({ actor: SCHED, previousCents: null, newCents: 1_000 }, [step(SCHED, 1_000, 1_500)])).toBe(false)
      expect(isBudgetGiveBack(back(), [])).toBe(false)
      expect(isBudgetGiveBack(back(1_000, 1_000), [step(SCHED, 1_000, 1_000)])).toBe(false)
    })
  })

  describe('dayOpeningCents', () => {
    const yesterdayEntry = [step(SCHED, 1_000, 1_500)]

    it('a give-back at 00:15 does not open the day: the first writer after it does', () => {
      expect(dayOpeningCents([step(SCHED, 1_500, 1_000), step(PACER, 1_000, 800)], yesterdayEntry)).toBe(1_000)
    })

    it('a day that holds only a give-back has no logged opening (the caller uses the write\'s previous value)', () => {
      expect(dayOpeningCents([step(SCHED, 1_500, 1_000)], yesterdayEntry)).toBeNull()
    })

    it('any other first row opens the day exactly as before', () => {
      expect(dayOpeningCents([step(RULE, 1_000, 900)], [])).toBe(1_000)
      // A schedule entering its window is a move like any other.
      expect(dayOpeningCents([step(SCHED, 1_000, 1_500)], [])).toBe(1_000)
    })

    it('classifies each of today\'s rows against the rows before it, today\'s included', () => {
      // 00:10 give-back of yesterday's boost, 08:00 a new entry (a move), 12:00 its give-back.
      const today = [step(SCHED, 1_500, 1_000), step(SCHED, 1_000, 1_200), step(SCHED, 1_200, 1_000)]
      expect(dayOpeningCents(today, yesterdayEntry)).toBe(1_000)
    })
  })
})

// ── On real rows ────────────────────────────────────────────────────────────────────────────────

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Nothing here may open a Redis connection; the enqueue's BullMQ add is best-effort and the drain does the work.
vi.mock('../../lib/queue.js', () => {
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
// The real gate in live mode: a production profile with writes enabled, automation running.
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('./ads-api-client.js', () => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record }
})
vi.mock('./ads-profile-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsProfileFor: async () => ({
    profileId: 'P-IT-TEST', region: 'EU', connectionId: null, mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'),
    lastWriteAt: null, marketplace: 'IT', source: 'row',
  }),
  recordWriteForMarket: async () => undefined,
}))
vi.mock('./ads-automation-state.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async () => 0,
}))

describe('on real rows: mutation service → ads worker → write gate', () => {
  const inside = <T>(work: () => Promise<T>) =>
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  let drainAdsSyncOnce: typeof import('../../workers/ads-sync.worker.js')['drainAdsSyncOnce']
  let updateCampaignWithSync: typeof import('./ads-mutation.service.js')['updateCampaignWithSync']

  /** Queue a budget write as `actor` and run the worker; how the queue row settled, and what Amazon received. */
  async function write(campaignId: string, euros: number, actor: string) {
    const outcome = await inside(() => updateCampaignWithSync({ campaignId, patch: { dailyBudget: euros }, actor: actor as `automation:${string}`, applyImmediately: true }))
    expect(outcome.ok).toBe(true)
    amazon.calls = []
    await inside(() => drainAdsSyncOnce(50))
    const row = await inside(() => database.client.outboundSyncQueue.findUnique({
      where: { id: outcome.outboundQueueId! }, select: { syncStatus: true, errorMessage: true },
    }))
    return { status: row?.syncStatus, error: row?.errorMessage ?? null, sent: amazon.calls.map((c) => c.patch.dailyBudget) }
  }
  /** Move every log row of this campaign to yesterday evening (UTC): the window entry happened yesterday. */
  async function yesterday(campaignId: string) {
    const lastNight = new Date(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime() - 2 * 3_600_000)
    await inside(() => database.client.advertisingActionLog.updateMany({ where: { entityId: campaignId }, data: { createdAt: lastNight } }))
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    ;({ drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js'))
    ;({ updateCampaignWithSync } = await import('./ads-mutation.service.js'))
    await inside(async () => {
      for (const id of ['gb-sched', 'gb-two', 'gb-rule']) {
        await database.client.campaign.create({
          data: {
            id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
            dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
          } as never,
        })
      }
    })
  }, 180_000)
  afterAll(async () => { await database?.close() })
  beforeEach(() => { amazon.calls = [] })

  it('🔴 a ×1.5 boost entered yesterday is given back today, and the next writer is measured from €10, not the boost', async () => {
    expect(await write('gb-sched', 15, SCHED)).toEqual({ status: 'SUCCESS', error: null, sent: [15] })
    await yesterday('gb-sched')

    // Before 6.1: SKIPPED, "budget_day_move … from €15.00 to €10.00 — a 33% drop".
    expect(await write('gb-sched', 10, SCHED)).toEqual({ status: 'SUCCESS', error: null, sent: [10] })

    // A rule's −20% later the same day. Before 6.1 the give-back's row opened the day at €15, whose floor is €10.50.
    expect(await write('gb-sched', 8, RULE)).toEqual({ status: 'SUCCESS', error: null, sent: [8] })
  })

  it('two windows either side of midnight UTC are given back in one write (the worker hands the gate who, from what, and which row)', async () => {
    expect((await write('gb-two', 15, SCHED)).status).toBe('SUCCESS') // window A, yesterday evening
    await yesterday('gb-two')
    expect((await write('gb-two', 20, SCHED)).status).toBe('SUCCESS') // window B at 00:05: today opened at €15

    // Window B's row opens today at €15, so €20 → €10 reads as a 33% drop unless the gate sees the schedule's own
    // run A + B — which it can only see with the actor, the €20 this write replaces, and its own row left out.
    expect(await write('gb-two', 10, SCHED)).toEqual({ status: 'SUCCESS', error: null, sent: [10] })
  })

  it('the same €15 → €10 written by a rule is still a 33% day move, and refused', async () => {
    expect((await write('gb-rule', 15, SCHED)).status).toBe('SUCCESS')
    await yesterday('gb-rule')

    const r = await write('gb-rule', 10, RULE)
    expect(r.status).toBe('SKIPPED')
    expect(r.error).toContain('budget_day_move')
    expect(r.error).toContain('from €15.00 to €10.00')
    expect(r.sent).toEqual([])
  })
})
