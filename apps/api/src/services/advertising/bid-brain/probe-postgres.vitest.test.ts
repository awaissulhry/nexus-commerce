/**
 * BID BRAIN BB-21 — switchback probes on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON). The BidProbe ledger is written and read as production writes and reads it, through the full bid brain runs.
 *
 *   off       NEXUS_BID_BRAIN_PROBES=off reads and writes nothing, says nothing
 *   shadow    every decision is the off run's, byte for byte (action, layer, bids, goal bid, step); the busy keyword the goal
 *             holds gets ONE SHADOW probe (symmetric arms around its bid, day 1 recorded, the why "probe (shadow): would
 *             bid …"); a rerun the same day stores no decision and starts no second probe
 *   days      a run a day for 15 days records each day's arm; after its last day it is MEASURING, 3 days later measured:
 *             DONE with each side's clean days, clicks, cost and orders, and no reading (a shadow probe is a placebo)
 *   ε         a DONE live probe's reading is read back by the response: the keyword's ε says "1 probe in the market"
 *   on        under a live switch, the campaign enrolled LIVE: the keyword's running shadow probe stops ("the switch went
 *             on"), a LIVE probe starts, and its arm is the decision — layer probe, written once through the one bid path
 *             (queued as the brain), the step recorded from the center; a campaign not owned stays the goal's; a rerun
 *             writes nothing more
 *   read      the bid-brain tool's view probes: the probes with their keyword, arms and days, ε per pool
 *   business  another business reads none of it; the table refuses a row without a business
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
const { loadProbeLedger, loadProbeReadings, todayIn } = await import('./probe-store.js')
const { readBidBrain } = await import('./read.js')
const { setEnrollment } = await import('./enrollment.js')
const { BRAIN_ACTOR } = await import('./live.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')

const W = `bb21_probe_${randomBytes(4).toString('hex')}`
const OTHER = `bb21_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const NOW = new Date('2026-10-07T12:50:00Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const midnight = (t: number) => new Date(Math.floor(t / DAY) * DAY)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; goalBidCents: number | null; why: string; dataDay: string; step: unknown; probe: Record<string, unknown> | null; mode: string; sent: { sent?: string } | null }
const decisions = (where: Record<string, unknown> = {}) => inside(async () => (await database.client.bidBrainDecision.findMany({ where, orderBy: [{ targetId: 'asc' }, { createdAt: 'asc' }] })).map((d) => {
  const e = (d.evidence ?? {}) as { step?: unknown; probe?: Record<string, unknown>; sent?: { sent?: string } }
  return {
    targetId: d.targetId, action: d.action, layer: d.layer, currentCents: d.currentCents, decidedCents: d.decidedCents, goalBidCents: d.goalBidCents,
    why: d.why, dataDay: d.dataDay.toISOString().slice(0, 10), step: e.step ?? null, probe: e.probe ?? null, mode: d.mode, sent: e.sent ?? null,
  }
}) as Row[])
const clearDecisions = () => inside(() => database.client.bidBrainDecision.deleteMany({}))
const core = (r: Row) => ({ targetId: r.targetId, action: r.action, layer: r.layer, currentCents: r.currentCents, decidedCents: r.decidedCents, goalBidCents: r.goalBidCents, dataDay: r.dataDay, step: r.step })
const probes = () => inside(() => database.client.bidProbe.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))

/** One day of a keyword: 10 clicks at 44¢, an €80 order every fourth day (a made-up 2.5 % rate, 22 % ACoS). */
const dayRow = (target: string, date: Date, i: number, reportedAt: Date, clicks = 10) => ({
  profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'AD_TARGET', entityId: `EXT-${target}`, localEntityId: target,
  impressions: clicks * 30, clicks, costMicros: BigInt(clicks * 440_000), currencyCode: 'EUR', orders7d: i % 4 === 0 ? 1 : 0, sales7dCents: i % 4 === 0 ? 8000 : 0,
  reportedAt,
})

/** 60 settled days of the two busy keywords: t-it in c-it (45¢), t-two in a second allowlisted IT campaign (45¢). */
async function seedDays() {
  const data = []
  for (let i = 1; i <= 66; i++) {
    const date = midnight(NOW.getTime() - i * DAY)
    const reportedAt = i <= 7 ? new Date(NOW.getTime() - HOUR) : new Date(date.getTime() + 8 * DAY)
    data.push(dayRow('t-it', date, i, reportedAt), dayRow('t-two', date, i, reportedAt))
  }
  await database.client.amazonAdsDailyPerformance.createMany({ data })
}

/** The next day's report: yesterday's row of both keywords, reported an hour before `now` (fresh data, no brake). */
const nextDay = (now: Date, i: number) => inside(() => database.client.amazonAdsDailyPerformance.createMany({
  data: [dayRow('t-it', midnight(now.getTime() - DAY), i, new Date(now.getTime() - HOUR)), dayRow('t-two', midnight(now.getTime() - DAY), i, new Date(now.getTime() - HOUR))],
  skipDuplicates: true,
}))

describe.skipIf(!concurrentDatabaseUrl())('BB-21 — switchback probes (real PostgreSQL)', { timeout: 180_000 }, () => {
  let offRows: Row[] = []

  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_EXPLORE', 'off')
    database = await concurrentDatabase()
    for (const id of [W, OTHER]) {
      await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [id])
    }
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      await db.campaign.create({ data: { id: 'c-two', name: 'Italy second', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-two', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await db.adGroup.create({ data: { id: 'g-c-two', campaignId: 'c-two', name: 'group c-two', externalAdGroupId: 'EXT-g-c-two' } })
      await db.adTarget.create({ data: { id: 't-two', adGroupId: 'g-c-two', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'touring gloves', bidCents: 45, externalTargetId: 'EXT-t-two' } })
      await seedDays()
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 22, targetLoPct: 18, targetHiPct: 28, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
    })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table refuses a row without a business, and another business sees none', async () => {
    await expect(database.client.bidProbe.create({ data: {
      marketplace: 'IT', campaignId: 'c-it', adGroupId: 'g-c-it', targetId: 't-it', mode: 'SHADOW', status: 'RUNNING', centerCents: 45, highCents: 51, lowCents: 39,
      amplitude: 0.13, sequence: 'HLLH', startDay: new Date('2026-09-01T00:00:00Z'), endDay: new Date('2026-09-12T00:00:00Z'), why: 'x', runId: 'r',
    } })).rejects.toThrow()
    expect(await inside(() => database.client.bidProbe.count(), OTHER)).toBe(0)
  })

  it('off reads and writes nothing, and says nothing', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_PROBES', 'off')
    const run = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    offRows = await decisions()
    expect(offRows.find((r) => r.targetId === 't-it')).toMatchObject({ layer: 'band', action: 'hold', currentCents: 45 })
    expect(offRows.find((r) => r.targetId === 't-two')).toMatchObject({ layer: 'band', action: 'hold', currentCents: 45 })
    expect(offRows.every((r) => r.probe == null && !/probe/.test(r.why))).toBe(true)
    expect(await probes()).toEqual([])
    expect(shadowSummaryLine(run)).not.toMatch(/probes/)
  })

  it('shadow keeps every decision byte for byte; the busy keywords the goal holds get one SHADOW probe each; a rerun adds nothing', async () => {
    await clearDecisions()
    vi.stubEnv('NEXUS_BID_BRAIN_PROBES', 'shadow')
    const run = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const after = await decisions()
    expect(after.map(core)).toEqual(offRows.map(core))
    const ledger = await probes()
    expect(ledger.map((p) => p.targetId).sort()).toEqual(['t-it', 't-two'])
    const today = todayIn('IT', NOW)
    expect(today).toBe('2026-10-07')
    for (const p of ledger) {
      expect(p).toMatchObject({ workspaceId: W, marketplace: 'IT', mode: 'SHADOW', status: 'RUNNING', centerCents: 45, startDay: new Date(`${today}T00:00:00Z`), endDay: new Date('2026-10-18T00:00:00Z') })
      expect(p.highCents - 45).toBe(45 - p.lowCents)
      expect(p.highCents).toBeGreaterThan(45)
      expect(['HLLH', 'LHHL']).toContain(p.sequence)
      expect(p.days).toEqual({ [today]: { arm: p.sequence[0], bidCents: p.sequence[0] === 'H' ? p.highCents : p.lowCents, served: true } })
      expect(p.why).toMatch(/^ε of its product 0\.8 ± 0\.4 is the least certain it may test; 70 clicks a week; ±\d+¢ \(\d+(\.\d)?%.*\) around 45¢, high days \+\d+¢ expected at most$/)
    }
    // Two products of a day would alternate; here both keywords sit in the market's one pool (no product known): the orders alternate.
    expect(ledger[0].sequence).not.toBe(ledger[1].sequence)
    const it = after.find((r) => r.targetId === 't-it')!
    expect(it.why).toMatch(/ · probe \(shadow\): would bid \d+¢ — day 1 of 12, the (high|low) arm \(45¢ [+−] \d+¢\), a washout day; switchback (HLLH|LHHL) from 2026-10-07, budget-neutral: 6 days at \d+¢ and 6 at \d+¢, average 45¢$/)
    expect(it.probe).toMatchObject({ mode: 'SHADOW', status: 'RUNNING', day: 1, washout: true, served: true, new: true, centerCents: 45, picked: expect.stringMatching(/^ε of its product 0\.8 ± 0\.4 is the least certain/) })
    expect(run.markets.find((m) => m.market === 'IT')!.upgrades?.probes).toMatchObject({ mode: 'shadow', running: 2, started: 2, live: 0, armed: 0 })
    expect(shadowSummaryLine(run)).toMatch(/ · probes \(shadow\): 2 running \(2 new\)/)
    // The same run again: no decision stored, no second probe, the ledger unchanged.
    const before = JSON.stringify(await probes())
    const again = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 60_000), mode: 'shadow' }))
    expect(again.markets.find((m) => m.market === 'IT')!.stored).toBe(0)
    expect(JSON.stringify(await probes())).toBe(before)
  })

  it('a run a day records each day\'s arm; after the last day MEASURING, 3 days later measured — a placebo DONE with each side\'s days, no reading', async () => {
    for (let k = 1; k <= 15; k++) {
      const now = new Date(NOW.getTime() + k * DAY)
      await nextDay(now, 100 + k)
      await inside(() => runShadowOnce({ now, mode: 'shadow' }))
      const ledger = await probes()
      if (k === 6) {
        for (const p of ledger) {
          const days = p.days as Record<string, { arm: string; served: boolean }>
          expect(Object.keys(days)).toHaveLength(7)
          expect(Object.values(days).every((d) => d.served)).toBe(true)
        }
      }
      if (k === 12) expect(ledger.every((p) => p.status === 'MEASURING')).toBe(true)
      if (k === 14) expect(ledger.every((p) => p.status === 'MEASURING')).toBe(true)
    }
    const done = await probes()
    for (const p of done) {
      expect(p.status).toBe('DONE')
      expect(Object.keys(p.days as object)).toHaveLength(12)
      // HLLH counts days 2, 3, 11 and 12 high and days 5–9 low; LHHL the other way round. 10 clicks a day at 44¢.
      const [h, l] = p.sequence === 'HLLH' ? [4, 5] : [5, 4]
      expect(p.observed).toMatchObject({ H: { days: h, clicks: 10 * h, impressions: 300 * h, costCents: 440 * h }, L: { days: l, clicks: 10 * l, costCents: 440 * l }, washout: 3, notCounted: 0, dispersion: 1, asOf: '2026-10-22' })
      expect(p.reading).toBeNull()
      expect(p.epsPosterior).toBeNull()
      expect(p.epsPrior).toMatchObject({ mean: 0.8 })
    }
    const last = (await decisions({ targetId: 't-it' })).filter((r) => /probe/.test(r.why)).pop()!
    expect(last.why).toMatch(/probe \(shadow\): done — a placebo \(both arms served the same bid\): high \d+¢: 10 clicks a day over [45] days, low \d+¢: 10 over [45], ratio 1 \(1 expected\); no ε reading/)
  })

  it('a DONE live probe\'s reading is read back: the response\'s ε of the keyword rests on it', async () => {
    await inside(() => database.client.bidProbe.create({ data: {
      marketplace: 'IT', campaignId: 'c-off', adGroupId: 'g-c-off', targetId: 't-off', productKey: null, mode: 'LIVE', status: 'DONE', centerCents: 30,
      highCents: 34, lowCents: 26, amplitude: 0.1333, sequence: 'HLLH', startDay: new Date('2026-09-01T00:00:00Z'), endDay: new Date('2026-09-12T00:00:00Z'),
      reading: { eps: 0.5, variance: 0.04 }, epsPrior: { mean: 0.8, sd: 0.4 }, epsPosterior: { mean: 0.56, sd: 0.18 }, why: 'made up', runId: 'test',
    } }))
    const readings = await inside(() => loadProbeReadings('IT', NOW))
    expect([...readings]).toEqual([[null, [{ eps: 0.5, variance: 0.04 }]]])
    await clearDecisions()
    const now = new Date(NOW.getTime() + 16 * DAY)
    await nextDay(now, 116)
    await inside(() => runShadowOnce({ now, mode: 'shadow' }))
    const it = (await decisions({ targetId: 't-it' })).pop()!
    expect(it.why).toMatch(/ · profit-best.*\(ε [\d.]+ ± [\d.]+, 1 probe in the market;/)
  })

  it('on, the campaign enrolled LIVE: its running shadow probe stops, a LIVE probe starts and its arm is the decision, written once as the brain', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_BID_BRAIN_PROBES', 'on')
    // A shadow probe of t-it still running since yesterday (the rest after its first one binds SHADOW only; LIVE has none).
    const start = new Date(NOW.getTime() + 17 * DAY)
    await nextDay(start, 117)
    await inside(async () => {
      await database.client.bidProbe.create({ data: {
        marketplace: 'IT', campaignId: 'c-it', adGroupId: 'g-c-it', targetId: 't-it', mode: 'SHADOW', status: 'RUNNING', centerCents: 45, highCents: 50, lowCents: 40,
        amplitude: 0.1111, sequence: 'HLLH', startDay: new Date('2026-10-23T00:00:00Z'), endDay: new Date('2026-11-03T00:00:00Z'),
        days: { '2026-10-23': { arm: 'H', bidCents: 50, served: true } }, why: 'made up', runId: 'test',
      } })
      await setAutonomy('AUTO', 'test')
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: start })
    })
    await clearDecisions()
    const run = await inside(() => runShadowOnce({ now: start, mode: 'live' }))
    const it = run.markets.find((m) => m.market === 'IT')!
    expect(it.owned).toBe(1)
    expect((await probes()).find((p) => p.mode === 'SHADOW' && p.startDay.toISOString().startsWith('2026-10-23'))).toMatchObject({ status: 'STOPPED', stoppedWhy: 'the switch went on: a live probe takes over' })
    const live = (await probes()).filter((p) => p.mode === 'LIVE' && p.targetId === 't-it')
    expect(live).toHaveLength(1)
    const p = live[0]
    expect(p).toMatchObject({ status: 'RUNNING', centerCents: 45, campaignId: 'c-it' })
    const arm = p.sequence[0] === 'H' ? p.highCents : p.lowCents
    const row = (await decisions({ targetId: 't-it' })).pop()!
    expect(row).toMatchObject({ mode: 'LIVE', layer: 'probe', action: 'write', currentCents: 45, decidedCents: arm, step: { fromCents: 45, toCents: arm } })
    expect(row.why).toMatch(/^probe: day 1 of 12, the (high|low) arm \(45¢ [+−] \d+¢\), a washout day; switchback (HLLH|LHHL) from 2026-10-24, budget-neutral: .* \(goal: in band: /)
    expect(row.probe).toMatchObject({ mode: 'LIVE', new: true, picked: expect.stringMatching(/^ε of its product/) })
    expect(row.sent?.sent).toBe('queued')
    const logs = await rows<{ entityId: string; userId: string }>('SELECT "entityId", "userId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = $2', [W, 't-it'])
    expect(logs).toEqual([{ entityId: 't-it', userId: BRAIN_ACTOR }])
    expect((await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', ['t-it']))[0].b).toBe(arm)
    expect(it.upgrades?.probes).toMatchObject({ mode: 'on', live: 1, armed: 1 })
    // t-two's campaign is not owned: its probe stays a shadow one, its decision the goal's.
    expect((await decisions({ targetId: 't-two' })).pop()).toMatchObject({ mode: 'SHADOW', layer: 'band' })
    // The same run again: the arm stands, nothing more is written.
    const again = await inside(() => runShadowOnce({ now: new Date(start.getTime() + 60_000), mode: 'live' }))
    expect(again.markets.find((m) => m.market === 'IT')?.writes?.queued ?? 0).toBe(0)
    expect(await rows('SELECT 1 FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = $2', [W, 't-it'])).toHaveLength(1)
    // It found the arm in place: the day is confirmed (only a confirmed LIVE day counts).
    const confirmed = (await probes()).find((x) => x.id === p.id)!
    expect((confirmed.days as Record<string, unknown>)['2026-10-24']).toEqual({ arm: p.sequence[0], bidCents: arm, served: true, confirmed: true })
  })

  it('the read view: the probes with their keyword, arms and days, and ε per pool', async () => {
    const out = await inside(() => readBidBrain({ view: 'probes', market: 'IT' }))
    expect('data' in out).toBe(true)
    const data = (out as { data: { probesMode: string; probes: Array<Record<string, unknown>>; pools: Array<Record<string, unknown>>; note: string } }).data
    expect(data.probesMode).toBe('on')
    const live = data.probes.find((p) => p.targetId === 't-it' && p.mode === 'LIVE')!
    expect(live).toMatchObject({ keyword: 'race jacket (EXACT)', status: 'RUNNING', centerCents: 45, startDay: '2026-10-24', endDay: '2026-11-04' })
    expect(Object.keys(live.days as object)).toEqual(['2026-10-24'])
    expect(data.probes.find((p) => p.targetId === 't-off')).toMatchObject({ status: 'DONE', reading: { eps: 0.5, sd: 0.2 } })
    expect(data.pools.find((x) => x.market === 'IT' && x.productKey == null)).toMatchObject({ probes: 0, marketProbes: 1, measured: false })
    expect(data.note).toMatch(/^Switchback probes measure how a keyword's clicks answer its bid/)
    const keyword = await inside(() => readBidBrain({ view: 'probes', targetId: 't-two' }))
    expect(((keyword as { data: { probes: unknown[] } }).data.probes).length).toBeGreaterThan(0)
  })

  it('another business reads none of it', async () => {
    const [ledger, readings, view] = await inside(async () => [
      await loadProbeLedger('IT', NOW), await loadProbeReadings('IT', NOW), await readBidBrain({ view: 'probes', market: 'IT' }),
    ] as const, OTHER)
    expect(ledger.records).toEqual([])
    expect(readings.size).toBe(0)
    expect((view as { data: { probes: unknown[] } }).data.probes).toEqual([])
  })
})
