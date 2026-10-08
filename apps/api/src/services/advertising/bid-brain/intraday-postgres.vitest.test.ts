/**
 * BID BRAIN BB-17 — the intraday brakes on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the server switch `live`, the ads mode LIVE (the real write gate) and the job queue a stub. The brakes' reads run as
 * production runs them: the campaign grain's grouped hours, BB-16's placement grain (two hours a day) with its capped days,
 * the money brain's plan of today, Campaign.dailyBudget and the Owner's setting overrides.
 *
 *   read     on made-up rows of a LIVE campaign: 14 usual days of 40¢ an hour, today 100¢ an hour → a spend cut against the
 *            median day; a money plan of today replaces the median; the Owner's campaign value moves the cut line; the top
 *            of search at 3 × its 14-day CPC → a spike held to 2 × the median; the budget runs out before the evening's
 *            best hours → its low hours slow; another business reads none of it; off reads nothing
 *   shadow   the default: every decision and every write exactly as with the brakes off; the stored why names what the
 *            cut would do; the run's line counts it
 *   on       the cut written as the brain through the real gate, its why the brake's; a rerun and a light tick write
 *            nothing more; the next budget day gives the bid back (restore)
 *   gaps     a day the grain capped leaves the CPC brake out, said; a feed silent for 3 hours leaves every brake out, said
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

const { runShadowOnce, shadowSummaryLine } = await import('./shadow.js')
const { setEnrollment } = await import('./enrollment.js')
const { loadMarket } = await import('./load.js')
const { loadIntraday } = await import('./intraday-load.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')

const W = `bb17_intraday_${randomBytes(4).toString('hex')}`
const OTHER = `bb17_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const DAY = 86_400_000
const HOUR = 3_600_000
/** The newest 14:20 UTC not after the real clock: the brakes read a fixed hour, the gate and the logs the real clock. */
const NOW = (() => { const real = Date.now(); const t = Math.floor(real / DAY) * DAY + 14 * HOUR + 20 * 60_000; return new Date(t > real ? t - DAY : t) })()
const TODAY = new Date(Math.floor(NOW.getTime() / DAY) * DAY)
const dayIso = (d: Date) => d.toISOString().slice(0, 10)

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; why: string }
const decisions = (targetId = 't-it') => rows<Row>('SELECT "targetId", action, layer, "currentCents", "decidedCents", why FROM "BidBrainDecision" WHERE "workspaceId" = $1 AND "targetId" = $2 ORDER BY "createdAt", id', [W, targetId])
const bidOf = async (id: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [id]))[0].b
const brainLogs = () => rows<{ entityId: string; after: number }>('SELECT "entityId", ("payloadAfter" ->> \'bidCents\')::int AS after FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "userId" = \'automation:bid-brain\' ORDER BY "createdAt"', [W])
const reset = async () => {
  await database.pool.query('DELETE FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
  await database.pool.query('DELETE FROM "AdvertisingActionLog" WHERE "workspaceId" = $1', [W])
  await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 45 WHERE id = \'t-it\'')
}
const brakesNow = async (at = NOW, w = W, campaignId = 'c-it') => inside(async () => {
  const m = await loadMarket('IT', { now: at })
  return loadIntraday(m, [campaignId], at)
}, w)

/** The campaign grain of c-it: 14 usual days at 40¢ an hour (1-day sales in the evening), today 100¢ an hour until now. */
async function seedHours() {
  const data = []
  const row = (date: Date, hour: number, costCents: number, orders = 0) => ({
    profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, hour, entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it',
    impressions: 100, clicks: 2, costMicros: BigInt(costCents * 10_000), currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 6000, reportRunId: 'ams-stream',
    reportedAt: new Date(date.getTime() + (hour + 1) * HOUR + 20 * 60_000),
  })
  for (let k = 1; k <= 14; k++) for (let h = 0; h < 24; h++) data.push(row(new Date(TODAY.getTime() - k * DAY), h, 40, h >= 18 && h <= 21 ? 1 : 0))
  for (let h = 0; h < 14; h++) data.push(row(TODAY, h, 100))
  data.push({ ...row(TODAY, 14, 30), reportedAt: new Date(NOW.getTime() - 10 * 60_000) })
  await database.client.amazonAdsHourlyPerformance.createMany({ data })
}

/** BB-16's grain at the top of search, 13:00 and 14:00 UTC: 20¢ a click on the 14 days before, 60¢ today. */
async function seedPlacements() {
  const data = []
  const cell = (date: Date, hour: number, clicks: number, costCents: number) => ({
    profileId: 'P-IT-TEST', marketplace: 'IT', campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it', placement: 'PLACEMENT_TOP', date, hour, currencyCode: 'EUR',
    impressions: 50, clicks, costMicros: BigInt(costCents * 10_000), firstArrivalAt: new Date(date.getTime() + (hour + 1) * HOUR), lastArrivalAt: new Date(date.getTime() + (hour + 1) * HOUR),
  })
  for (let k = 1; k <= 14; k++) for (const h of [13, 14]) data.push(cell(new Date(TODAY.getTime() - k * DAY), h, 5, 100))
  for (const h of [13, 14]) data.push({ ...cell(TODAY, h, 6, 360), lastArrivalAt: new Date(NOW.getTime() - 15 * 60_000) })
  await database.client.amazonAdsHourlyPlacement.createMany({ data })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-17 — the intraday brakes (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', '')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    database = await concurrentDatabase()
    for (const w of [W, OTHER]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      const data = []
      for (let i = 1; i < 38; i++) {
        data.push({
          profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
          entityId: 'EXT-t-it', localEntityId: 't-it', clicks: 6, costMicros: BigInt(6 * 300_000), currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportedAt: new Date(NOW.getTime() - HOUR),
        })
      }
      await db.amazonAdsDailyPerformance.createMany({ data })
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
      await setAutonomy('AUTO', 'test')
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
      await seedHours()
      await seedPlacements()
    })
    // The other business: the same account under its own ids, no hours at all.
    await inside(() => seedAdsFixture(database.client, { prefix: 'o-' }), OTHER)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('reads the brakes on real rows: a spend cut, the money plan, the Owner\'s value, a CPC spike, the budget; another business none; off nothing', async () => {
    const run = (await brakesNow())!
    expect(run).toMatchObject({ mode: 'shadow', campaigns: 1, gaps: [] })
    const c = run.brakes.get('c-it')!
    // 1,430¢ by 14:20 on a flat usual day (59.7 % gone) heads for 2,395¢ against a 960¢ median day: a cut since 06:00.
    expect(c.spend).toMatchObject({ level: 'cut', spentCents: 1430, plannedCents: 960, plannedFrom: 'the median of its last 14 days that spent', since: 6, stepPct: 10 })
    expect(c.spend!.projectedCents).toBeGreaterThan(2390)
    expect(c.spend!.projectedCents).toBeLessThan(2400)
    // Top of search: 12 clicks for €7.20 over 13:00–15:00 against 20¢ on each of 14 days → held to 40¢.
    expect(c.cpc).toEqual([expect.objectContaining({ lane: 'TOP_OF_SEARCH', readingCents: 60, clicks: 12, medianCents: 20, days: 14, ceilingCents: 40 })])
    // The €20 budget runs out about 20:00, before the evening's best hours (17–23 by 1-day sales): the low hours slow to the floor.
    expect(c.budget).toMatchObject({ factor: 0.5, lowHour: true, bestHours: [17, 18, 19, 20, 21, 22] })
    expect(c.budget!.why).toMatch(/before its best hours \(17:00–23:00 UTC, by its 1-day sales over 28 days\)/)

    // The money brain's plan of today names 1,700¢ for the campaign: 141 % of it — a hold, no cut.
    await inside(() => database.client.adsBrainBudgetDecision.create({ data: {
      runId: 'money-test', mode: 'SHADOW', kind: 'snapshot', productId: 'p-root', marketplace: 'IT', day: TODAY, month: dayIso(TODAY).slice(0, 7), level: 'OBSERVE',
      envelopeSource: 'own', spentCents: 0, projectedCents: 0, brake: 'none', planHash: 'h', why: 'test',
      plan: { campaigns: [{ campaignId: 'c-it', expectedSpendCents: 1700 }, { campaignId: 'c-other', expectedSpendCents: 'n/a' }] },
    } }))
    expect((await brakesNow())!.brakes.get('c-it')!.spend).toMatchObject({ level: 'hold', plannedCents: 1700, plannedFrom: 'the money brain\'s plan of today' })
    await database.pool.query('DELETE FROM "AdsBrainBudgetDecision" WHERE "workspaceId" = $1', [W])

    // The Owner's campaign value: cut only above 300 % → a hold.
    const override = await inside(() => database.client.adsBrainOverride.create({ data: { productId: '', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'VALUE', key: 'intradaySpendCutPct', value: 300, by: 'user:owner' } }))
    expect((await brakesNow())!.brakes.get('c-it')!.spend).toMatchObject({ level: 'hold' })
    await inside(() => database.client.adsBrainOverride.update({ where: { id: override.id }, data: { endedAt: new Date(), endedBy: 'user:owner' } }))
    expect((await brakesNow())!.brakes.get('c-it')!.spend).toMatchObject({ level: 'cut' })

    // Another business reads none of these rows (its own campaign has no hours: the feed is silent for it); off reads nothing.
    const other = (await brakesNow(NOW, OTHER, 'o-c-it'))!
    expect(other.gaps).toEqual(['the hourly feed has sent nothing for these campaigns today (3 hours or more)'])
    expect(other.brakes.size).toBe(0)
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'off')
    expect(await brakesNow()).toBeUndefined()
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', '')
  })

  it('shadow (the default): every decision and write as with the brakes off; the stored why names the cut; the line counts it', async () => {
    // Off first: what the brain decides and writes without BB-17. The budget is lifted so only the spend cut and the spike bite.
    await database.pool.query('UPDATE "Campaign" SET "dailyBudget" = 100.00 WHERE id = \'c-it\' AND "workspaceId" = $1', [W])
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'off')
    const off = await inside(() => runShadowOnce({ now: NOW, mode: 'live' }))
    const offRows = (await decisions()).map(({ why: _why, ...core }) => core)
    const offBid = await bidOf('t-it')
    const offLogs = await brainLogs()
    expect(shadowSummaryLine(off)).not.toMatch(/intraday/)
    await reset()

    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', '')
    const shadow = await inside(() => runShadowOnce({ now: NOW, mode: 'live' }))
    const shadowRows = await decisions()
    expect(shadowRows.map(({ why: _why, ...core }) => core)).toEqual(offRows)
    expect(await bidOf('t-it')).toBe(offBid)
    expect(await brainLogs()).toEqual(offLogs)
    // t-it: the goal would raise it, and BB-10's spend guard already holds that raise this hour (90¢ heads against a 40¢
    // average); the brakes would step it down: 45 × 0.9 → 40¢ (the spike's cap is 40¢ too).
    expect(offRows[0]).toMatchObject({ targetId: 't-it', action: 'hold', layer: 'goal', currentCents: 45, decidedCents: 45 })
    expect(shadowRows[0].why).toMatch(/^goal: raise held — this hour's spend heads for €0\.90/)
    expect(shadowRows[0].why).toMatch(/ · intraday \(shadow\): would write 40¢ \(intraday; spend cut −10 %, CPC spike top-of-search\)$/)
    const it = shadow.markets.find((m) => m.market === 'IT')!
    expect(it.intraday).toMatchObject({ mode: 'shadow', campaigns: 1, spendCut: 1, cpcLanes: 1, budget: 0 })
    expect(it.intraday!.changed).toBeGreaterThanOrEqual(1)
    expect(shadowSummaryLine(shadow)).toMatch(/intraday shadow: 1 campaign — spend hold 0, spend cut 1, CPC spikes 1, budget 0; \d+ of \d+ decisions would change/)
    await reset()
  })

  it('on: the cut written as the brain through the real gate; a rerun and a light tick write nothing more; the next day gives it back', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'on')
    const first = await inside(() => runShadowOnce({ now: NOW, mode: 'live' }))
    expect(first.markets.find((m) => m.market === 'IT')!.writes).toMatchObject({ queued: expect.any(Number) })
    expect(await bidOf('t-it')).toBe(40)
    const [d] = await decisions()
    expect(d).toMatchObject({ action: 'write', layer: 'intraday', currentCents: 45, decidedCents: 40 })
    expect(d.why).toBe('intraday: the intraday spend cut (−10 % for the rest of the budget day) and the intraday CPC spike (top-of-search click ≤ 40¢: bid ≤ 40¢) → 40¢ from the 45¢ before it')
    expect((await brainLogs()).filter((l) => l.entityId === 't-it')).toEqual([{ entityId: 't-it', after: 40 }])
    expect(shadowSummaryLine(first)).toMatch(/intraday on: 1 campaign — spend hold 0, spend cut 1, CPC spikes 1, budget 0; \d+ of \d+ decisions changed/)

    // A rerun 10 minutes later: the cut holds at 40¢ (stored once as the hold after the write), nothing written; a light tick
    // after it lands on the same hold — nothing written, nothing stored.
    await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 10 * 60_000), mode: 'live' }))
    expect((await decisions()).slice(1)).toEqual([expect.objectContaining({ action: 'hold', layer: 'intraday', currentCents: 40, decidedCents: 40 })])
    await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 12 * 60_000), clockNow: new Date(NOW.getTime() + 12 * 60_000), mode: 'live', onlyOwned: true }))
    expect(await bidOf('t-it')).toBe(40)
    expect((await brainLogs()).filter((l) => l.entityId === 't-it')).toHaveLength(1)
    expect(await decisions()).toHaveLength(2)

    // The next budget day at 10:00 UTC: no spend today yet, the brakes released — the bid goes back (restore, as the brain).
    const next = new Date(TODAY.getTime() + DAY + 10 * HOUR)
    await inside(() => runShadowOnce({ now: next, clockNow: next, mode: 'live' }))
    const last = (await decisions()).at(-1)!
    expect(last).toMatchObject({ action: 'write', layer: 'restore', currentCents: 40 })
    expect(last.decidedCents).toBeGreaterThanOrEqual(45)
    expect(last.why).toMatch(/^restore: the intraday layer no longer applies → back to \d+¢ from the 40¢ it held \(the bid before it: 45¢/)
    expect(await bidOf('t-it')).toBe(last.decidedCents)
    await reset()
  })

  it('gaps: a day the grain capped leaves the CPC brake out; a feed silent for 3 hours leaves every brake out — said', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', '')
    await inside(() => database.client.amazonAdsGrainCap.create({ data: { date: TODAY, kind: 'rows', cap: 10_000, refused: 3, firstAt: NOW, lastAt: NOW } }))
    const capped = (await brakesNow())!.brakes.get('c-it')!
    expect(capped.cpc).toEqual([])
    expect(capped.gaps).toContain('top-of-search CPC: the hourly grain capped today\'s rows — today\'s cost per click is not known')
    expect(capped.spend).toMatchObject({ level: 'cut' })
    // Five hours on with nothing new from the feed: no brake at all, and the run's line says why.
    const later = new Date(NOW.getTime() + 5 * HOUR)
    const silent = (await brakesNow(later))!
    expect(silent.brakes.size).toBe(0)
    expect(silent.gaps).toEqual([expect.stringMatching(/^the hourly feed has sent nothing for these campaigns since \d\d:\d\d UTC \(3 hours or more\)$/)])
    const r = await inside(() => runShadowOnce({ now: later, clockNow: later, mode: 'live' }))
    expect(shadowSummaryLine(r)).toMatch(/intraday shadow: no brake — the hourly feed has sent nothing for these campaigns since/)
  })
})
