/**
 * CM-30 — a campaign's minimum and maximum daily budget live in ONE store.
 *
 * The Campaigns grid's Min/Max Budget cell writes `Campaign.minBudgetCents` / `maxBudgetCents` (the write gate enforces
 * them). The Budget Manager's "Campaign Budget Limits" drawer wrote a per-month copy into `AdBudgetPlan.campaignLimits`
 * that the grid never showed, and Auto Pacing read only that copy. Now the drawer, the grid and the pacer all use the
 * columns; a limit still held only in a month's plan is shown as `oldMonthLimit` (not in use) until he keeps or drops it.
 *
 * PGlite with the production schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const MONTH = '2026-01' // a past month: the pacer treats it as on its last day

beforeAll(async () => { database = await formulaDatabase() }, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(async () => {
  await inside(async () => {
    await db().advertisingActionLog.deleteMany({})
    await db().amazonAdsDailyPerformance.deleteMany({})
    await db().adBudgetPlan.deleteMany({})
    await db().campaign.deleteMany({})
    await db().campaign.create({
      data: { id: 'bl-1', name: 'Limits A', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', status: 'ENABLED', dailyBudget: '10', startDate: new Date('2026-01-01T00:00:00Z') } as never,
    })
  })
})

const columns = () => inside(async () => db().campaign.findUnique({ where: { id: 'bl-1' }, select: { minBudgetCents: true, maxBudgetCents: true } }))

describe('CM-30 — the Budget Manager writes and reads the campaign\'s own Min/Max Budget', () => {
  it('a limit set in the Budget Manager lands in the columns the grid shows (not in the month\'s plan), audited', async () => {
    const { setCampaignLimit, listBudgetManagerCampaigns } = await import('./ads-budget-manager.service.js')
    const r = await inside(() => setCampaignLimit({ marketplace: 'IT', month: MONTH, campaignId: 'bl-1', minCents: 300, maxCents: 2_000, createdBy: 'user:owner' }))
    expect(r).toEqual({ ok: true, campaignId: 'bl-1', minCents: 300, maxCents: 2_000 })
    expect(await columns()).toEqual({ minBudgetCents: 300, maxBudgetCents: 2_000 })
    expect(await inside(() => db().adBudgetPlan.count())).toBe(0) // no plan is created to hold it
    const log = await inside(() => db().advertisingActionLog.findFirst({ where: { entityId: 'bl-1', actionType: 'set_campaign_budget_bounds' } }))
    expect(log).toMatchObject({ userId: 'user:owner', payloadAfter: { minBudgetCents: 300, maxBudgetCents: 2_000 } })

    const list = await inside(() => listBudgetManagerCampaigns({ marketplace: 'IT', month: MONTH }))
    expect(list.campaigns).toEqual([expect.objectContaining({ id: 'bl-1', minCents: 300, maxCents: 2_000, oldMonthLimit: null })])
  })

  it('a limit set in the grid (the columns) is what the Budget Manager shows', async () => {
    await inside(async () => {
      await db().campaign.update({ where: { id: 'bl-1' }, data: { minBudgetCents: 150, maxBudgetCents: null } })
      await db().adBudgetPlan.create({ data: { marketplace: 'IT', month: MONTH, monthlyBudgetCents: 10_000 } })
    })
    const { listBudgetManagerCampaigns, analyzeBudgetManager } = await import('./ads-budget-manager.service.js')
    const list = await inside(() => listBudgetManagerCampaigns({ marketplace: 'IT', month: MONTH }))
    expect(list.campaigns[0]).toMatchObject({ minCents: 150, maxCents: null, oldMonthLimit: null })
    // The market row's "N limits" badge counts campaigns with their own Min/Max Budget.
    const summary = await inside(() => analyzeBudgetManager({ month: MONTH }))
    expect(summary.rows.find((x) => x.marketplace === 'IT')?.campaignLimitCount).toBe(1)
  })

  it('refuses what the gate could never honour, with the reason (as the grid does)', async () => {
    const { setCampaignLimit } = await import('./ads-budget-manager.service.js')
    expect(await inside(() => setCampaignLimit({ marketplace: 'IT', month: MONTH, campaignId: 'bl-1', minCents: 50, maxCents: null })))
      .toMatchObject({ ok: false, status: 400, error: expect.stringContaining('at least €1.00') })
    expect(await inside(() => setCampaignLimit({ marketplace: 'IT', month: MONTH, campaignId: 'bl-1', minCents: 900, maxCents: 500 })))
      .toMatchObject({ ok: false, status: 400, error: expect.stringContaining('above the maximum') })
    expect(await inside(() => setCampaignLimit({ marketplace: 'DE', month: MONTH, campaignId: 'bl-1', minCents: 200, maxCents: null })))
      .toMatchObject({ ok: false, status: 404 })
    expect(await columns()).toEqual({ minBudgetCents: null, maxBudgetCents: null })
  })

  it('a limit only on the older month plan is shown as not in use, and saving it moves it to the campaign', async () => {
    await inside(() => db().adBudgetPlan.create({ data: { marketplace: 'IT', month: MONTH, campaignLimits: [{ campaignId: 'bl-1', minCents: 400, maxCents: 1_200 }] as never } }))
    const { listBudgetManagerCampaigns, setCampaignLimit } = await import('./ads-budget-manager.service.js')
    const before = await inside(() => listBudgetManagerCampaigns({ marketplace: 'IT', month: MONTH }))
    expect(before.campaigns[0]).toMatchObject({ minCents: null, maxCents: null, oldMonthLimit: { minCents: 400, maxCents: 1_200 } })

    await inside(() => setCampaignLimit({ marketplace: 'IT', month: MONTH, campaignId: 'bl-1', minCents: 400, maxCents: 1_200 }))
    const after = await inside(() => listBudgetManagerCampaigns({ marketplace: 'IT', month: MONTH }))
    expect(after.campaigns[0]).toMatchObject({ minCents: 400, maxCents: 1_200, oldMonthLimit: null })
    const plan = await inside(() => db().adBudgetPlan.findFirst({ where: { marketplace: 'IT', month: MONTH } }))
    expect(plan?.campaignLimits).toEqual([]) // the old copy is gone, so the two can never disagree again
  })
})

describe('CM-30 — Auto Pacing keeps to the campaign\'s own Min/Max Budget', () => {
  it('clamps to the column, not to the old per-month copy', async () => {
    await inside(async () => {
      await db().campaign.update({ where: { id: 'bl-1' }, data: { minBudgetCents: 500 } })
      // The old copy says 300: the pacer must not read it any more.
      await db().adBudgetPlan.create({ data: { marketplace: 'IT', month: MONTH, monthlyBudgetCents: 10_000, autoPacing: true, campaignLimits: [{ campaignId: 'bl-1', minCents: 300 }] as never } })
      // €99 spent of a €100 month: pacing is needed and today's target is about €1, under both minimums.
      await db().amazonAdsDailyPerformance.create({
        data: { profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${MONTH}-15T00:00:00Z`), entityType: 'CAMPAIGN', entityId: 'EXT-bl-1', localEntityId: 'bl-1', costMicros: 99_000_000n, currencyCode: 'EUR', reportedAt: new Date(), reportRunId: 'RUN-1' } as never,
      })
    })
    const { computeBudgetEnforcement } = await import('./ads-budget-enforce.service.js')
    const out = await inside(() => computeBudgetEnforcement({ month: MONTH }))
    const d = out.plans[0]!.campaigns.find((c) => c.id === 'bl-1')!
    expect(d).toMatchObject({ targetDailyCents: 500, clamp: 'min' })
  })
})
