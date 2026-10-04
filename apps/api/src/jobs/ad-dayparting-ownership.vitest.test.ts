/**
 * Group 2 (2d) — classic dayparting leaves alone what is not its own, and gives its bid multiplier back (review 3.9).
 *
 *   · the window-open restore lifts only a Rank & Dayparting floor (2a's `isRankOwnedFloor`), never a person's or the
 *     out-of-stock check's;
 *   · the multiplier never enters, moves or leaves over a floor — that would raise the floored bids;
 *   · leaving (or moving between) multiplier windows gives back only bids still at what the window set: a bid a person
 *     changed inside the window stays as they set it — what landed is recorded, so a max-change clamp is not mistaken
 *     for a person's change;
 *   · switching a classic schedule off or deleting it gives the multiplier back; while ads automation is stopped the
 *     switch-off keeps the remembered bids on the row for the first run after Resume, and a delete is refused (it would
 *     lose them).
 *
 * The real job, the real suppress / restore and mutation services on PGlite with the production schema; the queue is a
 * stub and nothing is drained, so every assertion reads Nexus's own copy and the queue rows (what would go to Amazon).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

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

const { runDaypartingOnce, readSnapshot, ownedTargets } = await import('./ad-dayparting.job.js')
const { patchAdSchedule, deleteAdSchedule } = await import('../services/advertising/ads-schedule.service.js')
const { scheduleSwitchBrake } = await import('../services/advertising/rank-release.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

const dial = (autonomy: 'AUTO' | 'SUGGEST' | 'OFF', halted = false) => inside(() => db().adsAutomationState.upsert({
  where: { id: 'singleton' },
  create: { id: 'singleton', autonomy, halted, haltReason: halted ? 'test halt' : null },
  update: { autonomy, halted, haltReason: halted ? 'test halt' : null },
}))

/**
 * One campaign, an ad group (40¢) and keyword targets at `bids`. `floorBy` floors it: every bid at 2¢, `remembered`
 * (default `bids`) as each one's memory.
 */
async function seed(id: string, bids: number[], opts: { floorBy?: string; remembered?: number[]; dynamicBidding?: object } = {}) {
  const floored = opts.floorBy != null
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        ...(opts.dynamicBidding ? { dynamicBidding: opts.dynamicBidding } : {}),
        ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: opts.floorBy } : {}),
      },
    })
    await db().adGroup.create({
      data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: floored ? 2 : 40, ...(floored ? { suppressedFromBidCents: 40 } : {}) },
    })
    for (const [i, bid] of bids.entries()) {
      await db().adTarget.create({
        data: {
          id: `${id}-t${i}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw ${i}`, externalTargetId: `EXT-${id}-t${i}`,
          bidCents: floored ? 2 : bid, ...(floored ? { suppressedFromBidCents: (opts.remembered ?? bids)[i] } : {}),
        },
      })
    }
  })
}
const schedule = (id: string, campaignId: string, data: Record<string, unknown>) =>
  inside(() => db().adSchedule.create({ data: { id, campaignId, name: id, enabled: true, ...data } }))
/** Only these schedules run (the job reads every enabled schedule). */
const only = (...ids: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { id: { in: ids } }, data: { enabled: true } })
})
const state = (campaignId: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id: campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } })
  const t = await db().adTarget.findMany({ where: { adGroup: { campaignId } }, orderBy: { id: 'asc' }, select: { bidCents: true, suppressedFromBidCents: true } })
  return { floored: c.bidsSuppressedAt != null, by: c.bidsSuppressedBy, targets: t }
})
const snapshotOf = async (id: string) => (await inside(() => db().adSchedule.findUnique({ where: { id }, select: { originalBids: true } })))?.originalBids
/** Queue rows for this campaign's ad group and targets (their ids start with the campaign's): what would go to Amazon. */
const queued = (campaignId: string): Promise<number> =>
  inside(() => db().outboundSyncQueue.count({ where: { payload: { path: ['entityId'], string_starts_with: campaignId } } }))

const ALWAYS_OPEN: unknown[] = [] // no windows: always serving, no multiplier
const PLUS = (pct: number) => [{ startHour: 0, endHour: 24, bidMultiplierPct: pct }] // always open, with a multiplier
/** A +50% window applied to base 40 / 30: it set 60 / 45. */
const SNAP_50 = (id: string) => ({ __mult__: 50, [`${id}-t0`]: 40, [`${id}-t1`]: 30, __set__: { [`${id}-t0`]: 60, [`${id}-t1`]: 45 } })

beforeAll(async () => {
  database = await formulaDatabase()
  await dial('AUTO')
}, 180_000)
afterAll(async () => { await database?.close() })

describe('ownedTargets — the bids a window still owns (pure)', () => {
  const snap = readSnapshot({ __mult__: 50, a: 40, b: 30, __set__: { a: 60, b: 45 } })
  it('a bid still at what the window set is owned; one a person changed is not', () => {
    expect(ownedTargets(snap, new Map([['a', 60], ['b', 55]]))).toEqual(['a'])
  })
  it('a target that is gone, or carries no remembered bid under a floor, is not touched', () => {
    expect(ownedTargets(snap, new Map([['a', null]]))).toEqual([])
  })
  it('an older snapshot without __set__ compares with the multiplied base; one with neither owns every target, as before', () => {
    expect(ownedTargets(readSnapshot({ __mult__: 50, a: 40, b: 30 }), new Map([['a', 60], ['b', 50]]))).toEqual(['a'])
    expect(ownedTargets(readSnapshot({ a: 40, b: 30 }), new Map([['a', 61], ['b', 50]]))).toEqual(['a', 'b'])
  })
})

describe('the window-open restore lifts only a Rank & Dayparting floor', () => {
  for (const [who, by] of [['a person', 'user:dp-test'], ['the out-of-stock check', 'automation:retail-guard']] as const) {
    it(`a floor set by ${who} stays floored in an open window`, async () => {
      const id = `dp-own-${by.replace(/\W/g, '')}`
      await seed(id, [35], { floorBy: by })
      await schedule(`${id}-s`, id, { windows: ALWAYS_OPEN })
      await only(`${id}-s`)
      const r = await inside(() => runDaypartingOnce())
      expect(r.changed).toBe(0)
      expect(await state(id)).toEqual({ floored: true, by, targets: [{ bidCents: 2, suppressedFromBidCents: 35 }] })
      expect(await queued(id)).toBe(0)
    })
  }

  it('control: its own floor is lifted in an open window', async () => {
    await seed('dp-own-mine', [35], { floorBy: 'automation:dayparting-dp-own-mine-s' })
    await schedule('dp-own-mine-s', 'dp-own-mine', { windows: ALWAYS_OPEN })
    await only('dp-own-mine-s')
    await inside(() => runDaypartingOnce())
    expect(await state('dp-own-mine')).toMatchObject({ floored: false, targets: [{ bidCents: 35, suppressedFromBidCents: null }] })
  })
})

describe('the multiplier never acts over a floor someone else set', () => {
  it('entering a +50% window waits: no snapshot, the floored bids stay at 2¢', async () => {
    await seed('dp-enter-oos', [40], { floorBy: 'automation:retail-guard' })
    await schedule('dp-enter-oos-s', 'dp-enter-oos', { windows: PLUS(50) })
    await only('dp-enter-oos-s')
    await inside(() => runDaypartingOnce())
    expect(await state('dp-enter-oos')).toMatchObject({ floored: true, targets: [{ bidCents: 2, suppressedFromBidCents: 40 }] })
    expect(await snapshotOf('dp-enter-oos-s')).toBeNull()
    expect(await queued('dp-enter-oos')).toBe(0)
  })

  it('leaving a multiplier puts the base into the floor\'s memory (Nexus only) and keeps a person\'s in-window bid', async () => {
    // Floored by the out-of-stock check while +50% was on: the floor remembers 60 (the window's) and 55 (a person's).
    await seed('dp-exit-oos', [40, 30], { floorBy: 'automation:retail-guard', remembered: [60, 55] })
    await schedule('dp-exit-oos-s', 'dp-exit-oos', { windows: ALWAYS_OPEN, originalBids: SNAP_50('dp-exit-oos') })
    await only('dp-exit-oos-s')
    await inside(() => runDaypartingOnce())
    expect(await state('dp-exit-oos')).toEqual({
      floored: true, by: 'automation:retail-guard',
      targets: [{ bidCents: 2, suppressedFromBidCents: 40 }, { bidCents: 2, suppressedFromBidCents: 55 }],
    })
    expect(await snapshotOf('dp-exit-oos-s')).toEqual({})
    expect(await queued('dp-exit-oos')).toBe(0)
  })
})

describe('a person\'s in-window bid is kept', () => {
  it('leaving the window gives back only the bids still at what it set', async () => {
    await seed('dp-exit-edit', [60, 55]) // the window set 60 / 45; a person moved the second to 55
    await schedule('dp-exit-edit-s', 'dp-exit-edit', { windows: ALWAYS_OPEN, originalBids: SNAP_50('dp-exit-edit') })
    await only('dp-exit-edit-s')
    const r = await inside(() => runDaypartingOnce())
    expect(r.bidsAdjusted).toBe(1)
    expect((await state('dp-exit-edit')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([40, 55])
    expect(await snapshotOf('dp-exit-edit-s')).toEqual({})
    expect(await queued('dp-exit-edit')).toBe(1)
  })

  it('moving to another multiplier re-applies only the owned bids; the changed one leaves the snapshot', async () => {
    await seed('dp-move-edit', [60, 55])
    await schedule('dp-move-edit-s', 'dp-move-edit', { windows: PLUS(100), originalBids: SNAP_50('dp-move-edit') })
    await only('dp-move-edit-s')
    await inside(() => runDaypartingOnce())
    expect((await state('dp-move-edit')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([80, 55])
    expect(await snapshotOf('dp-move-edit-s')).toEqual({ __mult__: 100, 'dp-move-edit-t0': 40, __set__: { 'dp-move-edit-t0': 80 } })
    // The next run changes nothing (no re-entry that would scale the person's bid).
    await inside(() => runDaypartingOnce())
    expect((await state('dp-move-edit')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([80, 55])
  })

  it('every bid changed by a person: the move drops them all, and later runs do not enter again over their bids', async () => {
    await seed('dp-move-all', [70, 55])
    await schedule('dp-move-all-s', 'dp-move-all', { windows: PLUS(100), originalBids: SNAP_50('dp-move-all') })
    await only('dp-move-all-s')
    await inside(() => runDaypartingOnce())
    expect(await snapshotOf('dp-move-all-s')).toEqual({ __mult__: 100, __set__: {} })
    await inside(() => runDaypartingOnce())
    expect((await state('dp-move-all')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([70, 55])
    expect(await queued('dp-move-all')).toBe(0)
  })

  it('what landed is recorded: a max-change clamp on entry is not taken for a person\'s change on exit', async () => {
    await seed('dp-clamp', [40], { dynamicBidding: { maxBidChangePct: 20 } })
    await schedule('dp-clamp-s', 'dp-clamp', { windows: PLUS(50) })
    await only('dp-clamp-s')
    await inside(() => runDaypartingOnce())
    expect((await state('dp-clamp')).targets[0].bidCents).toBe(48) // +50% asked, the campaign's 20% clamp let 48 through
    expect(await snapshotOf('dp-clamp-s')).toEqual({ __mult__: 50, 'dp-clamp-t0': 40, __set__: { 'dp-clamp-t0': 48 } })
    await inside(() => db().adSchedule.update({ where: { id: 'dp-clamp-s' }, data: { windows: ALWAYS_OPEN } }))
    await inside(() => runDaypartingOnce())
    expect((await state('dp-clamp')).targets[0].bidCents).toBe(40)
  })
})

describe('switching a classic schedule off or deleting it gives its multiplier back', () => {
  it('switched off: the owned bids return to their base, a person\'s stays, the snapshot is cleared', async () => {
    await seed('dp-off', [60, 55])
    await schedule('dp-off-s', 'dp-off', { windows: PLUS(50), originalBids: SNAP_50('dp-off') })
    const out = await inside(() => patchAdSchedule('dp-off-s', { enabled: false }))
    expect(out.ok).toBe(true)
    expect((await state('dp-off')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([40, 55])
    expect(await snapshotOf('dp-off-s')).toEqual({})
  })

  it('deleted: the same, and the answer says how many bids came back', async () => {
    await seed('dp-del', [60, 45])
    await schedule('dp-del-s', 'dp-del', { windows: PLUS(50), originalBids: SNAP_50('dp-del') })
    const out = await inside(() => deleteAdSchedule('dp-del-s'))
    expect(out).toMatchObject({ ok: true, value: { ok: true, multiplier: { restored: 2, deferred: false } } })
    expect((await state('dp-del')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([40, 30])
  })

  it('the switch text says the multiplier comes off', async () => {
    await seed('dp-brake', [60, 45])
    await schedule('dp-brake-s', 'dp-brake', { windows: PLUS(50), originalBids: SNAP_50('dp-brake'), enabled: false })
    expect(await inside(() => scheduleSwitchBrake('dp-brake-s'))).toBe("switched off, it floors no more bids in closed windows, its bid multiplier (+50%) comes off the bids still at the window's level at once (a bid a person changed in the window stays), and nothing it floored is floored now; placement percentages and the campaign's status stay as they are")
    await inside(() => db().adSchedule.delete({ where: { id: 'dp-brake-s' } }))
  })

  it('while stopped: a delete is refused (nothing changes); a switch-off keeps the bids on the row and the first run after Resume gives them back', async () => {
    await seed('dp-stop', [60, 55])
    await schedule('dp-stop-s', 'dp-stop', { windows: PLUS(50), originalBids: SNAP_50('dp-stop') })
    await only()
    await dial('AUTO', true)
    try {
      const del = await inside(() => deleteAdSchedule('dp-stop-s'))
      expect(del).toMatchObject({ ok: false, status: 409 })
      expect((del as { body: { error: string } }).body.error).toContain('Nothing was changed')
      expect(await snapshotOf('dp-stop-s')).toEqual(SNAP_50('dp-stop'))

      expect((await inside(() => patchAdSchedule('dp-stop-s', { enabled: false }))).ok).toBe(true)
      expect((await state('dp-stop')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([60, 55])
      expect(await snapshotOf('dp-stop-s')).toEqual(SNAP_50('dp-stop'))
      const held = await inside(() => runDaypartingOnce())
      expect(held.guard).toMatchObject({ posture: 'stopped', waiting: 1 })
      expect((await state('dp-stop')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([60, 55])
    } finally { await dial('AUTO') }

    const after = await inside(() => runDaypartingOnce())
    expect(after.bidsAdjusted).toBe(1)
    expect((await state('dp-stop')).targets.map((t: { bidCents: number }) => t.bidCents)).toEqual([40, 55])
    expect(await snapshotOf('dp-stop-s')).toEqual({})
  })
})
