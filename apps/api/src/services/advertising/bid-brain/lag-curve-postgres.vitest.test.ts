/**
 * BID BRAIN BB-15 — the lag curve and the nowcast on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON). The fit's reads (vintages, report jobs, the 1d/7d seed's raw SQL) and the nowcast's grouped evidence aggregate run
 * as production runs them.
 *
 *   table      AdsLagCurve under row security: the fit stores one row per market, a rerun rewrites it, another business
 *              fits nothing and reads none of it
 *   fit        30 days of nightly copies of a made-up campaign (60 % of the final known at age 0) and a 1d/7d seed of 70 %
 *              give a usable "vintages" curve near 60 %, with its calibration on the newest 14 settled days
 *   no curve   before the first fit, shadow and on decide exactly as off: no nowcast is read, no words are added
 *   shadow     with the curve, the decisions are the settled ones byte for byte (action, layer, bids, goal bid, step);
 *              only the stored why of a keyword whose nowcast differs gains " · nowcast to …", and the run counts it
 *   on         the window ends yesterday and the young days count by their copy's maturity: the decision is the one the
 *              shadow named, and its why says how much of its clicks the young days carry
 *   read       the bid-brain read tool's calibration view shows the curve, what it rests on and its calibration
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
const { readBidBrain } = await import('./read.js')
const { fitLagCurves, lagFitSummaryLine } = await import('./lag-curve-store.js')

const W = `bb15_lag_${randomBytes(4).toString('hex')}`
const OTHER = `bb15_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const NOW = new Date('2026-10-07T12:50:00Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const midnight = (t: number) => new Date(Math.floor(t / DAY) * DAY)
/** The made-up truth: the share of a campaign day's final orders a copy pulled at each age holds. */
const TRUE_L = [0.6, 0.8, 0.9, 0.95, 0.97, 0.99, 1, 1]

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; goalBidCents: number | null; why: string; dataDay: string; step: unknown }
const decisions = () => inside(async () => (await database.client.bidBrainDecision.findMany({ orderBy: { targetId: 'asc' } })).map((d) => ({
  targetId: d.targetId, action: d.action, layer: d.layer, currentCents: d.currentCents, decidedCents: d.decidedCents, goalBidCents: d.goalBidCents,
  why: d.why, dataDay: d.dataDay.toISOString().slice(0, 10), step: (d.evidence as { step?: unknown } | null)?.step ?? null,
})) as Row[])
const clearDecisions = () => inside(() => database.client.bidBrainDecision.deleteMany({}))
const decisionCore = (r: Row) => ({ targetId: r.targetId, action: r.action, layer: r.layer, currentCents: r.currentCents, decidedCents: r.decidedCents, goalBidCents: r.goalBidCents, dataDay: r.dataDay, step: r.step })

/** The campaign c-it: 30 settled days of nightly copies (vintages + the ranged jobs that asked them) and the seed's rows. */
async function seedCampaignHistory() {
  const vintages = []
  const seedRows = []
  const firstDay = Date.UTC(2026, 7, 20)
  for (let k = 0; k < 30; k++) {
    const day = firstDay + k * DAY
    let last = -1
    for (let a = 0; a < TRUE_L.length; a++) {
      const orders = Math.round(10 * TRUE_L[a])
      if (orders === last) continue
      last = orders
      const pulledAt = new Date(day + (a + 1) * DAY + 75 * 60_000)
      vintages.push({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', entityType: 'CAMPAIGN', entityId: 'EXT-c-it', date: new Date(day), pulledAt, ageDays: a, source: 'pull', impressions: 1000, clicks: 300, costMicros: BigInt(90_000_000), orders7d: orders, sales7dCents: orders * 5000 })
    }
    // The settled campaign row the 1d/7d seed reads: 7 of the 10 orders bought within a day of the click.
    seedRows.push({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(day), entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it', clicks: 300, costMicros: BigInt(90_000_000), currencyCode: 'EUR', orders1d: 7, orders7d: 10, sales1dCents: 35_000, sales7dCents: 50_000, reportedAt: new Date(day + 8 * DAY + 2 * HOUR) })
  }
  // One ranged campaign report a night, the last 8 days (BB-13), asked at 01:15 UTC.
  const jobs = []
  for (let night = firstDay + DAY; night <= firstDay + 38 * DAY; night += DAY) {
    const asked = new Date(night + 75 * 60_000)
    jobs.push({ profileId: 'P-IT-TEST', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', externalReportId: `r-${night}`, startDate: new Date(night - 8 * DAY), endDate: new Date(night - DAY), configuration: {}, status: 'COMPLETED', createdAt: asked, ingestedAt: asked })
  }
  await database.client.adsDailyVintage.createMany({ data: vintages })
  await database.client.amazonAdsDailyPerformance.createMany({ data: seedRows })
  await database.client.amazonAdsReportJob.createMany({ data: jobs })
}

/**
 * The keywords' days: settled days 7–60 back (their settled copy, pulled at age 7) and, for t-it, the six young days
 * 1–6 back — each still holding the copy pulled the morning after (age 0), as the targeting report keeps them.
 */
async function seedKeywordDays() {
  const data = []
  const day = (target: string, i: number, clicks: number, orders: number, pullAge: number) => {
    const date = midnight(NOW.getTime() - i * DAY)
    data.push({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'AD_TARGET', entityId: `EXT-${target}`, localEntityId: target,
      clicks, costMicros: BigInt(clicks * 300_000), currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000,
      reportedAt: new Date(date.getTime() + (pullAge + 1) * DAY + 2 * HOUR),
    })
  }
  for (let i = 7; i <= 60; i++) {
    day('t-it', i, 8, i % 5 === 0 ? 1 : 0, 7)
    day('t-low', i, 2, 0, 7)
    day('t-pin', i, 3, 0, 7)
    day('t-off', i, 4, 0, 7)
  }
  // The young days of t-it: a run of sales the settled window has not seen yet.
  for (let i = 1; i <= 6; i++) day('t-it', i, 12, 2, 0)
  await database.client.amazonAdsDailyPerformance.createMany({ data })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-15 — the lag curve and the nowcast (real PostgreSQL)', { timeout: 120_000 }, () => {
  let offRows: Row[] = []

  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    // BB-21 — the switchback probes (shadow by default) add their own "would bid" words to the why: off here, the nowcast alone.
    vi.stubEnv('NEXUS_BID_BRAIN_PROBES', 'off')
    // Batch 3 review — every shadow layer that writes "would" words off too, so the why checks below read only the lag curve.
    vi.stubEnv('NEXUS_BID_BRAIN_EXPLORE', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_RESPONSE', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_HOUR_FACTORS', 'off')
    database = await concurrentDatabase()
    for (const id of [W, OTHER]) {
      await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [id])
    }
    await inside(async () => {
      await seedAdsFixture(database.client)
      await seedCampaignHistory()
      await seedKeywordDays()
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('before any curve: shadow and on decide exactly as off, add no words and read no nowcast', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    const off = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    offRows = await decisions()
    expect(off.markets.find((m) => m.market === 'IT')).toMatchObject({ decided: 4, stored: 4 })
    expect(offRows.every((r) => r.dataDay === '2026-09-30' && !r.why.includes('nowcast'))).toBe(true)
    for (const mode of ['shadow', 'on']) {
      await clearDecisions()
      vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', mode)
      const r = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
      expect(r.markets.find((m) => m.market === 'IT')!.nowcast).toBeUndefined()
      expect(await decisions()).toEqual(offRows)
    }
  })

  it('the fit stores one usable curve per market under row security; a rerun rewrites it; another business has none', async () => {
    const first = await inside(() => fitLagCurves({ now: NOW }))
    expect(first.markets).toHaveLength(1)
    expect(first.markets[0]).toMatchObject({ market: 'IT', source: 'vintages', usable: true, vintageDays: 30, finalOrders: 300, seeded: true, products: 0 })
    // 300 final orders against the seed's 20: 0.9375 × 60 % + 0.0625 × 70 %.
    expect(first.markets[0].firstSharePct).toBeCloseTo(60.6, 1)
    expect(first.markets[0].calibration).toMatchObject({ days: expect.any(Number) })
    expect(first.markets[0].calibration!.maeOrders).toBeLessThan(first.markets[0].calibration!.maeOrdersRaw)
    expect(lagFitSummaryLine(first)).toMatch(/^IT vintages L\(0\) 60\.6% 30d usable cal \d+ MAE /)
    const row = await inside(() => database.client.adsLagCurve.findFirstOrThrow({ where: { marketplace: 'IT', scopeId: '*' } }))
    expect(row).toMatchObject({ workspaceId: W, adProduct: 'SPONSORED_PRODUCTS', source: 'vintages', usable: true })
    const shares = row.shares as { orders: number[]; sales: number[] }
    expect(shares.orders).toHaveLength(15)
    expect(shares.orders.every((x, i) => i === 0 || x >= shares.orders[i - 1])).toBe(true)
    expect(shares.orders[14]).toBe(1)
    expect((row.calibration as { evalDays: number }).evalDays).toBe(14)
    // A rerun rewrites the same row with the same curve.
    await inside(() => fitLagCurves({ now: new Date(NOW.getTime() + HOUR) }))
    const again = await inside(() => database.client.adsLagCurve.findMany())
    expect(again).toHaveLength(1)
    expect(again[0].shares).toEqual(row.shares)
    expect(again[0].fittedAt.getTime()).toBe(NOW.getTime() + HOUR)
    // Another business: nothing to fit, and none of this business's rows, through Prisma or raw SQL.
    const other = await inside(() => fitLagCurves({ now: NOW }), OTHER)
    expect(other.markets).toEqual([])
    expect(lagFitSummaryLine(other)).toMatch(/nothing fitted/)
    expect(await inside(() => database.client.adsLagCurve.count(), OTHER)).toBe(0)
    expect(await inside(() => database.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "AdsLagCurve"`, OTHER)).toEqual([{ n: 0 }])
  })

  let shadowRows: Row[] = []
  it('shadow: the settled decisions byte for byte; the why of a keyword whose nowcast differs names it, and the run counts it', async () => {
    await clearDecisions()
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'shadow')
    const r = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    shadowRows = await decisions()
    expect(shadowRows.map(decisionCore)).toEqual(offRows.map(decisionCore))
    const it = r.markets.find((m) => m.market === 'IT')!
    expect(it.nowcast).toMatchObject({ dataDay: '2026-10-06', compared: 4 })
    expect(it.nowcast!.curve).toMatch(/^IT market curve \(vintages, 30 days, L\(0\) 61 %\)$/)
    expect(it.nowcast!.differ).toBeGreaterThanOrEqual(1)
    const noted = shadowRows.filter((row) => row.why.includes(' · nowcast to 2026-10-06: '))
    expect(noted.map((n) => n.targetId)).toContain('t-it')
    expect(noted).toHaveLength(it.nowcast!.differ)
    for (const row of shadowRows) {
      const was = offRows.find((o) => o.targetId === row.targetId)!
      expect(row.why.startsWith(was.why)).toBe(true)
      if (!noted.includes(row)) expect(row.why).toBe(was.why)
    }
    const tit = noted.find((n) => n.targetId === 't-it')!
    expect(tit.why.slice(offRows.find((o) => o.targetId === 't-it')!.why.length)).toMatch(/^ · nowcast to 2026-10-06: would (write|hold at) \d+¢ \([a-z-]+; CR [\d.]+% vs [\d.]+% settled; young days \d+% of its clicks\)$/)
  })

  it('on: the window ends yesterday and the young days count by maturity — the decision the shadow named', async () => {
    await clearDecisions()
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'on')
    const r = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const it = r.markets.find((m) => m.market === 'IT')!
    expect(it.nowcast).toBeUndefined()
    expect(it.nowcastOn).toMatchObject({ dataDay: '2026-10-06', curve: 'IT market curve (vintages, 30 days, L(0) 61 %)' })
    const onRows = await decisions()
    expect(onRows.every((row) => row.dataDay === '2026-10-06' && !row.why.includes('would'))).toBe(true)
    const named = /would (?:write|hold at) (\d+)¢/.exec(shadowRows.find((s) => s.targetId === 't-it')!.why)!
    const young = /young days (\d+)% of its clicks/.exec(shadowRows.find((s) => s.targetId === 't-it')!.why)!
    const tit = onRows.find((row) => row.targetId === 't-it')!
    expect(tit.decidedCents).toBe(Number(named[1]))
    expect(tit.why.endsWith(` · nowcast to 2026-10-06: young days ${young[1]}% of its clicks`)).toBe(true)
    // The override decisions say nothing of young days.
    expect(onRows.filter((row) => row.why.includes('nowcast to')).map((row) => row.targetId)).toEqual(['t-it'])
    expect(tit.decidedCents).not.toBe(offRows.find((o) => o.targetId === 't-it')!.decidedCents)
    // The keywords the young days did not touch decide as before (their days are settled copies).
    for (const id of ['t-pin', 't-sup']) expect(decisionCore(onRows.find((row) => row.targetId === id)!)).toMatchObject({ action: offRows.find((o) => o.targetId === id)!.action, decidedCents: offRows.find((o) => o.targetId === id)!.decidedCents })
  })

  it('the read tool’s calibration view shows the curve, what it rests on and how well it nowcast the newest settled days', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'shadow')
    const view = await inside(() => readBidBrain({ view: 'calibration', market: 'IT' })) as { data: { view: string; nowcast: string; markets: Array<Record<string, any>>; note: string } }
    expect(view.data).toMatchObject({ view: 'calibration', nowcast: 'shadow' })
    const it = view.data.markets[0]
    expect(it.market).toBe('IT')
    expect(it.curve).toMatchObject({ scope: 'market', source: 'vintages', usable: true, stale: false, basis: { vintageDays: 30, finalOrders: 300, pooledToward: 'seed', seed: { ordersSharePct: 70 } } })
    expect(it.curve.sharesPct.ages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(it.curve.sharesPct.orders[0]).toBeCloseTo(60.6, 1)
    expect(it.curve.calibration.ages[0]).toMatchObject({ age: 0, used: true })
    expect(it.curve.calibration.ages[0].maeOrders).toBeLessThan(it.curve.calibration.ages[0].maeOrdersRaw)
    expect(view.data.note).toMatch(/WITHOUT the newest 14 settled days/)
    const de = await inside(() => readBidBrain({ view: 'calibration', market: 'DE' })) as { data: { markets: Array<Record<string, unknown>> } }
    expect(de.data.markets[0]).toMatchObject({ market: 'DE', curve: null, products: [] })
    expect(de.data.markets[0].missing).toMatch(/no curve fitted/)
    // Another business sees no curve.
    const other = await inside(() => readBidBrain({ view: 'calibration', market: 'IT' }), OTHER) as { data: { markets: Array<Record<string, unknown>> } }
    expect(other.data.markets[0]).toMatchObject({ market: 'IT', curve: null })
  })
})
