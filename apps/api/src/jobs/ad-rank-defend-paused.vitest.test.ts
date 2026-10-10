/**
 * C1 (2026-10-10) — the hourly bid plans write nothing to a campaign that is not ENABLED. A paused (or archived, or
 * draft) campaign is decided as a hold: no placement, no Min-bid floor, no give-back. It stays held by its schedule or
 * plan, so the orphan sweep leaves its floor alone too, and the first tick after it is enabled writes its hour.
 *
 * PGlite with the production schema and the real rank-defend tick. The audited mutation service and the placement
 * write are recorders that apply to the database (no queue, no gate, no Amazon); a plan's family is a stand-in.
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
vi.mock('../services/advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
const rec = vi.hoisted(() => ({ writes: [] as Array<{ campaign: string; what: 'bid' | 'placement'; value: unknown }>, family: new Map<string, string[]>() }))
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
// A plan's family: the campaigns this test names for its product (the real resolver reads ads and ASINs).
vi.mock('../services/advertising/ads-dayparting-refresh.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProductFamily: async (o: { parentProductId?: string }) => ({ campaigns: (rec.family.get(o.parentProductId ?? '') ?? []).map((id) => ({ id })) }),
}))
vi.mock('../services/advertising/ads-retail-readiness.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  analyzeRetailReadiness: async () => ({ campaigns: [] }),
}))

const { runRankDefendOnce, rankDefendSummaryLine } = await import('./ad-rank-defend.job.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** One campaign (an ad group at 40¢, one keyword at 35¢), optionally its schedule. `floored` = already floored by rank. */
async function seed(id: string, opts: { status?: string; targetKey?: string; floored?: boolean; schedule?: boolean } = {}) {
  const { status = 'ENABLED', targetKey = 'top50', floored = false, schedule = true } = opts
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, status,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        deliveryStatus: 'DELIVERING', deliveryReasons: [], dynamicBidding: { placementBidding: [] },
        ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: `automation:rank-defend-${id}-s` } : {}),
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: floored ? 2 : 40, ...(floored ? { suppressedFromBidCents: 40 } : {}) } })
    await db().adTarget.create({ data: { id: `${id}-t0`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: floored ? 2 : 35, ...(floored ? { suppressedFromBidCents: 35 } : {}) } })
    if (schedule) await db().adSchedule.create({ data: { id: `${id}-s`, campaignId: id, name: `${id}-s`, enabled: true, timezone: 'UTC', defaultTargetKey: targetKey, windows: [] } })
  })
}
/** Only these campaigns' schedules run, and no plan. */
const only = (...campaignIds: string[]) => inside(async () => {
  await db().adSchedule.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { campaignId: { in: campaignIds } }, data: { enabled: true } })
  await db().productRankPlan.updateMany({ data: { enabled: false } })
})
const setStatus = (id: string, status: string) => inside(() => db().campaign.update({ where: { id }, data: { status } }))
const campaign = (id: string) => inside(() => db().campaign.findUnique({ where: { id } }))
const bidOf = (id: string) => inside(async () => (await db().adTarget.findUnique({ where: { id: `${id}-t0` } })).bidCents as number)
const entriesOf = (id: string) => inside(() => db().advertisingActionLog.count({ where: { entityType: 'CAMPAIGN', entityId: id, actionType: 'custom_event' } }))
const tick = () => inside(() => runRankDefendOnce())
const ours = (...ids: string[]) => rec.writes.filter((w) => ids.includes(w.campaign))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'top50', name: 'Top +50%', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'minbid', name: 'Min bid', pause: true, floorBidCents: 2, biasPct: 0 } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { rec.writes = [] })

describe('C1 — a schedule on a campaign that is not enabled writes nothing', () => {
  it('a PAUSED campaign at a serving hour with a placement move due: no write, a hold that says paused, the receipt stamped', async () => {
    await seed('s-paused', { status: 'PAUSED' })
    await seed('s-live')
    await only('s-paused', 's-live')

    const r = await tick()
    expect(ours('s-paused')).toEqual([])
    expect(ours('s-live').map((w) => w.what)).toEqual(['placement']) // the enabled one as before
    const d = r.decisions.find((x) => x.campaignId === 's-paused')!
    expect(d).toMatchObject({ action: 'hold', applied: false, targetKey: 'top50' })
    expect(d.reason).toMatch(/paused/)
    expect(d.reason).toContain('its hour is written at the first tick after it is enabled again')
    const s = await inside(() => db().adSchedule.findUnique({ where: { id: 's-paused-s' } }))
    expect(s.lastApplied).toBe('top50')
    expect(s.lastEvaluatedAt).toBeInstanceOf(Date)
    expect(r.paused).toBe(1)
    expect(rankDefendSummaryLine(r)).toMatch(/^evaluated=2 applied=1 paused=1 \(not enabled: nothing written\)/)
  })

  it('a PAUSED campaign at a Min-bid hour: no floor and no Min-bid entry note', async () => {
    await seed('m-paused', { status: 'PAUSED', targetKey: 'minbid' })
    await only('m-paused')

    const r = await tick()
    expect(ours('m-paused')).toEqual([])
    expect((await campaign('m-paused')).bidsSuppressedAt).toBeNull()
    expect(await bidOf('m-paused')).toBe(35)
    expect(await entriesOf('m-paused')).toBe(0)
    expect(r.decisions.find((x) => x.campaignId === 'm-paused')).toMatchObject({ action: 'hold', applied: false })
  })

  it('a PAUSED campaign rank floored, at a serving hour: no give-back and the sweep leaves it; once ENABLED the next tick gives back and writes the hour', async () => {
    await seed('f-paused', { status: 'PAUSED', floored: true })
    await only('f-paused')

    await tick()
    expect(ours('f-paused')).toEqual([])
    expect((await campaign('f-paused')).bidsSuppressedAt).not.toBeNull()
    expect(await bidOf('f-paused')).toBe(2)

    await setStatus('f-paused', 'ENABLED')
    rec.writes = []
    const r = await tick()
    expect((await campaign('f-paused')).bidsSuppressedAt).toBeNull()
    expect(await bidOf('f-paused')).toBe(35)
    expect(ours('f-paused').map((w) => w.what)).toEqual(['bid', 'bid', 'placement'])
    expect(r.decisions.find((x) => x.campaignId === 'f-paused')!.applied).toBe(true)
    expect(r.paused).toBeUndefined()
  })

  it('a PAUSED campaign whose schedule holds nothing this hour: nothing given back either', async () => {
    await seed('i-paused', { status: 'PAUSED', floored: true, targetKey: 'gone' }) // a dangling target: nothing is held
    await only('i-paused')

    await tick()
    expect(ours('i-paused')).toEqual([])
    expect((await campaign('i-paused')).bidsSuppressedAt).not.toBeNull()
  })

  it('an ARCHIVED campaign is treated like a paused one', async () => {
    await seed('a-archived', { status: 'ARCHIVED', targetKey: 'minbid' })
    await only('a-archived')

    const r = await tick()
    expect(ours('a-archived')).toEqual([])
    const d = r.decisions.find((x) => x.campaignId === 'a-archived')!
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('campaign archived — nothing is written to it: an archived campaign never serves again')
    expect(d.reason).not.toMatch(/enabled again/)
    expect(rankDefendSummaryLine(r)).toMatch(/^evaluated=1 applied=0 paused=1 /)
  })
})

describe('C1 — a product plan writes only its enabled members', () => {
  it('1 ENABLED and 1 PAUSED (rank floored) member: only the enabled one is written, both in the plan summary; the sweep leaves the paused one', async () => {
    await seed('p-on', { schedule: false })
    await seed('p-off', { status: 'PAUSED', floored: true, schedule: false })
    rec.family.set('prod-gale', ['p-on', 'p-off'])
    await only()
    await inside(() => db().productRankPlan.create({ data: { id: 'plan-gale', productId: 'prod-gale', marketplace: 'IT', enabled: true, timezone: 'UTC', defaultTargetKey: 'top50', windows: [] } }))

    const r = await tick()
    expect(ours('p-off')).toEqual([])
    expect(ours('p-on').map((w) => w.what)).toEqual(['placement'])
    expect((await campaign('p-off')).bidsSuppressedAt).not.toBeNull() // neither restored nor swept
    const plan = await inside(() => db().productRankPlan.findUnique({ where: { id: 'plan-gale' } }))
    const decisions = (plan.lastSummary as { decisions: Array<{ campaignId: string; action: string; reason: string }> }).decisions
    expect(decisions.map((d) => d.campaignId).sort()).toEqual(['p-off', 'p-on'])
    expect(decisions.find((d) => d.campaignId === 'p-off')).toMatchObject({ action: 'hold' })
    expect(decisions.find((d) => d.campaignId === 'p-off')!.reason).toMatch(/paused/)
    expect(r.plans?.[0]).toMatchObject({ planId: 'plan-gale', campaigns: 2 })
    expect(rankDefendSummaryLine(r)).toMatch(/^evaluated=2 applied=1 paused=1 /)
  })
})
