/**
 * Group 2 (2a) — Rank & Dayparting gives bids back when a schedule is deleted, paused, loses a campaign or holds
 * nothing (review 3.2), the legacy schedule delete / disable no longer re-enable a paused campaign (3.3), rank-defend
 * leaves a floor it did not set alone (N1), and a release that waited (halted, switched off) is given back by the orphan
 * sweep of the first run after (N3, Owner S1/S7).
 *
 * PGlite with the production schema; the real routes, services and rank-defend tick. The audited mutation service is a
 * recorder that applies each bid to the database (no queue, no gate, no Amazon), so every assertion reads Nexus's own
 * copy — the copy that must not move while ads automation is stopped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
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
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
// 1e — the Run-now guard (switch, scheduler arm flags, engine lock) is proven in ads-engine-lock.vitest.test.ts.
vi.mock('./ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
// The recorder: each accepted bid lands on the row, as the real service does locally; `fail` ids are not accepted.
const rec = vi.hoisted(() => ({
  writes: [] as Array<{ id: string; bid: number; actor: string }>,
  statusWrites: [] as unknown[],
  fail: new Set<string>(),
}))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAdGroupWithSync: async (a: { adGroupId: string; patch: { defaultBidCents: number }; actor: string }) => {
    if (rec.fail.has(a.adGroupId)) return { ok: false, error: 'refused' }
    rec.writes.push({ id: a.adGroupId, bid: a.patch.defaultBidCents, actor: a.actor })
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  },
  updateAdTargetWithSync: async (a: { adTargetId: string; patch: { bidCents: number }; actor: string }) => {
    if (rec.fail.has(a.adTargetId)) return { ok: false, error: 'refused' }
    rec.writes.push({ id: a.adTargetId, bid: a.patch.bidCents, actor: a.actor })
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  },
  updateCampaignWithSync: async (a: unknown) => { rec.statusWrites.push(a); return { ok: true } },
}))

const { isRankOwnedFloor, floorOwnerWords, releaseScheduleMembers, readScheduleMembers, sweepOrphanReleases, rankSwitchBrake } = await import('./rank-release.service.js')
const { saveRankScheduleGroup, deleteRankScheduleGroup } = await import('./ads-create.service.js')
const { patchAdSchedule, deleteAdSchedule } = await import('./ads-schedule.service.js')
const { runRankDefendOnce, rankDefendSummaryLine } = await import('../../jobs/ad-rank-defend.job.js')
const { setEngineSwitch } = await import('../automation/engine-switch.service.js')
const { openEngineGuard } = await import('./ads-engine-guard.js')
const { ENGINE_CAPS_ENV } = await import('./ads-engine-actors.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any

const dial = (autonomy: 'AUTO' | 'SUGGEST' | 'OFF', halted = false) => inside(() => db().adsAutomationState.upsert({
  where: { id: 'singleton' },
  create: { id: 'singleton', autonomy, halted, haltReason: halted ? 'test halt' : null },
  update: { autonomy, halted, haltReason: halted ? 'test halt' : null },
}))

/** One campaign: an ad group (default bid) and keyword targets. `floorBy` seeds it floored at 2¢ by that owner. */
async function seed(id: string, groupBid: number, targetBids: number[], floorBy?: string | null, extra: Record<string, unknown> = {}) {
  const floored = floorBy !== undefined
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: floorBy } : {}), ...extra,
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: floored ? 2 : groupBid, ...(floored ? { suppressedFromBidCents: groupBid } : {}) } })
    for (const [i, bid] of targetBids.entries()) {
      await db().adTarget.create({
        data: { id: `${id}-t${i}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw ${i}`, bidCents: floored ? 2 : bid, ...(floored ? { suppressedFromBidCents: bid } : {}) },
      })
    }
  })
}
const bids = (campaignId: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id: campaignId }, select: { status: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
  const g = await db().adGroup.findFirst({ where: { campaignId }, select: { defaultBidCents: true, suppressedFromBidCents: true, baseBidFromCents: true } })
  const t = await db().adTarget.findMany({ where: { adGroup: { campaignId } }, orderBy: { id: 'asc' }, select: { bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true } })
  return { status: c.status, floored: c.bidsSuppressedAt != null, floorBy: c.bidsSuppressedBy, group: g, targets: t }
})
const scheduleOf = (campaignId: string) => inside(() => db().adSchedule.findFirst({ where: { campaignId }, select: { id: true } })).then((s: { id: string }) => s.id)
/** Every enabled schedule but these is switched off and every other floor lifted, so a tick's sweep sees only this arm. */
const isolate = (...campaignIds: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { enabled: false } })
  await db().campaign.updateMany({ where: { id: { notIn: campaignIds } }, data: { bidsSuppressedAt: null, bidsSuppressedBy: null } })
  await db().adGroup.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { suppressedFromBidCents: null, baseBidFromCents: null } })
  await db().adTarget.updateMany({ where: { adGroup: { campaignId: { notIn: campaignIds } } }, data: { suppressedFromBidCents: null, baseBidFromCents: null } })
})

let app: FastifyInstance
const savedCaps = process.env[ENGINE_CAPS_ENV]
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'pause', name: 'Min bid', pause: true } })
    await db().rankTarget.create({ data: { key: 'hold', name: 'Hold, no placement', biasPct: 0 } })
  })
  app = Fastify()
  app.addHook('preHandler', (_r, _p, done) => { withWorkspace(business, done) })
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => {
  if (savedCaps === undefined) delete process.env[ENGINE_CAPS_ENV]; else process.env[ENGINE_CAPS_ENV] = savedCaps
  await app?.close(); await database?.close()
})
beforeEach(async () => {
  rec.writes = []; rec.statusWrites = []; rec.fail.clear()
  delete process.env[ENGINE_CAPS_ENV]
  await dial('AUTO')
  await inside(() => setEngineSwitch('rank-defend', 'AUTO', 'user:test'))
})

describe('whose floor it is (N1)', () => {
  it('rank-defend, rank plans and dayparting own theirs; a legacy floor with no owner is read as ours; nobody else is', () => {
    expect(isRankOwnedFloor('automation:rank-defend-cmsched1')).toBe(true)
    expect(isRankOwnedFloor('automation:rank-plan-cmplan1')).toBe(true)
    expect(isRankOwnedFloor('automation:dayparting-cmsched2')).toBe(true)
    expect(isRankOwnedFloor(null)).toBe(true)
    expect(isRankOwnedFloor('user:awais')).toBe(false)
    expect(isRankOwnedFloor('automation:retail-guard')).toBe(false)
    expect(isRankOwnedFloor('automation:budget-manager-cron')).toBe(false)
    expect(isRankOwnedFloor('automation:cmrule123')).toBe(false)
    expect(isRankOwnedFloor('user:automation:rank-defend-x')).toBe(false)
  })
  it('names the owner in words', () => {
    expect(floorOwnerWords('user:awais')).toBe('a person')
    expect(floorOwnerWords('automation:retail-guard')).toBe('the out-of-stock check')
    expect(floorOwnerWords('automation:budget-manager-cron')).toBe('Budget enforcement')
    expect(floorOwnerWords('automation:cmrule123')).toBe('a rule or another automation')
  })
})

describe('a person stops a schedule holding a campaign (3.2)', () => {
  it('delete during Min-bid hours: the tick floors, the delete gives every remembered bid back at once, as the schedule', async () => {
    await seed('rr-del', 40, [35, 60])
    const { id: groupId } = await inside(() => saveRankScheduleGroup({ name: 'RR delete', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-del'] }))
    const sid = await scheduleOf('rr-del')
    await isolate('rr-del')
    await inside(() => runRankDefendOnce())
    expect(await bids('rr-del')).toMatchObject({ floored: true, floorBy: `automation:rank-defend-${sid}`, group: { defaultBidCents: 2 } })
    rec.writes = []

    const out = await inside(() => deleteRankScheduleGroup(groupId))
    expect(out.release).toMatchObject({ restored: 1, writes: 3, deferred: 0, keptByOthers: 0, failed: 0 })
    expect(await bids('rr-del')).toMatchObject({
      status: 'ENABLED', floored: false, floorBy: null, group: { defaultBidCents: 40, suppressedFromBidCents: null },
      targets: [{ bidCents: 35, suppressedFromBidCents: null }, { bidCents: 60, suppressedFromBidCents: null }],
    })
    expect(new Set(rec.writes.map((w) => w.actor))).toEqual(new Set([`automation:rank-defend-${sid}`]))
    expect(rec.statusWrites).toEqual([])
  })

  it('pause (the list\'s Pause): the route answers what it gave back; a campaign someone else floored is kept', async () => {
    await seed('rr-pause', 50, [30], 'automation:rank-defend-old')
    await seed('rr-person', 50, [30], 'user:awais')
    const { id: groupId } = await inside(() => saveRankScheduleGroup({ name: 'RR pause', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-pause', 'rr-person'] }))

    const preview = await app.inject({ method: 'GET', url: `/api/advertising/rank-schedule-groups/${groupId}/release-preview` })
    expect(preview.json()).toMatchObject({ campaigns: 2, restore: 1, bids: 2, keptByOthers: 1, nothing: 0, waitWhy: null })
    expect(preview.json().items.find((i: { campaignId: string }) => i.campaignId === 'rr-person')).toMatchObject({ outcome: 'kept-by-others', floorBy: 'a person' })

    const res = await app.inject({ method: 'PATCH', url: `/api/advertising/rank-schedule-groups/${groupId}`, payload: { enabled: false } })
    expect(res.json()).toMatchObject({ id: groupId, enabled: false, release: { restored: 1, keptByOthers: 1, writes: 2 } })
    expect(await bids('rr-pause')).toMatchObject({ floored: false, group: { defaultBidCents: 50 }, targets: [{ bidCents: 30 }] })
    expect(await bids('rr-person')).toMatchObject({ floored: true, floorBy: 'user:awais', group: { defaultBidCents: 2, suppressedFromBidCents: 50 }, targets: [{ bidCents: 2 }] })
  })

  it('a campaign removed on save gets its bids back; the members that stay keep their floor', async () => {
    await seed('rr-keep', 40, [20])
    await seed('rr-drop', 40, [20])
    const { id } = await inside(() => saveRankScheduleGroup({ name: 'RR members', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-keep', 'rr-drop'] }))
    await isolate('rr-keep', 'rr-drop')
    await inside(() => runRankDefendOnce())
    expect((await bids('rr-drop')).floored && (await bids('rr-keep')).floored).toBe(true)

    const out = await inside(() => saveRankScheduleGroup({ id, name: 'RR members', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-keep'] }))
    expect(out.release).toMatchObject({ restored: 1, writes: 2 })
    expect(await bids('rr-drop')).toMatchObject({ floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 20 }] })
    expect(await bids('rr-keep')).toMatchObject({ floored: true, group: { defaultBidCents: 2 } })
  })

  it('a base-bid delta under the floor: the floor comes back first, then the delta is reverted to its baseline', async () => {
    // Base 40/30, +50% delta applied (60/45, remembered as the baseline), then floored at 2¢ remembering 60/45.
    await seed('rr-delta', 60, [45], 'automation:rank-defend-old')
    await inside(async () => {
      await db().adGroup.update({ where: { id: 'rr-delta-g' }, data: { baseBidFromCents: 40 } })
      await db().adTarget.update({ where: { id: 'rr-delta-t0' }, data: { baseBidFromCents: 30 } })
    })
    const out = await inside(() => releaseScheduleMembers([{ scheduleId: 'old', campaignId: 'rr-delta', windows: [], defaultTargetKey: 'pause' }], 'test'))
    expect(out).toMatchObject({ restored: 1, writes: 4 })
    expect(await bids('rr-delta')).toMatchObject({ floored: false, group: { defaultBidCents: 40, suppressedFromBidCents: null, baseBidFromCents: null }, targets: [{ bidCents: 30, baseBidFromCents: null }] })
  })

  it('a bid the write path does not take: the campaign is "failed", its memory and floor kept for the next run', async () => {
    await seed('rr-fail', 40, [20, 25], 'automation:rank-defend-old')
    rec.fail.add('rr-fail-t1')
    const out = await inside(() => releaseScheduleMembers([{ scheduleId: 'old', campaignId: 'rr-fail', windows: [], defaultTargetKey: 'pause' }], 'test'))
    expect(out).toMatchObject({ restored: 0, failed: 1, writes: 2 })
    expect(await bids('rr-fail')).toMatchObject({ floored: true, targets: [{ bidCents: 20, suppressedFromBidCents: null }, { bidCents: 2, suppressedFromBidCents: 25 }] })
    await inside(() => db().campaign.update({ where: { id: 'rr-fail' }, data: { bidsSuppressedAt: null } })) // out of later arms' way
  })

  it('counted against the caps, never refused by one', async () => {
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ 'rank-defend': { perTick: 1 } })
    await seed('rr-cap-a', 40, [20], 'automation:rank-defend-x')
    await seed('rr-cap-b', 40, [20], 'automation:rank-defend-y')
    const out = await inside(() => releaseScheduleMembers([
      { scheduleId: 'x', campaignId: 'rr-cap-a', windows: [], defaultTargetKey: 'pause' },
      { scheduleId: 'y', campaignId: 'rr-cap-b', windows: [], defaultTargetKey: 'pause' },
    ], 'test'))
    expect(out).toMatchObject({ restored: 2, writes: 4, deferred: 0 })
  })
})

describe('while ads automation is stopped, nothing is attempted; the first run after Resume gives it back (Owner S1)', () => {
  it('halted: the delete defers, Nexus\'s copy does not move; after Resume the tick\'s orphan sweep restores', async () => {
    await seed('rr-halt', 40, [35, 60], 'automation:rank-defend-gone')
    const { id: groupId } = await inside(() => saveRankScheduleGroup({ name: 'RR halt', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-halt'] }))
    await dial('AUTO', true)

    const preview = await app.inject({ method: 'GET', url: `/api/advertising/rank-schedule-groups/${groupId}/release-preview` })
    expect(preview.json()).toMatchObject({ restore: 1, waitWhy: 'ads automation is stopped (halted: test halt)' })

    const out = await inside(() => deleteRankScheduleGroup(groupId))
    expect(out.release).toMatchObject({ restored: 0, deferred: 1, writes: 0, deferredWhy: 'ads automation is stopped (halted: test halt)' })
    expect(rec.writes).toEqual([])
    expect(await bids('rr-halt')).toMatchObject({
      floored: true, group: { defaultBidCents: 2, suppressedFromBidCents: 40 },
      targets: [{ bidCents: 2, suppressedFromBidCents: 35 }, { bidCents: 2, suppressedFromBidCents: 60 }],
    })

    // Still halted: the tick's sweep waits too.
    await isolate('rr-halt')
    const waiting = await inside(() => runRankDefendOnce())
    expect(waiting.release).toMatchObject({ deferred: 1, restored: 0, swept: 1 })
    expect(rankDefendSummaryLine(waiting)).toContain('release-waiting=1 (ads automation is stopped (halted: test halt))')
    expect((await bids('rr-halt')).floored).toBe(true)

    await dial('AUTO', false)
    const resumed = await inside(() => runRankDefendOnce())
    expect(resumed.release).toMatchObject({ restored: 1, writes: 3, swept: 1 })
    expect(rankDefendSummaryLine(resumed)).toBe('evaluated=0 applied=0 released=1 (3 bids back) swept=1')
    expect(await bids('rr-halt')).toMatchObject({ floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 35 }, { bidCents: 60 }] })
    // The floor named its schedule, so the give-back carries it.
    expect(new Set(rec.writes.map((w) => w.actor))).toEqual(new Set(['automation:rank-defend-gone']))
  })

  it('Rank & Dayparting switched off (Owner S7): the pause defers; the switch text counts the floors; back on, the sweep restores', async () => {
    await seed('rr-off', 40, [20], 'automation:rank-defend-off')
    const { id: groupId } = await inside(() => saveRankScheduleGroup({ name: 'RR off', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-off'] }))
    await isolate('rr-off')
    await inside(() => setEngineSwitch('rank-defend', 'OFF', 'user:test'))
    expect(await inside(() => rankSwitchBrake('base'))).toBe('base; 1 campaign holds a bid floor it set right now: switched off, it stays floored until it is switched back on, and its first run then gives back every floor no schedule holds')

    const res = await app.inject({ method: 'PATCH', url: `/api/advertising/rank-schedule-groups/${groupId}`, payload: { enabled: false } })
    expect(res.json().release).toMatchObject({ deferred: 1, restored: 0, deferredWhy: 'Rank & Dayparting is switched off for this business' })
    expect((await bids('rr-off')).floored).toBe(true)

    await inside(() => setEngineSwitch('rank-defend', 'AUTO', 'user:test'))
    const r = await inside(() => runRankDefendOnce())
    expect(r.release).toMatchObject({ restored: 1, swept: 1 })
    expect(await bids('rr-off')).toMatchObject({ floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 20 }] })
  })

  it('SUGGEST: an engine undoing its own state is allowed (Owner S2)', async () => {
    await seed('rr-sug', 40, [20], 'automation:rank-defend-sug')
    await dial('SUGGEST')
    const out = await inside(() => releaseScheduleMembers([{ scheduleId: 'sug', campaignId: 'rr-sug', windows: [], defaultTargetKey: 'pause' }], 'test'))
    expect(out).toMatchObject({ restored: 1, writes: 2 })
  })
})

describe('the rank-defend tick (in-tick release, N1, the sweep)', () => {
  it('a schedule that holds nothing at this hour, or names a deleted target, gives back what it floored', async () => {
    await seed('rr-idle', 40, [20], null) // a legacy floor: no owner recorded
    await seed('rr-dangling', 40, [20], 'automation:rank-defend-dangling')
    // A window that never opens (it ends where it starts) and no baseline: goal-mode, but nothing is due.
    await inside(() => saveRankScheduleGroup({ name: 'RR idle', windows: [{ days: [0], startHour: 5, endHour: 5, targetKey: 'hold' }], defaultTargetKey: null, campaignIds: ['rr-idle'] }))
    await inside(() => saveRankScheduleGroup({ name: 'RR dangling', windows: [], defaultTargetKey: 'deleted-target', campaignIds: ['rr-dangling'] }))
    const idleSid = await scheduleOf('rr-idle')
    await isolate('rr-idle', 'rr-dangling')

    const r = await inside(() => runRankDefendOnce())
    expect(r.release).toMatchObject({ restored: 2, writes: 4, swept: 0 })
    expect(await bids('rr-idle')).toMatchObject({ floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 20 }] })
    expect(await bids('rr-dangling')).toMatchObject({ floored: false, group: { defaultBidCents: 40 } })
    expect(rec.writes.filter((w) => w.id.startsWith('rr-idle')).every((w) => w.actor === `automation:rank-defend-${idleSid}`)).toBe(true)
  })

  it('a serving schedule leaves a floor it did not set alone (N1), and still restores its own', async () => {
    await seed('rr-oos', 40, [20], 'automation:retail-guard')
    await seed('rr-own', 40, [20], 'automation:rank-defend-own')
    await inside(() => saveRankScheduleGroup({ name: 'RR serve', windows: [], defaultTargetKey: 'hold', campaignIds: ['rr-oos', 'rr-own'] }))
    await isolate('rr-oos', 'rr-own')

    const r = await inside(() => runRankDefendOnce())
    const oos = r.decisions.find((d) => d.campaignId === 'rr-oos')!
    expect(oos).toMatchObject({ action: 'hold', applied: false })
    expect(oos.reason).toBe('bids held at a floor set by the out-of-stock check — rank leaves this campaign alone until that floor is lifted')
    expect(await bids('rr-oos')).toMatchObject({ floored: true, floorBy: 'automation:retail-guard', group: { defaultBidCents: 2, suppressedFromBidCents: 40 } })
    expect(await bids('rr-own')).toMatchObject({ floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 20 }] })
  })

  it('a Min-bid window does not re-floor a floor someone else set (a different floor would move their bids)', async () => {
    await seed('rr-person-min', 40, [20], 'user:awais')
    await inside(() => db().campaign.update({ where: { id: 'rr-person-min' }, data: { bidsSuppressedFloorCents: 2 } }))
    await inside(() => saveRankScheduleGroup({ name: 'RR person min', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-person-min'], targetOverrides: { 'rr-person-min': { pause: { floorBidCents: 10 } } } }))
    await isolate('rr-person-min')
    await inside(() => runRankDefendOnce())
    expect(rec.writes.filter((w) => w.id.startsWith('rr-person-min'))).toEqual([])
    expect(await bids('rr-person-min')).toMatchObject({ floored: true, floorBy: 'user:awais', group: { defaultBidCents: 2 } })
  })

  it('the sweep leaves campaigns an enabled schedule holds and floors set by others, and takes at most `limit`', async () => {
    await seed('rr-sw-held', 40, [20], 'automation:rank-defend-held')
    await seed('rr-sw-other', 40, [20], 'user:awais')
    await seed('rr-sw-1', 40, [20], 'automation:dayparting-gone')
    await seed('rr-sw-2', 40, [20], 'automation:rank-plan-gone')
    await inside(() => saveRankScheduleGroup({ name: 'RR held', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-sw-held'] }))
    await isolate('rr-sw-held', 'rr-sw-other', 'rr-sw-1', 'rr-sw-2')
    const guard = await inside(() => openEngineGuard('rank-defend'))
    const first = await inside(() => sweepOrphanReleases({ guard, governed: new Set(), limit: 1 }))
    expect(first).toMatchObject({ orphans: 1, restored: 1 })
    const second = await inside(() => sweepOrphanReleases({ guard, governed: new Set(), limit: 5 }))
    expect(second).toMatchObject({ orphans: 1, restored: 1 })
    expect((await bids('rr-sw-1')).floored || (await bids('rr-sw-2')).floored).toBe(false)
    expect((await bids('rr-sw-held')).floored).toBe(true)
    expect((await bids('rr-sw-other')).floored).toBe(true)
    // The dayparting floor is given back as the release actor (it counts against rank-defend's caps); the plan's as its plan.
    expect(new Set(rec.writes.map((w) => w.actor))).toEqual(new Set(['automation:rank-defend-release', 'automation:rank-plan-gone']))
    // A campaign a product plan holds is left alone too.
    await seed('rr-sw-plan', 40, [20], 'automation:rank-plan-live')
    const third = await inside(() => sweepOrphanReleases({ guard, governed: new Set(['rr-sw-plan']) }))
    expect(third.orphans).toBe(0)
  })
})

describe('the legacy schedule routes no longer write a campaign status (3.3)', () => {
  it('switched off while its window is closed: bids come back as dayparting, a campaign a person paused stays paused', async () => {
    await seed('rr-legacy', 40, [20], undefined, { status: 'PAUSED' })
    const s = await inside(() => db().adSchedule.create({ data: { campaignId: 'rr-legacy', name: 'legacy night', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: true, lastApplied: 'PAUSED' } }))
    await inside(() => db().campaign.update({ where: { id: 'rr-legacy' }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: `automation:dayparting-${s.id}` } }))
    await inside(async () => {
      await db().adGroup.update({ where: { id: 'rr-legacy-g' }, data: { defaultBidCents: 2, suppressedFromBidCents: 40 } })
      await db().adTarget.update({ where: { id: 'rr-legacy-t0' }, data: { bidCents: 2, suppressedFromBidCents: 20 } })
    })
    const out = await inside(() => patchAdSchedule(s.id, { enabled: false }))
    expect(out.ok).toBe(true)
    expect(rec.statusWrites).toEqual([])
    expect(await bids('rr-legacy')).toMatchObject({ status: 'PAUSED', floored: false, group: { defaultBidCents: 40 }, targets: [{ bidCents: 20 }] })
    expect(new Set(rec.writes.map((w) => w.actor))).toEqual(new Set([`automation:dayparting-${s.id}`]))

    const del = await app.inject({ method: 'DELETE', url: `/api/advertising/schedules/${s.id}` })
    expect(del.json()).toMatchObject({ ok: true, release: { restored: 0, deferred: 0 } })
    expect(rec.statusWrites).toEqual([])
    expect((await bids('rr-legacy')).status).toBe('PAUSED')
    expect((await app.inject({ method: 'DELETE', url: `/api/advertising/schedules/${s.id}` })).statusCode).toBe(404)
  })

  it('reads the members it releases before they are deleted', async () => {
    await seed('rr-read', 40, [20])
    const { id } = await inside(() => saveRankScheduleGroup({ name: 'RR read', windows: [], defaultTargetKey: 'pause', campaignIds: ['rr-read'] }))
    expect(await inside(() => readScheduleMembers({ groupId: id }))).toMatchObject([{ campaignId: 'rr-read', defaultTargetKey: 'pause' }])
    expect(await inside(() => deleteAdSchedule('nope'))).toEqual({ ok: false, status: 404, body: { error: 'not found' } })
  })
})
