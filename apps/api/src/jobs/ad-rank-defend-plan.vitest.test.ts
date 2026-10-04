/**
 * 2c (review 2.5, G.11) — the rank tick decides first, then writes in one order: give-backs, floors, placement moves,
 * base bids. A campaign still asks its permit once and finishes (1c), so when a cap binds the campaigns it defers are
 * the ones at the back, never a give-back. Anti-flap: a campaign enters Min bid at most twice a UTC day, counted from
 * the action log; a later Min-bid hour leaves it serving.
 *
 * PGlite with the production schema and the real rank-defend tick. The audited mutation service and the placement
 * write are recorders that apply to the database and log the order of every write (no queue, no gate, no Amazon).
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
/** Every write, in the order the tick made it: the campaign it belongs to and what it was. */
const rec = vi.hoisted(() => ({ writes: [] as Array<{ campaign: string; what: 'bid' | 'placement'; value: unknown }> }))
const campaignOf = (entityId: string) => entityId.replace(/-(g|t\d+)$/, '')
vi.mock('../services/advertising/ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAdGroupWithSync: async (a: { adGroupId: string; patch: { defaultBidCents: number } }) => {
    rec.writes.push({ campaign: campaignOf(a.adGroupId), what: 'bid', value: a.patch.defaultBidCents })
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  },
  updateAdTargetWithSync: async (a: { adTargetId: string; patch: { bidCents: number } }) => {
    rec.writes.push({ campaign: campaignOf(a.adTargetId), what: 'bid', value: a.patch.bidCents })
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  },
}))
vi.mock('../services/advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updatePlacementBidding: async (a: { campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }) => {
    rec.writes.push({ campaign: a.campaignId, what: 'placement', value: a.adjustments })
    await database.client.campaign.update({ where: { id: a.campaignId }, data: { dynamicBidding: { placementBidding: a.adjustments } } })
    return { ok: true }
  },
}))

const { runRankDefendOnce, rankDefendSummaryLine } = await import('./ad-rank-defend.job.js')
const { ENGINE_CAPS_ENV } = await import('../services/advertising/ads-engine-actors.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** One campaign (an ad group at 40¢, one keyword at 35¢) and its schedule. `floored` = already floored by rank. */
async function seed(id: string, targetKey: string, floored = false) {
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        deliveryStatus: 'DELIVERING', deliveryReasons: [], dynamicBidding: { placementBidding: [] },
        ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: `automation:rank-defend-${id}-s` } : {}),
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: floored ? 2 : 40, ...(floored ? { suppressedFromBidCents: 40 } : {}) } })
    await db().adTarget.create({ data: { id: `${id}-t0`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: floored ? 2 : 35, ...(floored ? { suppressedFromBidCents: 35 } : {}) } })
    await db().adSchedule.create({ data: { id: `${id}-s`, campaignId: id, name: `${id}-s`, enabled: true, timezone: 'UTC', defaultTargetKey: targetKey, windows: [] } })
  })
}
/** Only these campaigns' schedules run. */
const only = (...campaignIds: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { campaignId: { in: campaignIds } }, data: { enabled: true } })
})
/** A Min-bid entry the action log already holds for this campaign (as the tick records one). */
const priorEntry = (id: string, createdAt?: Date) => inside(() => db().advertisingActionLog.create({
  data: { actionType: 'custom_event', entityType: 'CAMPAIGN', entityId: id, userId: `automation:rank-defend-${id}-s`, payloadBefore: {}, payloadAfter: { rankMinBidEntry: true, note: 'earlier entry' }, amazonResponseStatus: 'SUCCESS', ...(createdAt ? { createdAt } : {}) },
}))
const entriesOf = (id: string) => inside(async () => (await db().advertisingActionLog.findMany({ where: { entityType: 'CAMPAIGN', entityId: id, actionType: 'custom_event' }, orderBy: { createdAt: 'asc' } })) as Array<{ createdAt: Date; payloadAfter: { note?: string } }>)
const floored = (id: string) => inside(async () => (await db().campaign.findUnique({ where: { id }, select: { bidsSuppressedAt: true } })).bidsSuppressedAt != null)
const tick = () => inside(() => runRankDefendOnce())
const ours = (...ids: string[]) => rec.writes.filter((w) => ids.includes(w.campaign))

const savedCaps = process.env[ENGINE_CAPS_ENV]
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'top50', name: 'Top +50%', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'hold0', name: 'Hold, no placement', biasPct: 0 } })
    await db().rankTarget.create({ data: { key: 'minbid', name: 'Min bid', pause: true, floorBidCents: 2 } })
    await db().rankTarget.create({ data: { key: 'basefloor', name: 'Base bid floored', biasPct: 0, bidMode: 'suppress' } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
}, 180_000)
afterAll(async () => {
  if (savedCaps === undefined) delete process.env[ENGINE_CAPS_ENV]; else process.env[ENGINE_CAPS_ENV] = savedCaps
  await database?.close()
})
beforeEach(() => { rec.writes = []; delete process.env[ENGINE_CAPS_ENV] })

describe('2c — decide, then write: restore → suppress → placement, whatever order the schedules load in', () => {
  it('writes the give-back first, then the floor, then the placement move; decisions come back in loop order', async () => {
    // Loaded placement-first: before 2c the tick wrote in this order.
    await seed('o-place', 'top50')
    await seed('o-floor', 'minbid')
    await seed('o-restore', 'hold0', true)
    await only('o-place', 'o-floor', 'o-restore')

    const r = await tick()
    expect(ours('o-place', 'o-floor', 'o-restore').map((w) => `${w.campaign}:${w.what}`)).toEqual([
      'o-restore:bid', 'o-restore:bid', 'o-floor:bid', 'o-floor:bid', 'o-place:placement',
    ])
    expect(r.writes).toEqual({ restore: 2, suppress: 2, placement: 1, base: 0 })
    expect(rankDefendSummaryLine(r)).toMatch(/^evaluated=3 applied=5 restore=2 suppress=2 placement=1 base=0 deferred=0/)
    // The summary keeps the order the schedules were read in, not the order they were written in.
    const loaded = await inside(async () => (await db().adSchedule.findMany({ where: { enabled: true } })).map((s: { campaignId: string }) => s.campaignId))
    expect(r.decisions.map((d) => d.campaignId)).toEqual(loaded)
  })

  it('a run cap defers the whole campaigns at the back — never the give-back, never half a campaign', async () => {
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ 'rank-defend': { perTick: 2 } })
    await seed('c-place', 'top50')
    await seed('c-floor', 'minbid')
    await seed('c-restore', 'hold0', true)
    await only('c-place', 'c-floor', 'c-restore')

    const r = await tick()
    // Before 2c: the placement (1) and the floor (2) went first, the restore after (never refused) — 5 changes, none
    // deferred. Now the restore goes first and fills the cap; the floor and the placement wait, untouched, for next run.
    expect(ours('c-place', 'c-floor', 'c-restore').map((w) => `${w.campaign}:${w.what}`)).toEqual(['c-restore:bid', 'c-restore:bid'])
    expect(await floored('c-restore')).toBe(false)
    expect(await floored('c-floor')).toBe(false)
    expect(await inside(async () => (await db().adTarget.findUnique({ where: { id: 'c-floor-t0' } })).bidCents)).toBe(35)
    expect(r.guard).toMatchObject({ changes: 2, deferredByCap: 2 })
    expect(rankDefendSummaryLine(r)).toContain('restore=2 suppress=0 placement=0 base=0 deferred=2')

    rec.writes = []
    const next = await tick()
    expect(ours('c-place', 'c-floor').map((w) => `${w.campaign}:${w.what}`)).toEqual(['c-floor:bid', 'c-floor:bid'])
    expect(next.guard).toMatchObject({ deferredByCap: 1 }) // the placement goes the run after
  })
})

describe('2c — anti-flap: at most two Min-bid entries per campaign per UTC day, counted from the action log', () => {
  it('an entry is recorded once on the campaign, as a note the Change Log shows', async () => {
    await seed('a-first', 'minbid')
    await only('a-first')
    await tick()
    expect(await floored('a-first')).toBe(true)
    const e = await entriesOf('a-first')
    expect(e).toHaveLength(1)
    expect(e[0].payloadAfter.note).toBe('Min bid: every bid floored to €0.02 — entry 1 of 2 allowed today (UTC)')
    await tick() // already floored: no second entry
    expect(await entriesOf('a-first')).toHaveLength(1)
  })

  it('a second entry today still floors; a third keeps the campaign serving and writes nothing', async () => {
    await seed('a-second', 'minbid')
    await seed('a-third', 'minbid')
    await priorEntry('a-second')
    await priorEntry('a-third'); await priorEntry('a-third')
    await only('a-second', 'a-third')

    const r = await tick()
    expect(await floored('a-second')).toBe(true)
    expect((await entriesOf('a-second')).at(-1)?.payloadAfter.note).toContain('entry 2 of 2')
    expect(await floored('a-third')).toBe(false)
    expect(ours('a-third')).toEqual([])
    const held = r.decisions.find((d) => d.campaignId === 'a-third')!
    expect(held.action).toBe('hold')
    expect(held.reason).toContain('kept serving: this campaign already entered Min bid 2 times today (UTC)')
    expect(r.keptServing).toBe(1)
    expect(rankDefendSummaryLine(r)).toContain('kept-serving=1 (entered Min bid 2 times today already)')
    expect(await entriesOf('a-third')).toHaveLength(2) // no entry recorded for a hold

    rec.writes = []
    const again = await tick()
    expect(ours('a-third')).toEqual([])
    expect(again.keptServing).toBe(1)
  })

  it("yesterday's entries do not count", async () => {
    await seed('a-yesterday', 'minbid')
    const now = new Date()
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3600_000)
    await priorEntry('a-yesterday', yesterday); await priorEntry('a-yesterday', yesterday)
    await only('a-yesterday')
    await tick()
    expect(await floored('a-yesterday')).toBe(true)
  })

  it('a floored base bid counts as an entry too: the third keeps serving, its placement still holds', async () => {
    await seed('a-base', 'basefloor')
    await priorEntry('a-base'); await priorEntry('a-base')
    await only('a-base')
    const r = await tick()
    expect(await floored('a-base')).toBe(false)
    expect(ours('a-base').filter((w) => w.what === 'bid')).toEqual([])
    expect(r.decisions.find((d) => d.campaignId === 'a-base')!.reason).toContain('kept serving')
    expect(r.keptServing).toBe(1)
  })

  it('a give-back is never held by the anti-flap', async () => {
    await seed('a-restore', 'hold0', true)
    await priorEntry('a-restore'); await priorEntry('a-restore')
    await only('a-restore')
    const r = await tick()
    expect(await floored('a-restore')).toBe(false)
    expect(r.writes).toMatchObject({ restore: 2 })
  })
})
