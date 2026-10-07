/**
 * BID BRAIN BB-3 — the shadow run on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business
 * profiles ON). The loaders' raw SQL — the decayed evidence aggregate over AmazonAdsDailyPerformance, the newest
 * report, DISTINCT ON last writers and last decisions — runs as production runs it.
 *
 *   scope      only Sponsored Products keywords of allowlisted IT/DE campaigns are decided (not UK, not a campaign
 *              off the allowlist, not Sponsored Brands); a pinned campaign is held by its pin; a floored keyword by its stop
 *   no write   no AdMutation, no OutboundSyncQueue, no AdvertisingActionLog row, every bid unchanged
 *   stored     the first run stores every decision with its why; a rerun on the same facts stores nothing; the next
 *              day stores one snapshot each; rows older than 30 days are pruned
 *   brakes     a halt, and report data older than 48 hours, brake every decision
 *   business   another business's run sees none of these rows
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

const { runShadowOnce } = await import('./shadow.js')

const W = `bb3_shadow_${randomBytes(4).toString('hex')}`
const OTHER = `bb3_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const NOW = new Date('2026-10-07T12:50:00Z')
const DAY = 86_400_000

/** 30 settled days of keyword data and the 7 newest (still settling) days, all reported an hour before NOW. */
async function seedEvidence() {
  const perDay: Record<string, { clicks: number; orders: number }> = { 't-it': { clicks: 6, orders: 1 }, 't-low': { clicks: 2, orders: 0 }, 't-off': { clicks: 4, orders: 0 }, 't-pin': { clicks: 3, orders: 0 } }
  const data = []
  for (const [target, d] of Object.entries(perDay)) {
    for (let i = 1; i < 38; i++) {
      data.push({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
        entityId: `EXT-${target}`, localEntityId: target, clicks: d.clicks, costMicros: BigInt(d.clicks * 300_000), currencyCode: 'EUR',
        orders7d: d.orders, sales7dCents: d.orders * 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
      })
    }
  }
  await database.client.amazonAdsDailyPerformance.createMany({ data })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-3 — the shadow bid brain (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    for (const id of [W, OTHER]) {
      await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [id])
    }
    await inside(async () => {
      await seedAdsFixture(database.client)
      await seedEvidence()
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('decides the allowlisted IT keywords only, stores each with its why, and writes nothing anywhere else', async () => {
    const before = await rows<{ m: number; q: number; l: number }>('SELECT (SELECT count(*)::int FROM "AdMutation") m, (SELECT count(*)::int FROM "OutboundSyncQueue") q, (SELECT count(*)::int FROM "AdvertisingActionLog") l')
    const r = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const it = r.markets.find((m) => m.market === 'IT')!
    expect(it).toMatchObject({ decided: 4, stored: 4, brakes: [] })
    expect(r.markets.find((m) => m.market === 'DE')).toMatchObject({ decided: 0, stored: 0 })
    const decided = await rows<{ targetId: string; layer: string; action: string; kind: string; mode: string; why: string; currentCents: number; decidedCents: number }>(
      'SELECT "targetId", layer, action, kind, mode, why, "currentCents", "decidedCents" FROM "BidBrainDecision" WHERE "workspaceId" = $1 ORDER BY "targetId"', [W])
    expect(decided.map((d) => d.targetId)).toEqual(['t-it', 't-low', 't-pin', 't-sup'])
    expect(decided.every((d) => d.kind === 'change' && d.mode === 'SHADOW' && d.why.length > 10)).toBe(true)
    const byId = Object.fromEntries(decided.map((d) => [d.targetId, d]))
    expect(byId['t-pin']).toMatchObject({ layer: 'pin', action: 'hold', currentCents: 40, decidedCents: 40 })
    expect(byId['t-sup']).toMatchObject({ layer: 'stop', action: 'hold', currentCents: 2, decidedCents: 2 })
    expect(byId['t-it'].layer).toMatch(/^(goal|band|limit)$/)
    expect(byId['t-it'].why).toMatch(/aim 20%/)
    // Nothing reached a write path, and every bid is as it was.
    expect(await rows('SELECT (SELECT count(*)::int FROM "AdMutation") m, (SELECT count(*)::int FROM "OutboundSyncQueue") q, (SELECT count(*)::int FROM "AdvertisingActionLog") l')).toEqual(before)
    expect(await rows<{ id: string; bidCents: number }>('SELECT id, "bidCents" FROM "AdTarget" WHERE id IN (\'t-it\', \'t-low\', \'t-pin\') ORDER BY id'))
      .toEqual([{ id: 't-it', bidCents: 45 }, { id: 't-low', bidCents: 3 }, { id: 't-pin', bidCents: 40 }])
  })

  it('a rerun on the same facts stores nothing; the next day stores one snapshot each', async () => {
    expect((await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 60_000), mode: 'shadow' }))).markets[0]).toMatchObject({ decided: 4, stored: 0 })
    const next = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 20 * 3_600_000), mode: 'shadow' }))
    expect(next.markets[0]).toMatchObject({ decided: 4, stored: 4 })
    const kinds = await rows<{ kind: string; n: number }>('SELECT kind, count(*)::int n FROM "BidBrainDecision" WHERE "workspaceId" = $1 GROUP BY kind ORDER BY kind', [W])
    expect(kinds.reduce((n, k) => n + k.n, 0)).toBe(8)
  })

  it('brakes every decision while halted, and when the newest report is older than 48 hours', async () => {
    await inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', halted: true, haltReason: 'test halt' }, update: { halted: true, haltReason: 'test halt' } }))
    const halted = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 21 * 3_600_000), mode: 'shadow' }))
    expect(halted.markets[0].brakes).toEqual(['halted: test halt'])
    expect(halted.markets[0].byAction).toEqual({ brake: 4 })
    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: false } }))
    const stale = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 3 * DAY), mode: 'shadow' }))
    expect(stale.markets[0].brakes[0]).toMatch(/^data more than 48 hours old/)
  })

  it('prunes decisions older than 30 days, and another business sees none of them', async () => {
    await inside(() => database.client.bidBrainDecision.create({ data: {
      runId: 'old', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: 'c-it', targetId: 't-it', action: 'hold', layer: 'band',
      currentCents: 45, decidedCents: 45, dataDay: new Date('2026-08-01'), why: 'old', createdAt: new Date(NOW.getTime() - 31 * DAY),
    } }))
    const r = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 3 * DAY + 60_000), mode: 'shadow' }))
    expect(r.pruned).toBe(1)
    const theirs = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }), OTHER)
    expect(theirs.markets.every((m) => m.decided === 0)).toBe(true)
    expect(await inside(() => database.client.bidBrainDecision.count(), OTHER)).toBe(0)
  })

  it('does nothing with the switch off', async () => {
    const r = await inside(() => runShadowOnce({ now: NOW, mode: 'off' }))
    expect(r).toMatchObject({ mode: 'off', markets: [], pruned: 0 })
  })
})
