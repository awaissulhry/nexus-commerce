/**
 * 2e (Owner D1 = A) — Rank & Dayparting is an hour-of-day bid plan.
 *
 * Each tick sets the hour's FIXED values and nothing else, so a tick inside the same hour writes nothing, and the next
 * write comes when the hour's painted value changes. An all-out target (and a target with a raised ceiling, keep-
 * climbing and steps) holds its Placement % instead of climbing +N% every 15 minutes.
 *
 * PGlite with the production schema and the real rank-defend tick. The audited mutation service and the placement
 * write are recorders that apply to the database (no queue, no gate, no Amazon). The hour is moved by moving the
 * schedule's time zone one hour east (UTC → Etc/GMT-1) on the same database clock, and every hour of the week is painted
 * by parity, so the governing target flips whatever hour the test runs in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
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
// 1e — the Run-now guard (switch, scheduler arm flags, engine lock) is proven in ads-engine-lock.vitest.test.ts.
vi.mock('../services/advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
const rec = vi.hoisted(() => ({ bids: [] as Array<{ id: string; bid: number }>, placements: [] as Array<{ campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }> }))
vi.mock('../services/advertising/ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAdGroupWithSync: async (a: { adGroupId: string; patch: { defaultBidCents: number } }) => {
    rec.bids.push({ id: a.adGroupId, bid: a.patch.defaultBidCents })
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  },
  updateAdTargetWithSync: async (a: { adTargetId: string; patch: { bidCents: number } }) => {
    rec.bids.push({ id: a.adTargetId, bid: a.patch.bidCents })
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  },
}))
vi.mock('../services/advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updatePlacementBidding: async (a: { campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }) => {
    rec.placements.push({ campaignId: a.campaignId, adjustments: a.adjustments })
    await database.client.campaign.update({ where: { id: a.campaignId }, data: { dynamicBidding: { placementBidding: a.adjustments } } })
    return { ok: true }
  },
}))

const { runRankDefendOnce } = await import('./ad-rank-defend.job.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** Every hour of every day painted: even local hours → `even`, odd → `odd`. */
const parity = (even: string, odd: string) => Array.from({ length: 24 }, (_, h) => ({ days: [], startHour: h, endHour: h + 1, targetKey: h % 2 === 0 ? even : odd }))

async function seed(id: string, schedule: { defaultTargetKey?: string | null; windows?: unknown; timezone?: string }) {
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        deliveryStatus: 'DELIVERING', deliveryReasons: [], dynamicBidding: { placementBidding: [] },
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: 40 } })
    await db().adTarget.create({ data: { id: `${id}-t0`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: 35 } })
    await db().adSchedule.create({ data: { id: `${id}-s`, campaignId: id, name: `${id}-s`, enabled: true, timezone: schedule.timezone ?? 'UTC', defaultTargetKey: schedule.defaultTargetKey ?? null, windows: schedule.windows ?? [] } })
  })
}
/** Only these campaigns' schedules run. */
const only = (...campaignIds: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { campaignId: { in: campaignIds } }, data: { enabled: true } })
})
const placementsOf = (id: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
  const out: Record<string, number> = {}
  for (const x of c.dynamicBidding?.placementBidding ?? []) if (x.percentage) out[x.placement] = x.percentage
  return out
})
const bidOf = (id: string) => inside(async () => (await db().adTarget.findFirst({ where: { adGroup: { campaignId: id } }, select: { bidCents: true } })).bidCents)
const dbHour = () => inside(async () => new Date((await db().$queryRaw`SELECT now() as now`)[0].now).getUTCHours())
const tick = () => inside(() => runRankDefendOnce())

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'flat50', name: 'Top +50%', biasPct: 50 } })
    // The built-in all-out target as seeded: before 2e it climbed +25% a tick from 150% toward 900%.
    await db().rankTarget.create({ data: { key: 'allout', name: 'Own Top — All-Out', biasPct: 150, allOut: true, targetISPct: 90 } })
    // A tuned chaser: a ceiling above Placement %, keep-climbing and a climb step — before 2e it ramped and climbed.
    await db().rankTarget.create({ data: { key: 'chaser', name: 'Chaser', biasPct: 100, maxBiasPct: 300, keepClimbing: true, stepUpPct: 20, stepDownPct: 10, targetISPct: 70, acosCapPct: 45 } })
    // A blend whose Top lane carries a ceiling and keep-climbing: each lane now holds its own %.
    await db().rankTarget.create({ data: { key: 'blend', name: 'Blend', biasPct: 0, lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 80, maxBiasPct: 400, keepClimbing: true, allOut: true }, { placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 20 }] } })
    await db().rankTarget.create({ data: { key: 'minbid', name: 'Min bid', pause: true, floorBidCents: 2 } })
    // C2 — Top +150 % under a €0.45 CPC ceiling, as IT_Auto_Close's plan hour on 2026-10-07.
    await db().rankTarget.create({ data: { key: 'top150cap45', name: 'Top +150% (45¢ ceiling)', biasPct: 150, maxCpcCents: 45 } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { rec.bids = []; rec.placements = [] })

describe('2e — no climbing: all-out, a raised ceiling, keep-climbing and steps hold the Placement %', () => {
  it('sets each target once, then holds it tick after tick with no write', async () => {
    await seed('ao', { defaultTargetKey: 'allout' })
    await seed('ch', { defaultTargetKey: 'chaser' })
    await seed('bl', { defaultTargetKey: 'blend' })
    await only('ao', 'ch', 'bl')

    const first = await tick()
    expect(await placementsOf('ao')).toEqual({ PLACEMENT_TOP: 150 })
    expect(await placementsOf('ch')).toEqual({ PLACEMENT_TOP: 100 }) // before 2e: ramp 0 → 20
    expect(await placementsOf('bl')).toEqual({ PLACEMENT_TOP: 80, PLACEMENT_REST_OF_SEARCH: 20 })
    expect(rec.placements).toHaveLength(3)
    expect(first.applied).toBe(3)

    for (let i = 0; i < 3; i++) {
      rec.placements = []
      const again = await tick()
      expect(rec.placements).toEqual([]) // before 2e: all-out 150 → 175 → 200 → 225, the chaser +20 each tick
      expect(again.applied).toBe(0)
      const ours = again.decisions.filter((d) => ['ao', 'ch', 'bl'].includes(d.campaignId))
      expect(ours).toHaveLength(3)
      expect(ours.every((d) => d.action === 'hold')).toBe(true)
    }
    expect(await placementsOf('ao')).toEqual({ PLACEMENT_TOP: 150 })
    expect(await placementsOf('ch')).toEqual({ PLACEMENT_TOP: 100 })
    expect(await placementsOf('bl')).toEqual({ PLACEMENT_TOP: 80, PLACEMENT_REST_OF_SEARCH: 20 })
  })

  it('a decision carries no impression-share, ACoS or loss reading any more', async () => {
    await only('ao')
    const r = await tick()
    const d = r.decisions.find((x) => x.campaignId === 'ao')!
    expect(d).toMatchObject({ action: 'hold', currentPct: 150, nextPct: 150 })
    expect(d).not.toHaveProperty('achievedISPct')
    expect(d).not.toHaveProperty('achievedAcosPct')
    expect(d).not.toHaveProperty('lossDetected')
  })
})

describe('2e — a tick writes only when the hour\'s painted value changes', () => {
  it('placements: one write when the hour flips, none while it stays', async () => {
    await seed('hp', { windows: parity('flat50', 'allout') })
    await only('hp')
    const h0 = await dbHour()
    const first = await tick()
    expect(first.applied).toBe(1)
    const want = h0 % 2 === 0 ? 50 : 150
    expect(await placementsOf('hp')).toEqual({ PLACEMENT_TOP: want })

    rec.placements = []
    const same = await tick()
    if ((await dbHour()) === h0) { // the real clock did not cross an hour between the two ticks
      expect(rec.placements).toEqual([])
      expect(same.applied).toBe(0)
    }

    // The next hour: the schedule's local hour moves one on, so the other painted target governs.
    await inside(() => db().adSchedule.update({ where: { id: 'hp-s' }, data: { timezone: 'Etc/GMT-1' } }))
    rec.placements = []
    const next = await tick()
    expect(rec.placements).toHaveLength(1)
    expect(next.applied).toBe(1)
    expect(await placementsOf('hp')).toEqual({ PLACEMENT_TOP: want === 50 ? 150 : 50 })

    rec.placements = []
    expect((await tick()).applied).toBe(0)
  })

  it('Min-bid hours: the floor lands once when the hour enters, the bids come back once when it leaves', async () => {
    await seed('hm', { windows: parity('minbid', 'flat50') })
    await only('hm')
    // Start in whichever local hour is the Min-bid one.
    if ((await dbHour()) % 2 === 1) await inside(() => db().adSchedule.update({ where: { id: 'hm-s' }, data: { timezone: 'Etc/GMT-1' } }))
    const h0 = await dbHour()
    await tick()
    expect(await bidOf('hm')).toBe(2)
    const floorWrites = rec.bids.length
    expect(floorWrites).toBeGreaterThan(0)

    rec.bids = []
    await tick()
    if ((await dbHour()) === h0) expect(rec.bids).toEqual([]) // still the Min-bid hour: nothing to do

    // Leave the Min-bid hour.
    await inside(async () => {
      const { timezone } = await db().adSchedule.findUnique({ where: { id: 'hm-s' }, select: { timezone: true } })
      await db().adSchedule.update({ where: { id: 'hm-s' }, data: { timezone: timezone === 'UTC' ? 'Etc/GMT-1' : 'Etc/GMT-2' } })
    })
    rec.bids = []
    rec.placements = []
    await tick()
    expect(await bidOf('hm')).toBe(35)
    expect(await placementsOf('hm')).toEqual({ PLACEMENT_TOP: 50 })
    rec.bids = []
    rec.placements = []
    const after = await tick()
    expect(after.applied).toBe(0)
    expect(rec.bids).toEqual([])
  })
})

describe('C2 — the CPC ceiling is measured against the bids that serve', () => {
  /** An auto campaign as IT_Auto_Close: its ad group's default bid, one live auto target and three paused ones. */
  const auto = (id: string, liveBidCents: number) => inside(async () => {
    await db().adGroup.update({ where: { id: `${id}-g` }, data: { defaultBidCents: 50, targetingType: 'AUTO' } })
    await db().adTarget.update({ where: { id: `${id}-t0` }, data: { kind: 'AUTO', expressionType: 'SEARCH_CLOSE_MATCH', bidCents: liveBidCents } })
    for (const [i, match] of ['SEARCH_LOOSE_MATCH', 'PRODUCT_SUBSTITUTES', 'PRODUCT_COMPLEMENTS'].entries()) {
      await db().adTarget.create({ data: { id: `${id}-p${i}`, adGroupId: `${id}-g`, kind: 'AUTO', expressionType: match, expressionValue: match, bidCents: 30, status: 'PAUSED' } })
    }
  })

  it("an ad group default no target uses is not the base: the 14¢ live target leaves 150 % uncapped (it was capped to 0 %)", async () => {
    await seed('ac', { defaultTargetKey: 'top150cap45' })
    await auto('ac', 14)
    await only('ac')
    const r = await tick()
    // €0.45 / 14¢ − 1 = 221 %: 150 % fits. Before, the 50¢ default read "base bid ALONE exceeds it" and wrote 0 %.
    expect(await placementsOf('ac')).toEqual({ PLACEMENT_TOP: 150 })
    const d = r.decisions.find((x) => x.campaignId === 'ac')!
    expect(d.reason).not.toContain('CPC ceiling')
  })

  it('a live bid the ceiling cannot carry at 150 % still caps it: 30¢ → 50 %', async () => {
    await seed('ac30', { defaultTargetKey: 'top150cap45' })
    await auto('ac30', 30)
    await only('ac30')
    const r = await tick()
    expect(await placementsOf('ac30')).toEqual({ PLACEMENT_TOP: 50 })
    expect(r.decisions.find((x) => x.campaignId === 'ac30')!.reason).toContain('capped 150→50% by €0.45 CPC ceiling')
  })
})
