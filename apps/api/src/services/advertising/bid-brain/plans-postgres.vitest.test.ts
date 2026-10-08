/**
 * BID BRAIN BB-7 — an owned campaign's hourly plan carried out by the brain, on a real PostgreSQL (the throwaway
 * PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, business profiles ON), the server switch
 * `live`, the ads mode LIVE (the real write gate) and Amazon a recorder (its current placements read, its PUT kept).
 *
 *   serving hour   the plan's placement % is written once, as the brain, inside the 120¢ ceiling; a rerun writes nothing;
 *                  rank-defend writes nothing for the campaign; the plan's receipt says what it holds
 *   Min-bid hour   every serving keyword floored to the plan's 3¢ as the brain, and ONE entry recorded for the anti-flap;
 *                  a rerun in the same hour writes nothing and records no second entry
 *   after it       the next serving hour gives the bids back in one write each (not 25 % at a time from 3¢)
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
vi.mock('../../../lib/queue.js', () => {
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
/** Amazon, as a recorder: the campaign's current placements, and every placement PUT. */
const amz = vi.hoisted(() => ({ placements: [] as Array<{ placement: string; percentage: number }>, puts: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ads-api-client.js')>()
  return {
    ...real,
    listCampaignsV3: async (_ctx: unknown, q: { campaignIds?: string[] }) => (q.campaignIds ?? []).map((id) => ({ campaignId: id, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: amz.placements } })),
    updateCampaign: async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
      amz.puts.push({ externalId, patch })
      amz.placements = (patch.placementBidding as typeof amz.placements | undefined) ?? amz.placements
      return { ok: true, mode: 'live', rawResponse: {} }
    },
  }
})

/** The stock judge (ads-stock-risk.service.ts), stood in for: which ad groups are out of stock. */
const stock = vi.hoisted(() => ({ out: new Set<string>() }))
vi.mock('../ads-stock-risk.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readStockAdGroups: async () => ({ adGroups: [...stock.out].map((id) => ({ id, risk: 'out-of-stock', products: [{ units: 0, daysOfCover: 0, lowBelowDays: 7, hasBuyBox: true }] })) }),
}))

const { runShadowOnce } = await import('./shadow.js')
const { setEnrollment } = await import('./enrollment.js')
const { BRAIN_ACTOR } = await import('./live.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { runRankDefendOnce } = await import('../../../jobs/ad-rank-defend.job.js')
const { restoreCampaignBids, suppressCampaignBids } = await import('../ads-bid-suppression.service.js')
const { applyRetailGuard } = await import('../ads-retail-readiness.service.js')
const { ADS_BID_BRAIN_ENROLLMENT_TOOLS } = await import('../../agents/tools/ads-bid-brain-enrollment.tools.js')
const { loadMarket } = await import('./load.js')

const W = `bb7_plans_${randomBytes(4).toString('hex')}`
const business = { workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const bidOf = async (id: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [id]))[0].b
const NOW = new Date()
const DAY = 86_400_000
// The plan's clock (Europe/Rome, CEST in October): 12:00 serves the all-out target, 03:00 is a Min-bid hour.
const today = NOW.toISOString().slice(0, 10)
const NOON = new Date(`${today}T10:00:00Z`)
const NIGHT = new Date(`${today}T01:00:00Z`)
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000)

describe.skipIf(!concurrentDatabaseUrl())('BB-7 — an owned campaign\'s hourly plan, carried out by the brain (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [W])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      const data = []
      for (const [target, d] of Object.entries({ 't-it': { clicks: 6, orders: 1 }, 't-low': { clicks: 2, orders: 0 } })) {
        for (let i = 1; i < 38; i++) {
          data.push({
            profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
            entityId: `EXT-${target}`, localEntityId: target, clicks: d.clicks, costMicros: BigInt(d.clicks * 300_000), currencyCode: 'EUR',
            orders7d: d.orders, sales7dCents: d.orders * 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
          })
        }
      }
      await db.amazonAdsDailyPerformance.createMany({ data })
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
      await db.rankTarget.create({ data: { key: 'bb7-min', name: 'Min bid', pause: true, floorBidCents: 3 } })
      await db.rankTarget.create({ data: { key: 'bb7-allout', name: 'All-out', placement: 'PLACEMENT_TOP', biasPct: 150, maxCpcCents: 120, lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }] } })
      await db.adSchedule.create({ data: { campaignId: 'c-it', name: 'IT TEST PLAN', timezone: 'Europe/Rome', windows: [{ startHour: 0, endHour: 8, targetKey: 'bb7-min' }], defaultTargetKey: 'bb7-allout' } })
      await setAutonomy('AUTO', 'test')
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('a serving hour: the plan\'s placements written once, as the brain, inside the 120¢ ceiling; rank-defend leaves it', async () => {
    // A full run (the goal moves happen there); the ticks after it are the light between-slots ones.
    const r = await inside(() => runShadowOnce({ now: at(NOW, 1), mode: 'live', clockNow: NOON }))
    const it = r.markets.find((m) => m.market === 'IT')!
    expect(it.placements).toMatchObject({ written: 1, refused: 0 })
    expect(amz.puts).toHaveLength(1)
    const sent = Object.fromEntries((amz.puts[0].patch.placementBidding as typeof amz.placements).map((p) => [p.placement, p.percentage]))
    const maxBid = Math.max(...(await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" a JOIN "AdGroup" g ON g.id = a."adGroupId" WHERE g."campaignId" = \'c-it\' AND NOT a."isNegative"')).map((x) => x.b))
    expect(sent.PLACEMENT_TOP).toBe(Math.min(150, Math.floor((120 / maxBid - 1) * 100)))
    expect(sent.PLACEMENT_PRODUCT_PAGE).toBe(Math.min(50, Math.floor((120 / maxBid - 1) * 100)))
    expect(sent.PLACEMENT_TOP).toBeLessThan(150)
    expect(maxBid * (1 + sent.PLACEMENT_TOP / 100)).toBeLessThanOrEqual(120)
    const [log] = await rows<{ userId: string }>('SELECT "userId" FROM "AdvertisingActionLog" WHERE "entityId" = \'c-it\' AND "actionType" = \'update_placement_bidding\'')
    expect(log.userId).toBe(BRAIN_ACTOR)
    expect(await rows('SELECT "lastApplied" FROM "AdSchedule" WHERE "campaignId" = \'c-it\'')).toEqual([{ lastApplied: 'bb7-allout' }])
    // The same hour again: nothing to change.
    await inside(() => runShadowOnce({ now: at(NOW, 2), mode: 'live', onlyOwned: true, clockNow: at(NOON, 15) }))
    expect(amz.puts).toHaveLength(1)
    // Rank-defend runs the plan's schedule for every campaign but this one (its dry run shows what it would take).
    const rank = await inside(() => runRankDefendOnce({ dryRun: true }))
    expect(rank.brainOwned).toBe(1)
    expect(rank.decisions.map((d) => (d as { campaignId?: string }).campaignId)).not.toContain('c-it')
    expect(await rows('SELECT 1 FROM "AdvertisingActionLog" WHERE "entityId" = \'c-it\' AND "userId" LIKE \'automation:rank-%\'')).toEqual([])
    expect(amz.puts).toHaveLength(1)
  })

  it('a Min-bid hour: every serving keyword floored to 3¢ as the brain, one anti-flap entry; a rerun does nothing more', async () => {
    const before = { 't-it': await bidOf('t-it'), 't-low': await bidOf('t-low') }
    expect(before['t-it']).toBeGreaterThan(3)
    await inside(() => runShadowOnce({ now: at(NOW, 3), mode: 'live', onlyOwned: true, clockNow: NIGHT }))
    expect(await bidOf('t-it')).toBe(3)
    expect(await bidOf('t-low')).toBe(3)
    const floors = await rows<{ userId: string; n: number }>('SELECT "userId", count(*)::int n FROM "AdvertisingActionLog" WHERE "entityId" IN (\'t-it\', \'t-low\') AND "createdAt" > now() - interval \'1 minute\' AND "payloadAfter" ->> \'bidCents\' = \'3\' GROUP BY "userId"')
    expect(floors).toEqual([{ userId: BRAIN_ACTOR, n: 2 }])
    // Review 2 — the floors' memory, where rank-defend's and the stops' give-back read it.
    const [schedule] = await rows<{ id: string }>('SELECT id FROM "AdSchedule" WHERE "campaignId" = \'c-it\'')
    expect(await rows('SELECT "bidsSuppressedBy", "bidsSuppressedFloorCents" FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ bidsSuppressedBy: `automation:rank-defend-${schedule.id}`, bidsSuppressedFloorCents: 3 }])
    expect(await rows('SELECT id, "suppressedFromBidCents" AS m FROM "AdTarget" WHERE id IN (\'t-it\', \'t-low\') ORDER BY id')).toEqual([{ id: 't-it', m: before['t-it'] }, { id: 't-low', m: before['t-low'] }])
    const entries = () => rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "entityId" = \'c-it\' AND "actionType" = \'custom_event\' AND ("payloadAfter" ->> \'rankMinBidEntry\')::boolean')
    expect(await entries()).toEqual([{ n: 1 }])
    const queued = (await rows<{ n: number }>('SELECT count(*)::int n FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W]))[0].n
    await inside(() => runShadowOnce({ now: at(NOW, 4), mode: 'live', onlyOwned: true, clockNow: at(NIGHT, 15) }))
    expect(await entries()).toEqual([{ n: 1 }])
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W]))[0].n).toBe(queued)
    // Placements are left as they are through a Min-bid hour.
    expect(amz.puts).toHaveLength(1)
    ;(globalThis as { __bb7Before?: typeof before }).__bb7Before = before
  })

  it('the serving hour after gives each bid back in one write, not 25 % at a time from the floor', async () => {
    const before = (globalThis as { __bb7Before?: Record<string, number> }).__bb7Before!
    await inside(() => runShadowOnce({ now: at(NOW, 5), mode: 'live', onlyOwned: true, clockNow: at(NOON, 60) }))
    const back = await bidOf('t-it')
    // Back to the bid before the floor, or one step from it toward the goal: never 3¢ × 1.25.
    expect(back).toBeGreaterThanOrEqual(Math.floor(before['t-it'] * 0.75))
    const [last] = await rows<{ layer: string; why: string }>('SELECT layer, why FROM "BidBrainDecision" WHERE "targetId" = \'t-it\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(last.layer).toBe('restore')
    expect(last.why).toMatch(/back to/)
    // The memory goes with the give-back, and the plan's floor mark with the last of it.
    expect(await rows('SELECT "suppressedFromBidCents" AS m FROM "AdTarget" WHERE id IN (\'t-it\', \'t-low\')')).toEqual([{ m: null }, { m: null }])
    expect(await rows('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ at: null }])
  })

  it('review 2 — handed back in a Min-bid hour (switch to shadow): the plan\'s own engine gives every bid back from the memory', async () => {
    const before = { 't-it': await bidOf('t-it'), 't-low': await bidOf('t-low') }
    await inside(() => runShadowOnce({ now: at(NOW, 6), mode: 'live', onlyOwned: true, clockNow: at(NIGHT, 30) }))
    expect(await bidOf('t-it')).toBe(3)
    const [schedule] = await rows<{ id: string }>('SELECT id FROM "AdSchedule" WHERE "campaignId" = \'c-it\'')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    try {
      // Rank-defend runs the campaign again (its dry run takes it) …
      const rank = await inside(() => runRankDefendOnce({ dryRun: true }))
      expect(rank.decisions.map((d) => (d as { campaignId?: string }).campaignId)).toContain('c-it')
      // … and its serving-hour give-back (restoreCampaignBids, as the plan's schedule) puts every bid back.
      await inside(() => restoreCampaignBids('c-it', { actor: `automation:rank-defend-${schedule.id}` as never, reason: 'test: serving hour' }))
      expect(await bidOf('t-it')).toBe(before['t-it'])
      expect(await bidOf('t-low')).toBe(before['t-low'])
      expect(await rows('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ at: null }])
    } finally {
      vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    }
  })

  it('review 2 — op shadow is refused while a floor the brain set has no memory, and points to give-back', async () => {
    const tool = ADS_BID_BRAIN_ENROLLMENT_TOOLS[0]
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 3, "suppressedFromBidCents" = NULL WHERE id = \'t-low\'')
    const refused = await inside(() => tool.handler({ campaignId: 'c-it', op: 'shadow' }, {} as never))
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/cannot go back to shadow now: 1 keyword sits at a floor the bid brain set that no engine would give back after it.*Use op give-back/) })
    // A memory no owner's mark points at is no better: still refused.
    await database.pool.query('UPDATE "AdTarget" SET "suppressedFromBidCents" = 5 WHERE id = \'t-low\'')
    expect(await inside(() => tool.handler({ campaignId: 'c-it', op: 'shadow' }, {} as never))).toMatchObject({ ok: false })
    // The memory and the plan's floor mark, as the brain's Min-bid floor leaves them: rank-defend gives it back — allowed.
    const [schedule] = await rows<{ id: string }>('SELECT id FROM "AdSchedule" WHERE "campaignId" = \'c-it\'')
    await database.pool.query('UPDATE "Campaign" SET "bidsSuppressedAt" = now(), "bidsSuppressedFloorCents" = 3, "bidsSuppressedBy" = $1 WHERE id = \'c-it\'', [`automation:rank-defend-${schedule.id}`])
    expect(await inside(() => tool.handler({ campaignId: 'c-it', op: 'shadow' }, {} as never))).toMatchObject({ ok: true })
    await database.pool.query('UPDATE "Campaign" SET "bidsSuppressedAt" = NULL, "bidsSuppressedFloorCents" = NULL, "bidsSuppressedBy" = NULL WHERE id = \'c-it\'')
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 5, "suppressedFromBidCents" = NULL WHERE id = \'t-low\'')
  })

  it('review B1 — out of stock, then back in stock: the brain\'s own stock floor gives the bid back (never a stop)', async () => {
    const before = await bidOf('t-it')
    stock.out.add('g-c-it')
    await inside(() => runShadowOnce({ now: at(NOW, 20), mode: 'live', onlyOwned: true, clockNow: at(NOON, 120) }))
    const floor = await bidOf('t-it')
    expect(floor).toBeLessThan(before)
    expect(await rows('SELECT "suppressedFromBidCents" AS m FROM "AdTarget" WHERE id = \'t-it\'')).toEqual([{ m: before }])
    stock.out.clear()
    await inside(() => runShadowOnce({ now: at(NOW, 21), mode: 'live', onlyOwned: true, clockNow: at(NOON, 135) }))
    expect(await bidOf('t-it')).toBe(before)
    const [last] = await rows<{ layer: string }>('SELECT layer FROM "BidBrainDecision" WHERE "targetId" = \'t-it\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(last.layer).toBe('restore')
  })

  it('review B1 — a give-back the gate refused (the worker put the floor back): the next tick gives it back again', async () => {
    const before = await bidOf('t-it')
    stock.out.add('g-c-it')
    await inside(() => runShadowOnce({ now: at(NOW, 22), mode: 'live', onlyOwned: true, clockNow: at(NOON, 150) }))
    const floor = await bidOf('t-it')
    stock.out.clear()
    await inside(() => runShadowOnce({ now: at(NOW, 23), mode: 'live', onlyOwned: true, clockNow: at(NOON, 165) }))
    expect(await bidOf('t-it')).toBe(before)
    // Refused at dispatch: the worker puts the floor back.
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = $1 WHERE id = \'t-it\'', [floor])
    // Pre-go-live 1 — a give-back still waiting at the floor: op shadow is refused (no engine would give it back).
    const waiting = await inside(() => ADS_BID_BRAIN_ENROLLMENT_TOOLS[0].handler({ campaignId: 'c-it', op: 'shadow' }, {} as never))
    expect(waiting).toMatchObject({ ok: false, error: expect.stringMatching(/cannot go back to shadow now: 1 keyword sits at a floor/) })
    await inside(() => runShadowOnce({ now: at(NOW, 24), mode: 'live', onlyOwned: true, clockNow: at(NOON, 180) }))
    expect(await bidOf('t-it')).toBe(before)
  })

  it('pre-go-live 3 — a monthly-cap stop declared during a Min-bid hour is still in force after the hour; a second owner\'s stop outlives the first', async () => {
    const BUDGET = 'automation:budget-manager-cron'
    const RETAIL = 'automation:retail-guard'
    const before = await bidOf('t-it')
    const night = new Date(NIGHT.getTime() + DAY)
    const noon = new Date(NOON.getTime() + DAY)
    await inside(() => runShadowOnce({ now: at(NOW, 25), mode: 'live', onlyOwned: true, clockNow: night }))
    expect(await bidOf('t-it')).toBe(3)
    // The cap is reached while the brain's Min-bid floor holds the mark: the stop lands (it takes the mark).
    expect(await inside(() => suppressCampaignBids('c-it', { actor: BUDGET as never, floorCents: 2, reason: 'monthly cap reached' }))).toBe(0)
    expect(await rows('SELECT "bidsSuppressedBy", "bidsSuppressedFloorCents" FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ bidsSuppressedBy: BUDGET, bidsSuppressedFloorCents: 2 }])
    await inside(() => runShadowOnce({ now: at(NOW, 26), mode: 'live', onlyOwned: true, clockNow: at(night, 15) }))
    expect(await bidOf('t-it')).toBe(2)
    // The Min-bid hour ends: the stop is still in force.
    await inside(() => runShadowOnce({ now: at(NOW, 27), mode: 'live', onlyOwned: true, clockNow: noon }))
    expect(await bidOf('t-it')).toBe(2)
    // A second owner's stop on top: kept as a STOP hold; the first owner's lift leaves it in force.
    await inside(() => suppressCampaignBids('c-it', { actor: RETAIL as never, floorCents: 2, reason: 'unsellable' }))
    expect(await rows('SELECT kind, by FROM "BidHold" WHERE "campaignId" = \'c-it\' AND "endedAt" IS NULL AND "targetId" IS NULL')).toEqual([{ kind: 'STOP', by: RETAIL }])
    await inside(() => restoreCampaignBids('c-it', { actor: BUDGET as never, reason: 'back under cap' }))
    await inside(() => runShadowOnce({ now: at(NOW, 28), mode: 'live', onlyOwned: true, clockNow: at(noon, 15) }))
    expect(await bidOf('t-it')).toBe(2)
    // The second owner lifts too: the bid comes back.
    await inside(() => restoreCampaignBids('c-it', { actor: RETAIL as never, reason: 'sellable again' }))
    await inside(() => runShadowOnce({ now: at(NOW, 29), mode: 'live', onlyOwned: true, clockNow: at(noon, 30) }))
    expect(await bidOf('t-it')).toBe(before)
  })

  it('review B2 — the plan switched off during its Min-bid floor: the next tick gives the bids back and clears its mark', async () => {
    const before = await bidOf('t-it')
    // Tomorrow's night (a new UTC day: the anti-flap count starts again).
    const tomorrowNight = new Date(NIGHT.getTime() + DAY)
    await inside(() => runShadowOnce({ now: at(NOW, 30), mode: 'live', onlyOwned: true, clockNow: tomorrowNight }))
    expect(await bidOf('t-it')).toBe(3)
    await database.pool.query('UPDATE "AdSchedule" SET enabled = false WHERE "campaignId" = \'c-it\'')
    await inside(() => runShadowOnce({ now: at(NOW, 31), mode: 'live', onlyOwned: true, clockNow: at(tomorrowNight, 15) }))
    expect(await bidOf('t-it')).toBe(before)
    expect(await rows('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ at: null }])
  })

  it('#513 review — the second owner\'s STOP hold takes the mark when the first lifts (its own 2¢ floor, not the strategy\'s 4¢); the retail guard lifts it once it no longer flags the campaign', async () => {
    const BUDGET = 'automation:budget-manager-cron'
    const RETAIL = 'automation:retail-guard'
    await database.pool.query('UPDATE "AdsStrategy" SET "stopMethod" = \'LOW_BIDS\', "stopBidCents" = 4 WHERE market = \'IT\' AND level = \'MARKET\'')
    try {
      const before = await bidOf('t-it')
      const noon = new Date(NOON.getTime() + 2 * DAY)
      await inside(() => suppressCampaignBids('c-it', { actor: BUDGET as never, floorCents: 5, reason: 'monthly cap reached' }))
      await inside(() => runShadowOnce({ now: at(NOW, 32), mode: 'live', onlyOwned: true, clockNow: noon }))
      expect(await bidOf('t-it')).toBe(5)
      // The guard's stop on top, at its own 2¢: a STOP hold, and the lower floor wins (not the strategy's 4¢ stop bid).
      await inside(() => suppressCampaignBids('c-it', { actor: RETAIL as never, floorCents: 2, reason: 'unsellable' }))
      await inside(() => runShadowOnce({ now: at(NOW, 33), mode: 'live', onlyOwned: true, clockNow: at(noon, 15) }))
      expect(await bidOf('t-it')).toBe(2)
      // The cap's owner lifts: the guard's stop takes the mark at its own floor; the hold ends; the saved bid stays.
      await inside(() => restoreCampaignBids('c-it', { actor: BUDGET as never, reason: 'back under cap' }))
      expect(await rows('SELECT "bidsSuppressedBy", "bidsSuppressedFloorCents" FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ bidsSuppressedBy: RETAIL, bidsSuppressedFloorCents: 2 }])
      expect(await rows('SELECT count(*)::int AS n FROM "BidHold" WHERE "campaignId" = \'c-it\' AND kind = \'STOP\' AND "endedAt" IS NULL')).toEqual([{ n: 0 }])
      expect(await rows('SELECT "suppressedFromBidCents" AS m FROM "AdTarget" WHERE id = \'t-it\'')).toEqual([{ m: before }])
      await inside(() => runShadowOnce({ now: at(NOW, 34), mode: 'live', onlyOwned: true, clockNow: at(noon, 30) }))
      expect(await bidOf('t-it')).toBe(2)
      // The guard no longer flags it: its run lifts its own stop, and the brain gives the bid back.
      expect(await inside(() => applyRetailGuard({ campaignIds: [], sellable: ['c-it'], actor: 'retail-guard' }))).toMatchObject({ lifted: ['c-it'] })
      expect(await rows('SELECT "bidsSuppressedAt" AS at FROM "Campaign" WHERE id = \'c-it\'')).toEqual([{ at: null }])
      await inside(() => runShadowOnce({ now: at(NOW, 35), mode: 'live', onlyOwned: true, clockNow: at(noon, 45) }))
      expect(await bidOf('t-it')).toBe(before)
    } finally {
      await database.pool.query('UPDATE "AdsStrategy" SET "stopMethod" = NULL, "stopBidCents" = NULL WHERE market = \'IT\' AND level = \'MARKET\'')
    }
  })

  it('review 7 — a between-slots tick reads the owned campaigns only, no evidence, and stores no goal-less rows', async () => {
    const light = await inside(() => loadMarket('IT', { now: NOW, campaignIds: new Set(['c-it']), light: true }))
    expect([...light.campaigns.keys()]).toEqual(['c-it'])
    expect(light.evidence.size).toBe(0)
    expect(light.light).toBe(true)
    expect(await rows('SELECT count(*)::int n FROM "BidBrainDecision" WHERE layer = \'no_goal\'')).toEqual([{ n: 0 }])
  })
})
