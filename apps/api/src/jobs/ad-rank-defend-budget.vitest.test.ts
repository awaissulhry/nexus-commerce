/**
 * Group 2 (2b, review N2) — rank-defend raises no placement into a campaign Amazon reports out of budget.
 *
 * The check (C2) matched `OUT_OF_BUDGET`; Amazon sends `CAMPAIGN_OUT_OF_BUDGET` (delivery-reasons.ts), so the raise it
 * was meant to hold always went through. Now a placement raise waits, with the reason in plain words and a warning
 * logged once per schedule per UTC day; a lowering and the Min-bid floor still land.
 *
 * PGlite with the production schema and the real rank-defend tick. The audited mutation service and the placement
 * write are recorders that apply to the database (no queue, no gate, no Amazon).
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
const { logger } = await import('../utils/logger.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

/** One campaign with Amazon's delivery reasons and a Top placement %, one ad group, one keyword; and its schedule. */
async function seed(id: string, deliveryReasons: string[], topPct: number, targetKey: string) {
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        deliveryStatus: deliveryReasons.length ? 'NOT_DELIVERING' : 'DELIVERING', deliveryReasons,
        dynamicBidding: { placementBidding: topPct ? [{ placement: 'PLACEMENT_TOP', percentage: topPct }] : [] },
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: 40 } })
    await db().adTarget.create({ data: { id: `${id}-t0`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: 35 } })
    await db().adSchedule.create({ data: { id: `${id}-s`, campaignId: id, name: `${id}-s`, enabled: true, defaultTargetKey: targetKey } })
  })
}
/** Only these campaigns' schedules run. */
const only = (...campaignIds: string[]) => inside(() => db().adSchedule.updateMany({ where: { campaignId: { notIn: campaignIds } }, data: { enabled: false } }))
const state = (id: string) => inside(async () => {
  const c = await db().campaign.findUnique({ where: { id }, select: { bidsSuppressedAt: true, dynamicBidding: true } })
  const t = await db().adTarget.findFirst({ where: { adGroup: { campaignId: id } }, select: { bidCents: true } })
  const top = (c.dynamicBidding?.placementBidding ?? []).find((x: { placement: string }) => x.placement === 'PLACEMENT_TOP')?.percentage ?? 0
  return { floored: c.bidsSuppressedAt != null, top, bid: t.bidCents }
})
const decisionOf = (r: Awaited<ReturnType<typeof runRankDefendOnce>>, id: string) => r.decisions.find((d) => d.campaignId === id)!
const OOB_LOG = '[rank-defend] campaign out of budget — placement raise waits (logged once a day per schedule)'

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'top50', name: 'Top +50%', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'pause50', name: 'Min bid, Top +50%', pause: true, biasPct: 50 } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { rec.bids = []; rec.placements = [] })

describe('rank-defend and a campaign Amazon reports out of budget', () => {
  it('a placement raise waits, in plain words; the same raise lands on a campaign that is not out of budget', async () => {
    await seed('oob-raise', ['CAMPAIGN_OUT_OF_BUDGET'], 0, 'top50')
    await seed('ok-raise', ['CAMPAIGN_PAUSED'], 0, 'top50')
    await only('oob-raise', 'ok-raise')
    const r = await inside(() => runRankDefendOnce())

    expect(await state('oob-raise')).toMatchObject({ top: 0 })
    expect(rec.placements.map((p) => p.campaignId)).toEqual(['ok-raise'])
    expect(await state('ok-raise')).toMatchObject({ top: 50 })
    expect(decisionOf(r, 'oob-raise')).toMatchObject({
      action: 'hold', nextPct: 0, applied: false,
      reason: 'Amazon says this campaign is out of budget — the Top 0→50% raise waits until the budget resets or is raised',
    })
    expect(decisionOf(r, 'ok-raise')).toMatchObject({ action: 'raise', nextPct: 50, applied: true })
  })

  it("a portfolio that ran out holds the raise too, and says so", async () => {
    await seed('oob-portfolio', ['PORTFOLIO_OUT_OF_BUDGET'], 0, 'top50')
    await only('oob-portfolio')
    const r = await inside(() => runRankDefendOnce())
    expect(await state('oob-portfolio')).toMatchObject({ top: 0 })
    expect(decisionOf(r, 'oob-portfolio').reason).toBe('Amazon says this campaign’s portfolio is out of budget — the Top 0→50% raise waits until the budget resets or is raised')
  })

  it('a lowering still lands', async () => {
    await seed('oob-lower', ['CAMPAIGN_OUT_OF_BUDGET'], 120, 'top50')
    await only('oob-lower')
    const r = await inside(() => runRankDefendOnce())
    expect(decisionOf(r, 'oob-lower')).toMatchObject({ action: 'lower', nextPct: 50, applied: true })
    expect(await state('oob-lower')).toMatchObject({ top: 50 })
  })

  it('Min bid: the floor still lands, its placement raise waits', async () => {
    await seed('oob-floor', ['CAMPAIGN_OUT_OF_BUDGET'], 0, 'pause50')
    await only('oob-floor')
    const r = await inside(() => runRankDefendOnce())
    expect(await state('oob-floor')).toEqual({ floored: true, top: 0, bid: 2 })
    expect(rec.placements).toEqual([])
    expect(decisionOf(r, 'oob-floor')).toMatchObject({
      action: 'pause', nextPct: 0, applied: true,
      reason: 'target = Min bid → bids at floor €0.02 (campaign live, restorable) · Amazon says this campaign is out of budget — the Top 0→50% raise waits until the budget resets or is raised',
    })
  })

  it('the warning is logged once per schedule per UTC day, not every tick; a dry run logs none', async () => {
    await seed('oob-log', ['CAMPAIGN_OUT_OF_BUDGET'], 0, 'top50')
    await only('oob-log')
    const warn = vi.spyOn(logger, 'warn')
    try {
      const ours = () => warn.mock.calls.filter(([msg, meta]) => msg === OOB_LOG && (meta as { campaignId?: string })?.campaignId === 'oob-log')
      await inside(() => runRankDefendOnce({ dryRun: true }))
      expect(ours()).toHaveLength(0)
      await inside(() => runRankDefendOnce())
      await inside(() => runRankDefendOnce())
      await inside(() => runRankDefendOnce())
      expect(ours()).toHaveLength(1)
      expect(ours()[0][1]).toMatchObject({ actor: 'automation:rank-defend-oob-log-s', deliveryReasons: ['CAMPAIGN_OUT_OF_BUDGET'], held: 'Top 0→50%' })
    } finally { warn.mockRestore() }
  })
})
