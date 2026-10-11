/**
 * KAPI-B (2026-10-10, Bid page "keyword Auto + goal + max bid") — a person's own goal, max and lock of one keyword on a real
 * PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the
 * restricted runtime login, business profiles ON), the bid brain in shadow and the job queue a stub. load.ts
 * loadKeywordOwn reads as production reads (one AdsBrainOverride query, refs target:/adGroup:):
 *
 *   off       nothing set anywhere: the map is empty and the run stores what it stored before
 *   max       the keyword's own max (maxBidCents, ref target:t-it) below its bid: the full run brings it down, named
 *             "Your max for this keyword"; a between-slots tick (no evidence) decides the same from the same max
 *   goal      the keyword's own target ACoS beats a rule's GOAL directive on it: the why names it as the person's
 *   lock      the Owner's lock of the keyword's ad group's bids (set-ads-brain lock bids, ref adGroup:<id>): pinned, left alone
 *   handback  a person's bid of the last 60 days holds the keyword; after his hand-back (Auto) the brain's run no longer
 *             reads it as held, and a newer bid of his holds it again
 *   business  another business's override on a target id spelled the same is never read
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
const { loadMarket, loadRun, loadKeywordOwn } = await import('./load.js')
const { buildFacts } = await import('./facts.js')
const { decide } = await import('./decide.js')
const { handBackKeyword } = await import('./brain-holds.js')

const W = `kapib_kw_${randomBytes(4).toString('hex')}`
const OTHER = `kapib_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const DAY = 86_400_000
const HOUR = 3_600_000
/** The newest 06:50 UTC not after the real clock (a full run's slot). */
const NOW = (() => { const real = Date.now(); const t = Math.floor(real / DAY) * DAY + 6 * HOUR + 50 * 60_000; return new Date(t > real ? t - DAY : t) })()
const TODAY = new Date(Math.floor(NOW.getTime() / DAY) * DAY)
const daysAgo = (k: number) => new Date(TODAY.getTime() - k * DAY)

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; why: string }
const decisions = (targetId = 't-it') => rows<Row>('SELECT "targetId", action, layer, "currentCents", "decidedCents", why FROM "BidBrainDecision" WHERE "workspaceId" = $1 AND "targetId" = $2 ORDER BY "createdAt", id', [W, targetId])
const reset = () => database.pool.query('DELETE FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
const override = (data: Record<string, unknown>, w = W) => inside(() => database.client.adsBrainOverride.create({ data: { productId: '', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'VALUE', ref: 'target:t-it', by: 'user:owner', ...data } }), w)
const endAll = () => database.pool.query('UPDATE "AdsBrainOverride" SET "endedAt" = now(), "endedBy" = \'user:owner\' WHERE "workspaceId" = $1 AND "endedAt" IS NULL', [W])
const ownOf = async () => inside(async () => {
  const m = await loadMarket('IT', { now: NOW })
  return loadKeywordOwn(m.targets.map((t) => ({ id: t.id, adGroupId: t.adGroupId, campaignId: m.adGroups.get(t.adGroupId)!.campaignId, market: 'IT' })))
})

describe.skipIf(!concurrentDatabaseUrl())('KAPI-B — a keyword\'s own goal, max and lock (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'off')
    database = await concurrentDatabase()
    for (const w of [W, OTHER]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      // t-it: 37 settled days of evidence (the goal moves it from 45¢).
      const data = []
      for (let i = 1; i < 38; i++) {
        data.push({
          profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(i), entityType: 'AD_TARGET', entityId: 'EXT-t-it', localEntityId: 't-it',
          impressions: 200, clicks: 6, costMicros: BigInt(6 * 300_000), currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportedAt: new Date(NOW.getTime() - HOUR),
        })
      }
      await db.amazonAdsDailyPerformance.createMany({ data })
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
    })
    await inside(() => seedAdsFixture(database.client, { prefix: 'o-' }), OTHER)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('nothing set anywhere: no keyword holds anything of its own, and the run decides as before', async () => {
    expect((await ownOf()).size).toBe(0)
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d).toMatchObject({ layer: 'goal', action: 'write', currentCents: 45 })
    expect(d.why).not.toMatch(/Your max|Your goal/)
    await reset()
  })

  it('the keyword\'s own max below its bid: the full run brings it down, named; a tick with no evidence decides the same', async () => {
    await override({ key: 'maxBidCents', value: 30 })
    const own = await ownOf()
    expect([...own.keys()]).toEqual(['t-it'])
    expect(own.get('t-it')).toMatchObject({ max: { cents: 30, by: expect.stringMatching(/^user:owner, \d{4}-\d{2}-\d{2}$/) } })
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d.decidedCents).toBeLessThanOrEqual(30)
    expect(d.action).toBe('write')
    expect(d.why).toMatch(/Your max for this keyword/)
    // A between-slots tick: the market read with no evidence; the max is in the facts all the same.
    const tick = await inside(async () => {
      const m = await loadMarket('IT', { now: NOW, light: true, campaignIds: new Set(['c-it']) })
      const { run } = await loadRun(m, NOW)
      return buildFacts(m, run).map((f) => decide(f)).find((x) => x.targetId === 't-it')!
    })
    expect([tick.action, tick.layer, tick.bidCents]).toEqual(['write', 'limit', 30])
    expect(tick.why).toBe('limit: 45¢ is above Your max for this keyword (30¢) → 30¢ (no goal: no evidence to pool)')
    await reset()
    await endAll()
  })

  it('the keyword\'s own target ACoS beats a rule\'s GOAL directive on it; the why names it as the person\'s', async () => {
    await override({ key: 'targetAcosPct', value: 30, by: 'user:owner-2' })
    await inside(() => database.client.bidDirective.create({ data: { campaignId: 'c-it', targetId: 't-it', kind: 'GOAL', valuePct: 10, source: 'rule:r-goal', until: new Date(NOW.getTime() + 7 * DAY) } }))
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d.why).toMatch(/aim 30% \(default band 27%–34\.5%\) \(Your goal for this keyword, user:owner-2, \d{4}-\d{2}-\d{2}\)/)
    expect(d.why).not.toMatch(/the goal of rule/)
    await reset()
    await endAll()
    await database.pool.query('DELETE FROM "BidDirective" WHERE "workspaceId" = $1', [W])
  })

  it('the Owner\'s lock of the ad group\'s bids pins the keyword: left alone, his lock named', async () => {
    await override({ kind: 'LOCK', key: 'bids', ref: 'adGroup:g-c-it', value: null })
    expect((await ownOf()).get('t-it')).toMatchObject({ lock: { by: expect.stringMatching(/^its ad group's bids locked by the Owner's campaign override \(user:owner, /) } })
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d).toMatchObject({ action: 'hold', layer: 'pin', currentCents: 45, decidedCents: 45 })
    expect(d.why).toMatch(/^pin: held by its ad group's bids locked by the Owner's campaign override/)
    await reset()
    await endAll()
  })

  it('a person\'s bid of the last 60 days holds the keyword; after his hand-back the run no longer reads it held; a newer bid holds it again', async () => {
    const log = (at: Date) => inside(() => database.client.advertisingActionLog.create({ data: { userId: 'user:owner', actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-it', payloadBefore: { bidCents: 40 }, payloadAfter: { bidCents: 45 }, createdAt: at, amazonResponseStatus: 'SUCCESS' } }))
    const held = () => inside(async () => (await loadRun(await loadMarket('IT', { now: NOW }), NOW)).run.personHeld.has('t-it'))
    await log(new Date(NOW.getTime() - 2 * DAY))
    expect(await held()).toBe(true)
    await inside(() => handBackKeyword({ campaignId: 'c-it', targetId: 't-it', actor: 'user:owner', now: new Date(NOW.getTime() - DAY) }))
    expect(await held()).toBe(false)
    await log(new Date(NOW.getTime() - HOUR))
    expect(await held()).toBe(true)
    await database.pool.query('DELETE FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = \'t-it\'', [W])
    await database.pool.query('DELETE FROM "BidHold" WHERE "workspaceId" = $1', [W])
  })

  it('another business\'s override on a target id spelled the same is never read', async () => {
    await override({ key: 'maxBidCents', value: 10, campaignId: 'c-it' }, OTHER)
    expect((await ownOf()).size).toBe(0)
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    expect((await decisions())[0].why).not.toMatch(/Your max/)
    await reset()
  })
})
