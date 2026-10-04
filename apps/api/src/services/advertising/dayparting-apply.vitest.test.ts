/**
 * Group 2 (2d) — `dayparting_apply` (the classic "Dayparting schedule" builder's rule) fires in a window that ends at
 * midnight (review 3.9).
 *
 * The builder offers end times 00:00–23:00, so a window running to midnight is saved with end '00:00'. The handler read
 * that as hour 0, and `hour < 0` is never true: the window never fired. An end of '00:00' now means 24:00; an empty end
 * still never fires. (Its bids-not-status behaviour and own-floor restore are pinned in no-automated-pause.vitest.test.ts.)
 *
 * PGlite with the production schema, the real handler and suppression service; only the queue is mocked and only the
 * clock (`Date`) is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const RULE = 'tstrule-dp-midnight'

/** Run the handler with the clock at `iso` (UTC; the rule's timezone is UTC). */
async function runAt(iso: string, windows: unknown[], dryRun = false) {
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
  try {
    return await inside(() => ACTION_HANDLERS.dayparting_apply({ type: 'dayparting_apply', timezone: 'UTC', windows, campaignIds: ['c-it'] }, { marketplace: 'IT' }, { dryRun, ruleId: RULE }))
  } finally { vi.useRealTimers() }
}
const bid = async (id: string) => (await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents

// 2026-10-06 is a Tuesday (day 2).
const TUE_2330 = '2026-10-06T23:30:00Z'
const WED_0030 = '2026-10-07T00:30:00Z'

beforeAll(async () => {
  database = await formulaDatabase()
  await import('./automation-action-handlers.js')
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterEach(() => { vi.useRealTimers() })
afterAll(async () => { await database?.close() }, 30_000)

describe('dayparting_apply: a window ending at 00:00 runs to midnight', () => {
  it("a 22:00–00:00 'pause' window is active at 23:30 and floors the bids", async () => {
    const out = await runAt(TUE_2330, [{ day: 2, start: '22:00', end: '00:00', adj: 'pause' }])
    expect(out).toMatchObject({ ok: true, output: { dow: 2, hour: 23, action: 'pause', changed: 1 } })
    expect(await bid('t-it')).toBe(2)
  })

  it("an 18:00–00:00 'enable' window is active at 23:30 and gives back the bids this rule floored", async () => {
    const out = await runAt(TUE_2330, [{ day: 2, start: '18:00', end: '00:00', adj: 'enable' }])
    expect(out).toMatchObject({ ok: true, output: { action: 'enable', changed: 1 } })
    expect(await bid('t-it')).toBe(45)
  })

  it('it ends at midnight: the same window is not active at 00:30 the next day', async () => {
    const out = await runAt(WED_0030, [{ day: 2, start: '22:00', end: '00:00', adj: 'pause' }], true)
    expect(out).toMatchObject({ ok: true, output: { dow: 3, hour: 0, noActiveWindow: true } })
  })

  it('an empty end is still never active', async () => {
    const out = await runAt(TUE_2330, [{ day: 2, start: '22:00', end: '', adj: 'pause' }], true)
    expect(out).toMatchObject({ ok: true, output: { noActiveWindow: true } })
  })
})
