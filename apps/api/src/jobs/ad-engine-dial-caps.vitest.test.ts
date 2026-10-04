/**
 * Group 1 (1c) — rank-defend and classic dayparting honour the account dial and their own caps, end to end.
 *
 * The hole this closes (review 2.2 follow-on): 1a lets a FLOOR pass a halt at the gate, but `restoreCampaignBids`
 * moves Nexus's own bids and clears its memory BEFORE the gate refuses the raise — Nexus would show 35¢ while
 * Amazon stays at 2¢ (workers/ads-sync-suppression.vitest.test.ts shows the refused restore). So while stopped the
 * engines must not attempt a restore at all; `bidsSuppressedAt` stays set and the first run after Resume restores.
 *
 * The real jobs, the real suppress / restore services, the real enqueue and the real worker on PGlite with the
 * production schema. The gate is a stand-in that answers as the real one does on the halt alone (stopped: only a
 * suppression passes — ads-write-gate-bounds proves the real gate's half); Amazon is a recorder. Nothing leaves the
 * process.
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
const gate = vi.hoisted(() => ({ halted: false, seen: [] as GateContext[] }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return gate.halted && !ctx.isSuppression
      ? { allowed: false, deniedAt: 'automation_halted', reason: 'ads automation is stopped (halted: test)' }
      : { allowed: true, mode: 'live', profileId: 'P-IT-TEST' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
// 1e — the Run-now guard (switch, scheduler arm flags, engine lock) is proven in ads-engine-lock.vitest.test.ts; every run gets through it here.
vi.mock('../services/advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record }
})

const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
const { runRankDefendOnce, rankDefendSummaryLine } = await import('./ad-rank-defend.job.js')
const { runDaypartingOnce, daypartingSummaryLine } = await import('./ad-dayparting.job.js')
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

/** One campaign: an ad group (default bid) and keyword targets (bids). `suppressed` seeds a campaign already floored. */
async function seedCampaign(id: string, groupBid: number, targetBids: number[], suppressed = false) {
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        ...(suppressed ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'automation:test' } : {}),
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
const schedule = (id: string, campaignId: string, data: Record<string, unknown>) =>
  inside(() => db().adSchedule.create({ data: { id, campaignId, name: id, enabled: false, ...data } }))
/** Only these schedules run (every job reads every enabled schedule). */
const only = (...ids: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { id: { in: ids } }, data: { enabled: true } })
})
const bids = (campaignId: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id: campaignId }, select: { bidsSuppressedAt: true, dynamicBidding: true } })
  const g = await db().adGroup.findMany({ where: { campaignId }, select: { defaultBidCents: true, suppressedFromBidCents: true } })
  const t = await db().adTarget.findMany({ where: { adGroup: { campaignId } }, orderBy: { id: 'asc' }, select: { bidCents: true, suppressedFromBidCents: true } })
  return { suppressed: c.bidsSuppressedAt != null, placement: c.dynamicBidding, group: g[0], targets: t }
})
/** Drain the queue: what reached Amazon, and how the rows settled. */
async function drain() {
  gate.seen = []; amazon.calls = []
  const out = await inside(() => drainAdsSyncOnce(100))
  const rows = await inside(() => db().outboundSyncQueue.findMany({ where: { id: { in: out.results.map((r: { queueId: string }) => r.queueId) } }, select: { syncStatus: true } }))
  return { processed: out.processed as number, statuses: rows.map((r: { syncStatus: string }) => r.syncStatus), calls: amazon.calls.map((c) => c.patch) }
}
const sortCalls = (calls: Array<Record<string, unknown>>) => calls.map((c) => JSON.stringify(c)).sort()

const savedCaps = process.env[ENGINE_CAPS_ENV]
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'pause', name: 'Min bid', pause: true } })
    await db().rankTarget.create({ data: { key: 'hold', name: 'Hold, no placement', biasPct: 0 } })
    await db().rankTarget.create({ data: { key: 'top50', name: 'Top +50%', biasPct: 50 } })
  })
}, 180_000)
afterAll(async () => {
  if (savedCaps === undefined) delete process.env[ENGINE_CAPS_ENV]; else process.env[ENGINE_CAPS_ENV] = savedCaps
  await database?.close()
})
beforeEach(async () => {
  delete process.env[ENGINE_CAPS_ENV]
  await drain() // nothing from an earlier arm is left in the queue
})

describe('rank-defend while stopped (Owner S1): the floor lands, the restore waits for Resume', () => {
  it('halt → floor lands on Amazon → restore not attempted while halted → after Resume the next run restores', async () => {
    await seedCampaign('rd-halt', 40, [35, 60])
    await schedule('rd-halt-s', 'rd-halt', { defaultTargetKey: 'pause' })
    await only('rd-halt-s')
    await dial('AUTO', true)

    // 1. Halted, Min-bid window: the floor is the one change allowed, and the gate lets it through.
    const floorRun = await inside(() => runRankDefendOnce())
    expect(floorRun.guard).toMatchObject({ posture: 'stopped', changes: 3, waiting: 0 })
    expect(floorRun.applied).toBe(3)
    const floored = await drain()
    expect(floored.statuses).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS'])
    expect(sortCalls(floored.calls)).toEqual(sortCalls([{ bid: 0.02 }, { bid: 0.02 }, { defaultBid: 0.02 }]))

    // 2. Still halted, the window turns to a serving target: the restore is NOT attempted. Before 1c it ran here —
    //    Nexus back at 35/60/40, its memory cleared — and the gate refused all three: Amazon stranded at 2¢.
    await inside(() => db().adSchedule.update({ where: { id: 'rd-halt-s' }, data: { defaultTargetKey: 'hold' } }))
    const heldRun = await inside(() => runRankDefendOnce())
    expect(heldRun.applied).toBe(0)
    expect(heldRun.guard).toMatchObject({ posture: 'stopped', changes: 0, waiting: 1 })
    expect(rankDefendSummaryLine(heldRun)).toContain('waiting=1 (stopped — halted: test halt: only bid floors land;')
    expect(await bids('rd-halt')).toMatchObject({
      suppressed: true, group: { defaultBidCents: 2, suppressedFromBidCents: 40 },
      targets: [{ bidCents: 2, suppressedFromBidCents: 35 }, { bidCents: 2, suppressedFromBidCents: 60 }],
    })
    const nothing = await drain()
    expect(nothing.processed).toBe(0)
    expect(nothing.calls).toEqual([])

    // 3. Resume: the first run restores exactly, and Amazon gets the raises.
    await dial('AUTO', false)
    const restoreRun = await inside(() => runRankDefendOnce())
    expect(restoreRun.applied).toBe(3)
    expect(restoreRun.guard).toMatchObject({ posture: 'auto', waiting: 0, deferredByCap: 0 })
    expect(rankDefendSummaryLine(restoreRun)).toBe('evaluated=1 applied=3') // a normal run's line is unchanged
    expect(await bids('rd-halt')).toMatchObject({
      suppressed: false, group: { defaultBidCents: 40, suppressedFromBidCents: null },
      targets: [{ bidCents: 35, suppressedFromBidCents: null }, { bidCents: 60, suppressedFromBidCents: null }],
    })
    const restored = await drain()
    expect(restored.statuses).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS'])
    expect(sortCalls(restored.calls)).toEqual(sortCalls([{ bid: 0.35 }, { bid: 0.6 }, { defaultBid: 0.4 }]))
  })

  it('a dry run (the preview) reads no dial and writes nothing, as before', async () => {
    await seedCampaign('rd-dry', 40, [35])
    await schedule('rd-dry-s', 'rd-dry', { defaultTargetKey: 'pause' })
    await only('rd-dry-s')
    await dial('AUTO', true)
    const r = await inside(() => runRankDefendOnce({ dryRun: true }))
    expect(r.guard).toBeUndefined()
    expect(r.applied).toBe(0)
    expect((await bids('rd-dry')).suppressed).toBe(false)
  })
})

describe('rank-defend under SUGGEST (Owner S2): nothing new is written, its own floors are given back', () => {
  it('a Min-bid window does not floor; a serving window restores its floor but does not move the placement', async () => {
    await seedCampaign('rd-sug-floor', 40, [35])
    await seedCampaign('rd-sug-serve', 40, [35], true)
    await schedule('rd-sug-floor-s', 'rd-sug-floor', { defaultTargetKey: 'pause' })
    await schedule('rd-sug-serve-s', 'rd-sug-serve', { defaultTargetKey: 'top50' })
    await only('rd-sug-floor-s', 'rd-sug-serve-s')
    await dial('SUGGEST')

    const r = await inside(() => runRankDefendOnce())
    expect(r.guard).toMatchObject({ posture: 'suggest', wouldApply: 2, changes: 2 })
    expect(rankDefendSummaryLine(r)).toBe('evaluated=2 applied=2 would-apply=2 (the account ads dial is SUGGEST: nothing new is written; its own floors are still given back)')
    // Not floored.
    expect(await bids('rd-sug-floor')).toMatchObject({ suppressed: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 35 }] })
    // Restored (a give-back), and the Top +50% placement was not written.
    const serve = await bids('rd-sug-serve')
    expect(serve).toMatchObject({ suppressed: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 35 }] })
    expect(JSON.stringify(serve.placement ?? {})).not.toContain('PLACEMENT_TOP')
    const d = await drain()
    expect(sortCalls(d.calls)).toEqual(sortCalls([{ bid: 0.35 }, { defaultBid: 0.4 }]))
  })
})

describe('rank-defend caps (review 2.5): per run and per day, a campaign never split', () => {
  it('the run cap defers whole campaigns: one finishes (overshoot at most itself), the other is untouched, next run picks it up', async () => {
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ 'rank-defend': { perTick: 2 } })
    await seedCampaign('rd-cap-a', 40, [35, 60])
    await seedCampaign('rd-cap-b', 40, [35, 60])
    await schedule('rd-cap-a-s', 'rd-cap-a', { defaultTargetKey: 'pause' })
    await schedule('rd-cap-b-s', 'rd-cap-b', { defaultTargetKey: 'pause' })
    await only('rd-cap-a-s', 'rd-cap-b-s')
    await dial('AUTO')

    const first = await inside(() => runRankDefendOnce())
    expect(first.applied).toBe(3)
    expect(first.guard).toMatchObject({ posture: 'auto', changes: 3, deferredByCap: 1 })
    expect(rankDefendSummaryLine(first)).toContain('deferred-by-cap=1 (cap 2 a run, 3,000 a day; 3 this run,')
    const a = await bids('rd-cap-a'), b = await bids('rd-cap-b')
    const [done, deferred] = a.suppressed ? [a, b] : [b, a]
    expect(done).toMatchObject({ suppressed: true, group: { defaultBidCents: 2 }, targets: [{ bidCents: 2 }, { bidCents: 2 }] })
    // Fully normal: not one entity of the deferred campaign was floored.
    expect(deferred).toMatchObject({ suppressed: false, group: { defaultBidCents: 40, suppressedFromBidCents: null }, targets: [{ bidCents: 35 }, { bidCents: 60 }] })
    await drain()

    const second = await inside(() => runRankDefendOnce())
    expect(second.applied).toBe(3)
    expect(second.guard).toMatchObject({ deferredByCap: 0 })
    expect((await bids('rd-cap-a')).suppressed && (await bids('rd-cap-b')).suppressed).toBe(true)
  })

  it("the day cap counts today's changes; a give-back still runs past it (never refused, only counted)", async () => {
    // Earlier arms already wrote more than 5 rank-defend changes today.
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ 'rank-defend': { perDay: 5 } })
    await seedCampaign('rd-day-floor', 40, [35])
    await seedCampaign('rd-day-restore', 40, [35], true)
    await schedule('rd-day-floor-s', 'rd-day-floor', { defaultTargetKey: 'pause' })
    await schedule('rd-day-restore-s', 'rd-day-restore', { defaultTargetKey: 'hold' })
    await only('rd-day-floor-s', 'rd-day-restore-s')
    await dial('AUTO')

    const r = await inside(() => runRankDefendOnce())
    expect(r.guard!.todayBefore).toBeGreaterThanOrEqual(5)
    expect(r.guard).toMatchObject({ deferredByCap: 1, changes: 2 })
    expect((await bids('rd-day-floor')).suppressed).toBe(false)
    expect(await bids('rd-day-restore')).toMatchObject({ suppressed: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 35 }] })
  })
})

describe('classic dayparting honours the dial the same way', () => {
  const CLOSED = [{ days: [], startHour: 0, endHour: 24 }] // a window that never opens

  it('halt → a closing window floors → an opening window does not restore while halted → after Resume it restores', async () => {
    await seedCampaign('dp-halt', 40, [30])
    await schedule('dp-halt-s', 'dp-halt', { windows: CLOSED })
    await only('dp-halt-s')
    await dial('AUTO', true)

    const floorRun = await inside(() => runDaypartingOnce())
    expect(floorRun.guard).toMatchObject({ posture: 'stopped', changes: 2, waiting: 0 })
    expect((await drain()).statuses).toEqual(['SUCCESS', 'SUCCESS'])

    await inside(() => db().adSchedule.update({ where: { id: 'dp-halt-s' }, data: { windows: [] } })) // always open
    const heldRun = await inside(() => runDaypartingOnce())
    expect(heldRun.guard).toMatchObject({ posture: 'stopped', changes: 0, waiting: 1 })
    expect(daypartingSummaryLine(heldRun)).toContain('waiting=1 (stopped')
    expect(await bids('dp-halt')).toMatchObject({ suppressed: true, group: { suppressedFromBidCents: 40 }, targets: [{ bidCents: 2, suppressedFromBidCents: 30 }] })
    expect((await drain()).processed).toBe(0)

    await dial('AUTO', false)
    const restoreRun = await inside(() => runDaypartingOnce())
    expect(restoreRun.guard).toMatchObject({ posture: 'auto', changes: 2 })
    expect(daypartingSummaryLine(restoreRun)).toBe('evaluated=1 changed=1')
    expect(await bids('dp-halt')).toMatchObject({ suppressed: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 30, suppressedFromBidCents: null }] })
    expect((await drain()).statuses).toEqual(['SUCCESS', 'SUCCESS'])
  })

  it('a multiplier exit held while stopped: the floor remembers the multiplied bid, the next run puts the base there, Resume restores the base', async () => {
    await seedCampaign('dp-mult', 40, [60]) // base 40, +50% applied → 60 on the target
    await schedule('dp-mult-s', 'dp-mult', { windows: CLOSED, originalBids: { __mult__: 50, 'dp-mult-t0': 40 } })
    await only('dp-mult-s')
    await dial('AUTO', true)

    const first = await inside(() => runDaypartingOnce())
    expect(first.guard).toMatchObject({ waiting: 1 }) // the exit (a raise-or-lower Amazon would refuse) waits
    expect(await bids('dp-mult')).toMatchObject({ suppressed: true, targets: [{ bidCents: 2, suppressedFromBidCents: 60 }] })
    await drain()

    const second = await inside(() => runDaypartingOnce())
    // Nexus only: the base becomes what the restore returns to; nothing is queued, Amazon keeps the floor.
    expect(await bids('dp-mult')).toMatchObject({ suppressed: true, targets: [{ bidCents: 2, suppressedFromBidCents: 40 }] })
    expect(await inside(() => db().adSchedule.findUnique({ where: { id: 'dp-mult-s' }, select: { originalBids: true } }))).toEqual({ originalBids: {} })
    expect(second.guard).toMatchObject({ changes: 0 })
    expect((await drain()).processed).toBe(0)

    await dial('AUTO', false)
    await inside(() => db().adSchedule.update({ where: { id: 'dp-mult-s' }, data: { windows: [] } }))
    await inside(() => runDaypartingOnce())
    expect(await bids('dp-mult')).toMatchObject({ suppressed: false, targets: [{ bidCents: 40, suppressedFromBidCents: null }] })
  })

  it('SUGGEST: a closing window does not floor (would-apply), an opening one still lifts its own floor', async () => {
    await seedCampaign('dp-sug-close', 40, [30])
    await seedCampaign('dp-sug-open', 40, [30], true)
    await schedule('dp-sug-close-s', 'dp-sug-close', { windows: CLOSED })
    await schedule('dp-sug-open-s', 'dp-sug-open', { windows: [] })
    await only('dp-sug-close-s', 'dp-sug-open-s')
    await dial('SUGGEST')
    const r = await inside(() => runDaypartingOnce())
    expect(r.guard).toMatchObject({ posture: 'suggest', wouldApply: 1, changes: 2 })
    expect((await bids('dp-sug-close')).suppressed).toBe(false)
    expect(await bids('dp-sug-open')).toMatchObject({ suppressed: false, targets: [{ bidCents: 30 }] })
  })
})
