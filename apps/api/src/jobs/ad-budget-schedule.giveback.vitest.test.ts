/**
 * 3b (review 6.2, 6.3, 6.6, 6.5 pause/delete) — a budget schedule gives back only what it holds, from the budget
 * before the window, end to end: the real executor, the real write service and enqueue, the real worker and the
 * real day-move bound of the write gate (3a's give-back recognition included) on PGlite with the production schema.
 * The rest of the gate is a stand-in that can refuse one budget write, the way the allowlist does; Amazon is a
 * recorder. Nothing leaves the process.
 *
 * Proven here:
 *   · a person who changes the budget inside the window keeps it: the schedule yields, gives nothing back when the
 *     window closes, and a pause leaves it too (`kept`);
 *   · a give-back the gate refused is tried again an hour later — once the sync has copied Amazon's budget back —
 *     and the gate takes the retry as a give-back, so a +100% boost comes back even across a UTC midnight;
 *   · 3c × 4k — a window entry the gate refused is put back in Nexus by the worker, and the next run records it as
 *     refused (with the gate's reason), not as yielded to someone who never touched it.
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
// The gate: the REAL day-move bound for every budget write (3a: a give-back is recognised from the action log), and
// `refuse` budget writes refused the way the allowlist refuses them.
const gate = vi.hoisted(() => ({ refuse: 0 }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()
  return {
    ...real,
    checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
      if (ctx.field === 'dailyBudget' && gate.refuse > 0) { gate.refuse--; return { allowed: false, deniedAt: 'campaign_allowlist', reason: 'test: campaign not on the allowlist' } }
      if (ctx.field === 'dailyBudget' && ctx.campaignId && ctx.intendedValueCents != null) {
        const denial = await real.budgetDayMoveDenial({
          campaignId: ctx.campaignId, currentBudgetCents: ctx.previousValueCents ?? 0, intendedCents: ctx.intendedValueCents,
          actor: ctx.actor, previousValueCents: ctx.previousValueCents, queueId: ctx.queueId,
        })
        if (denial) return denial
      }
      return { allowed: true, mode: 'live', profileId: 'P-TEST' }
    },
    logGateDeny: () => undefined,
    recordSuccessfulWrite: async () => undefined,
    recordCampaignLiveWrite: async () => undefined,
  }
})
const amazon = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, _externalId: string, patch: Record<string, unknown>) => { amazon.calls.push(patch); return { ok: true, rawResponse: {} } }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record }
})

const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
const { runBudgetScheduleOnce } = await import('./ad-budget-schedule.job.js')
const { patchBudgetSchedule } = await import('../services/advertising/ads-budget-schedule.service.js')
const { updateCampaignWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { ENGINE_CAPS_ENV } = await import('../services/advertising/ads-engine-actors.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** Every weekday, all day, +X% — so a window is open whenever the test runs, and `windows: []` closes it. */
const EVERY_DAY = (pct: number) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '', end: '', adj: 'incPct', value: pct }))
type Memo = { windowKey?: string; state?: string; baseCents?: number; ownCents?: number; attempts?: number; error?: string | null; overriddenBy?: { kind: string } }
const memo = (id: string, campaignId: string) => inside(async () =>
  (((await db().budgetSchedule.findUnique({ where: { id }, select: { lastApplied: true } })).lastApplied ?? {}) as Record<string, Memo>)[campaignId])
const budget = (id: string) => inside(async () => Number((await db().campaign.findUnique({ where: { id }, select: { dailyBudget: true } })).dailyBudget))
async function seedCampaign(id: string, dailyBudget: number) {
  await inside(() => db().campaign.create({
    data: { id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: String(dailyBudget), startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true },
  }))
}
/** Drain the queue: what reached Amazon, and how the rows settled. */
async function drain() {
  amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(100))
  const rows = await inside(() => db().outboundSyncQueue.findMany({ where: { id: { in: out.results.map((r: { queueId: string }) => r.queueId) } }, select: { syncStatus: true } }))
  return { processed: out.processed as number, statuses: rows.map((r: { syncStatus: string }) => r.syncStatus), calls: amazon.calls }
}

const savedCaps = process.env[ENGINE_CAPS_ENV]
beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => {
  if (savedCaps === undefined) delete process.env[ENGINE_CAPS_ENV]; else process.env[ENGINE_CAPS_ENV] = savedCaps
  await database?.close()
})
beforeEach(async () => {
  delete process.env[ENGINE_CAPS_ENV]
  gate.refuse = 0
  await inside(() => db().adsAutomationState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', autonomy: 'AUTO', halted: false, haltReason: null },
    update: { autonomy: 'AUTO', halted: false, haltReason: null },
  }))
  await drain() // nothing from an earlier case is left in the queue
})

describe('3b — a budget schedule gives back only what it holds, from the budget before the window', () => {
  it('🔴 6.2 — a person changes the budget inside the window: the schedule yields, gives nothing back, and a pause keeps it', async () => {
    await seedCampaign('gb-a', 20)
    // The creation-time snapshot says €10: the base must be the €20 the campaign has when the window opens (6.3).
    await inside(() => db().budgetSchedule.create({ data: { id: 'gb-s', name: 'gb-s', timezone: 'UTC', windows: EVERY_DAY(50), campaigns: [{ id: 'gb-a', dailyBudget: 10 }] } }))

    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 1 })
    expect(await budget('gb-a')).toBe(30) // +50% of €20, not of the €10 snapshot
    expect(await memo('gb-s', 'gb-a')).toMatchObject({ state: 'applied', baseCents: 2000, ownCents: 3000 })
    expect((await drain()).statuses).toEqual(['SUCCESS'])

    // A person sets €25 by hand inside the window.
    expect(await inside(() => updateCampaignWithSync({ campaignId: 'gb-a', patch: { dailyBudget: 25 }, actor: 'user:awais', applyImmediately: true }))).toMatchObject({ ok: true })
    expect((await drain()).statuses).toEqual(['SUCCESS'])
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 0, yielded: 1 })
    expect(await memo('gb-s', 'gb-a')).toMatchObject({ state: 'yielded', overriddenBy: { kind: 'operator' } })

    // The window closes: the old executor wrote the base back over the person's €25. Now nothing is written.
    await inside(() => db().budgetSchedule.update({ where: { id: 'gb-s' }, data: { windows: [] } }))
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 0, yielded: 1 })
    expect(await budget('gb-a')).toBe(25)
    const closed = await memo('gb-s', 'gb-a')
    expect(closed).toMatchObject({ state: 'yielded', overriddenBy: { kind: 'operator' } })
    expect(closed.windowKey).toMatch(/#restore$/)
    expect((await drain()).processed).toBe(0)
    // The record is kept outside windows (6.6), and later runs leave the campaign alone.
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 0, yielded: 0 })
    expect(await memo('gb-s', 'gb-a')).toEqual(closed)

    // Pausing makes the same check: the person's budget is kept, and the answer says so.
    const paused = await inside(() => patchBudgetSchedule('gb-s', { enabled: false }, 'user:awais'))
    expect(paused?.restore).toEqual({ restored: 0, kept: 1, refused: 0 })
    expect(await budget('gb-a')).toBe(25)
    expect((await drain()).processed).toBe(0)
  })

  it('a give-back the gate refused is tried again an hour later, once the sync copied Amazon’s budget back — and lands across a UTC midnight', async () => {
    await seedCampaign('gb-b', 10)
    await inside(() => db().budgetSchedule.create({ data: { id: 'gb-r', name: 'gb-r', timezone: 'UTC', windows: EVERY_DAY(100), campaigns: [{ id: 'gb-b', dailyBudget: 10 }] } }))
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 1 })
    expect(await budget('gb-b')).toBe(20)
    const entryKey = (await memo('gb-r', 'gb-b')).windowKey!
    expect((await drain()).statuses).toEqual(['SUCCESS'])
    // The boost was set yesterday: today €20 → €10 is −50%, past the −30% day-move bound unless it is a give-back.
    await inside(() => db().advertisingActionLog.updateMany({ where: { entityId: 'gb-b', actionType: 'AD_BUDGET_UPDATE' }, data: { createdAt: new Date(Date.now() - 86_400_000) } }))

    // The window closes; the gate refuses the give-back (the allowlist, say). Nexus wrote its own copy first.
    await inside(() => db().budgetSchedule.update({ where: { id: 'gb-r' }, data: { windows: [] } }))
    gate.refuse = 1
    const t0 = Date.now()
    expect(await inside(() => runBudgetScheduleOnce(new Date(t0)))).toMatchObject({ changed: 1 })
    expect(await budget('gb-b')).toBe(10)
    expect((await drain()).statuses).toEqual(['SKIPPED'])
    expect(await memo('gb-r', 'gb-b')).toMatchObject({ windowKey: `${entryKey}#restore`, state: 'applied', attempts: 1, baseCents: 1000, ownCents: 2000 })

    // Nexus still shows the €10 it wrote, so there is nothing to try again yet.
    expect(await inside(() => runBudgetScheduleOnce(new Date(t0 + 15 * 60_000)))).toMatchObject({ changed: 0 })
    // The sync copies Amazon's €20 back (ads-v1-sync writes the column, no action-log row).
    await inside(() => db().campaign.update({ where: { id: 'gb-b' }, data: { dailyBudget: '20' } }))
    // Still within the hour: wait.
    expect(await inside(() => runBudgetScheduleOnce(new Date(t0 + 30 * 60_000)))).toMatchObject({ changed: 0 })
    expect(await budget('gb-b')).toBe(20)

    // An hour on: the second try. The gate recognises it as the schedule giving back what it set, so the
    // day-move bound does not refuse it, and it reaches Amazon.
    expect(await inside(() => runBudgetScheduleOnce(new Date(t0 + 61 * 60_000)))).toMatchObject({ changed: 1, refused: 0 })
    expect(await budget('gb-b')).toBe(10)
    const retried = await drain()
    expect(retried.statuses).toEqual(['SUCCESS'])
    expect(retried.calls).toEqual([expect.objectContaining({ dailyBudget: 10 })])
    expect(await memo('gb-r', 'gb-b')).toMatchObject({ windowKey: `${entryKey}#restore`, state: 'applied', attempts: 2 })
    // The retry carries the entry it gives back, for the history.
    const rows = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: 'gb-b', actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'asc' }, select: { userId: true, evidence: true } }))
    expect(rows.map((r: { evidence: unknown }) => (r.evidence as { giveBackOf?: string } | null)?.giveBackOf ?? null)).toEqual([null, entryKey, entryKey])
    expect(new Set(rows.map((r: { userId: string }) => r.userId))).toEqual(new Set(['automation:budget-schedule-gb-r']))

    // Delivered: the next runs keep the record and write nothing more.
    expect(await inside(() => runBudgetScheduleOnce(new Date(t0 + 3 * 60 * 60_000)))).toMatchObject({ changed: 0 })
    expect((await drain()).processed).toBe(0)
  })

  it('3c × 4k — a window entry the gate refused is put back in Nexus and shown refused, not yielded', async () => {
    await seedCampaign('gb-c', 10)
    await inside(() => db().budgetSchedule.create({ data: { id: 'gb-e', name: 'gb-e', timezone: 'UTC', windows: EVERY_DAY(50), campaigns: [{ id: 'gb-c', dailyBudget: 10 }] } }))
    gate.refuse = 1
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 1 })
    expect(await budget('gb-c')).toBe(15)
    expect((await drain()).statuses).toEqual(['SKIPPED'])
    expect(await budget('gb-c')).toBe(10) // 4k: the refused write is put back in Nexus

    // Before 3c the next run read "€10 ≠ the €15 we set" as someone else's change: yielded. It is the gate's refusal.
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 0, yielded: 0, refused: 1 })
    const refused = await memo('gb-e', 'gb-c')
    expect(refused).toMatchObject({ state: 'refused', baseCents: 1000, ownCents: 1500 })
    expect(refused.error).toMatch(/campaign_allowlist/)
    expect(refused.overriddenBy).toBeUndefined()
    // Still stood down for this entry: no new write every 15 minutes.
    expect((await drain()).processed).toBe(0)

    // The window closes: Nexus and Amazon both hold the €10 from before the window, so nothing is given back.
    await inside(() => db().budgetSchedule.update({ where: { id: 'gb-e' }, data: { windows: [] } }))
    expect(await inside(() => runBudgetScheduleOnce())).toMatchObject({ changed: 0, yielded: 0, refused: 0 })
    expect(await budget('gb-c')).toBe(10)
    expect((await drain()).processed).toBe(0)
  })
})
