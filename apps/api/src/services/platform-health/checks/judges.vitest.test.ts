/**
 * Platform health watchdog — every check's judge, on fixture facts, healthy and failing. Pure: no database (the gathers
 * are proven on PGlite in platform-health.vitest.test.ts). Each failing fixture is one of the faults of 2026-10-07 the
 * watchdog exists to catch within a day:
 *
 *   cron-runs          the scheduler died at 03:20 UTC: every job due after it skipped, runs in flight never ended
 *   processes          a restart under the same deployment (an out-of-memory kill), and a worker with no heartbeat
 *   ads-daily-reports  one market's dataAsOf days behind; a live market with no report at all
 *   ads-report-feeds   spend in the hourly feed with no daily report (a contradiction)
 *   sqp-feed           24 of 30 Brand Analytics requests refused under a SUCCESS row; IT with no new week for weeks
 *   economics-feed     the Data Kiosk feed 11 days behind
 *   keyword-rank-feed  readings far behind the SQP weeks they are made from
 *   ads-writes         writes refused by the gate counted as applied elsewhere; writes stuck past their hold
 *   queue-drain        the drain cron carrying every write while queue workers are on (BullMQ refusing job ids)
 *   plan-steps         approved steps skipped as "the facts moved" (a basis bug)
 *   ads-rule-gates     every rule that earned AUTO held only by the connection check (the sandbox connection)
 *   ads-engines-idle   engines at AUTO that ran and wrote nothing
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

import { clusters, graceFor, isRegular, judgeCronRuns, judgeProcesses, missedStretches, type CronJobStats } from './scheduler.checks.js'
import { judgeDailyReports, judgeEconomics, judgeKeywordRank, judgeReportFeeds, judgeSqp, parseSqpSummary } from './feeds.checks.js'
import { judgeAdWrites, judgeQueue } from './writes.checks.js'
import { judgeEngines, judgePlanSteps, judgeRuleGates, reasonFamily } from './automation.checks.js'
import type { AdWriteOutcomes } from '../../advertising/ads-write-outcomes.service.js'

const NOW = new Date('2026-10-07T06:20:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (iso: string) => new Date(iso)
const ago = (ms: number) => new Date(NOW.getTime() - ms)

function job(name: string, cadenceMs: number, lastAgoMs: number, extra: Partial<CronJobStats> = {}): CronJobStats {
  return {
    job: name, runs: 100, lastAt: ago(lastAgoMs), medianGapMs: cadenceMs, p80GapMs: cadenceMs, medianDurationMs: 30_000,
    runs24h: Math.round(DAY / cadenceMs), failed24h: 0, lastStatus: 'SUCCESS', lastError: null, longGaps: [], slow: [], ...extra,
  }
}

describe('cron-runs', () => {
  it('a cadence needs history and regularity; grace is half a cadence, 15 min to 1 h', () => {
    expect(graceFor(MIN)).toBe(15 * MIN)
    expect(graceFor(HOUR)).toBe(30 * MIN)
    expect(graceFor(DAY)).toBe(HOUR)
    expect(isRegular(job('a', HOUR, 0))).toBe(true)
    expect(isRegular({ runs: 3, medianGapMs: HOUR, p80GapMs: HOUR })).toBe(false)
    expect(isRegular({ runs: 50, medianGapMs: HOUR, p80GapMs: 3 * HOUR })).toBe(false) // records only when it had work
    expect(isRegular({ runs: 10, medianGapMs: 30 * DAY, p80GapMs: 30 * DAY })).toBe(false) // monthly: not judged
  })

  it('healthy: every job ran on time and finished → ok', () => {
    const v = judgeCronRuns({ jobs: [job('drain-ads-sync', MIN, 20_000), job('sqp-ingest', DAY, 2.5 * HOUR + 35 * MIN), job('ads-report-ingest', HOUR, 10 * MIN)], unfinished: [] }, NOW)
    expect(v.status).toBe('ok')
    expect(v.message).toMatch(/All 3 scheduled jobs/)
  })

  it('the scheduler died at 03:20: jobs due after it skipped, they are named with the moment, runs never ended → fail', () => {
    const stopped = at('2026-10-07T03:20:00.000Z')
    const facts = {
      jobs: [
        // minute and hourly jobs: silent since 03:20, then back at 05:05 (a closed gap in the window)
        job('drain-ads-sync', MIN, NOW.getTime() - at('2026-10-07T06:19:30Z').getTime(), {
          longGaps: [{ at: at('2026-10-07T05:05:00Z'), gapMs: at('2026-10-07T05:05:00Z').getTime() - at('2026-10-07T03:19:00Z').getTime() }],
        }),
        job('alert-evaluator', MIN, 30_000, {
          longGaps: [{ at: at('2026-10-07T05:05:00Z'), gapMs: at('2026-10-07T05:05:00Z').getTime() - at('2026-10-07T03:19:30Z').getTime() }],
        }),
        // daily jobs due at 03:45 and 03:20: their last runs are yesterday's
        job('sqp-ingest', DAY, NOW.getTime() - at('2026-10-06T03:45:00Z').getTime()),
        job('data-kiosk-economics-create', DAY, NOW.getTime() - at('2026-10-06T03:20:00Z').getTime()),
        job('healthy-hourly', HOUR, 15 * MIN),
      ],
      unfinished: [
        { job: 'orders-delivered-backfill', startedAt: at('2026-10-07T03:05:00Z'), swept: true },
        { job: 'ads-report-ingest', startedAt: at('2026-10-07T03:10:00Z'), swept: true },
        { job: 'fba-pan-eu-sync', startedAt: at('2026-10-07T03:15:00Z'), swept: true },
      ],
    }
    const stretches = missedStretches(facts.jobs, NOW)
    expect([...new Set(stretches.map((s) => s.job))].sort()).toEqual(['alert-evaluator', 'data-kiosk-economics-create', 'drain-ads-sync', 'sqp-ingest'])
    expect(stretches.find((s) => s.job === 'sqp-ingest')).toMatchObject({ endedAt: null, missed: 1 })
    const v = judgeCronRuns(facts, NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/stopped at about 03:2\d UTC/)
    expect(v.message).toMatch(/sqp-ingest/)
    expect(v.message).toMatch(/3 runs started and never finished/)
    expect(v.likelyCause).toMatch(/scheduler process stopped/)
    expect(v.nextStep).toMatch(/Railway/)
    expect((v.evidence.stoppedTogether as unknown[]).length).toBeGreaterThan(0)
    expect(stopped.toISOString()).toBe('2026-10-07T03:20:00.000Z')
  })

  it('one job late once, its last run failing, another far slower than usual → warn, each named', () => {
    const v = judgeCronRuns({
      jobs: [
        job('catalog-refresh', HOUR, 10 * MIN, { longGaps: [{ at: ago(5 * HOUR), gapMs: 2.5 * HOUR }] }),
        job('repricer', HOUR, 20 * MIN, { lastStatus: 'FAILED', lastError: 'price 12.50 refused', failed24h: 2 }),
        job('content-drift', DAY, 3 * HOUR, { medianDurationMs: 2 * MIN, slow: [{ at: ago(3 * HOUR), durationMs: 50 * MIN }] }),
      ],
      unfinished: [],
    }, NOW)
    expect(v.status).toBe('warn')
    expect(v.message).toMatch(/1 job missed/)
    expect(v.message).toMatch(/repricer/)
    expect(v.message).toMatch(/content-drift/)
    // never money in evidence: the error's numbers are masked
    expect(JSON.stringify(v.evidence)).not.toMatch(/12\.50/)
  })

  it('a job switched off on purpose is still silent after its cadence: named, and the words say how it clears', () => {
    const v = judgeCronRuns({ jobs: [job('weekly-thing', 7 * DAY, 9 * DAY)], unfinished: [] }, NOW)
    expect(v.status).toBe('warn')
    expect(v.likelyCause).toMatch(/14-day history/)
  })

  it('no run recorded at all: could not measure, never ok', () => {
    expect(judgeCronRuns({ jobs: [], unfinished: [] }, NOW).status).toBe('unknown')
  })

  // C2 (2026-10-10) — jobs quiet by design (utils/cron-quiet.ts).
  it('the settle catch-up\'s 18-hour night is not a miss; a missing 05:20 tick is', () => {
    const night = job('ads-report-settle', HOUR, at('2026-10-07T06:20:00Z').getTime() - at('2026-10-07T05:20:04Z').getTime() + 30_000, {
      longGaps: [{ at: at('2026-10-07T03:20:04Z'), gapMs: 18 * HOUR }],
    })
    expect(missedStretches([night], NOW)).toEqual([])
    expect(judgeCronRuns({ jobs: [night], unfinished: [] }, NOW).status).toBe('ok')
    const missed = job('ads-report-settle', HOUR, 17_000, { longGaps: [{ at: ago(17_000), gapMs: 2 * HOUR }] })
    const stretches = missedStretches([missed], NOW)
    expect(stretches).toHaveLength(1)
    expect(stretches[0]).toMatchObject({ job: 'ads-report-settle', missed: 1, endedAt: ago(17_000) })
    expect(stretches[0].firstMissedAt.toISOString()).toBe(new Date(ago(17_000).getTime() - HOUR).toISOString())
  })

  it('a work-only job silent for 40 h is not a miss; its failed last run is still named', () => {
    const silent = job('fulfilment-conversion-confirm', 15 * MIN, 40 * HOUR)
    expect(missedStretches([silent], NOW)).toEqual([])
    expect(judgeCronRuns({ jobs: [silent, job('healthy-hourly', HOUR, 15 * MIN)], unfinished: [] }, NOW).status).toBe('ok')
    const failed = judgeCronRuns({ jobs: [{ ...silent, lastStatus: 'FAILED', lastError: 'report pull refused' }], unfinished: [] }, NOW)
    expect(failed.status).toBe('warn')
    expect(failed.message).toMatch(/fulfilment-conversion-confirm/)
    expect((failed.evidence.quietByDesign as Array<{ job: string; kind: string }>)[0]).toMatchObject({ job: 'fulfilment-conversion-confirm', kind: 'work-only' })
  })

  it('a brain step the product cycle took over: silent for 40 h is not a miss while the cycle runs; once the cycle stops it is', () => {
    const state = job('ads-brain-state', HOUR, 40 * HOUR)
    expect(missedStretches([state, job('ads-brain-cycle', HOUR, 30 * MIN)], NOW)).toEqual([])
    const stopped = missedStretches([state, job('ads-brain-cycle', HOUR, 5 * HOUR)], NOW)
    expect([...new Set(stopped.map((s) => s.job))].sort()).toEqual(['ads-brain-cycle', 'ads-brain-state'])
  })

  it('the bid brain\'s live tick: a 30-minute gap over 06:45 UTC (the full run) is not a miss; the same gap at 08:00 is', () => {
    const over0645 = job('ads-bid-brain-live', 15 * MIN, 10 * MIN, { longGaps: [{ at: at('2026-10-06T07:00:05Z'), gapMs: 30 * MIN + 2_000 }] })
    expect(missedStretches([over0645], NOW)).toEqual([])
    const at0800 = job('ads-bid-brain-live', 15 * MIN, 10 * MIN, { longGaps: [{ at: at('2026-10-06T08:00:05Z'), gapMs: 30 * MIN + 2_000 }] })
    expect(missedStretches([at0800], NOW)).toMatchObject([{ job: 'ads-bid-brain-live', missed: 1 }])
    // Still silent: only the ticks it expects count.
    const stillSilent = job('ads-bid-brain-live', 15 * MIN, NOW.getTime() - at('2026-10-07T05:30:03Z').getTime())
    expect(missedStretches([stillSilent], NOW)).toMatchObject([{ endedAt: null, missed: 2 }]) // 05:45, 06:00 (06:15 inside the grace)
  })

  it('clusters need several different jobs within 30 minutes', () => {
    const items = [{ j: 'a', t: at('2026-10-07T03:20:00Z') }, { j: 'b', t: at('2026-10-07T03:35:00Z') }, { j: 'c', t: at('2026-10-07T03:49:00Z') }, { j: 'd', t: at('2026-10-07T05:00:00Z') }]
    expect(clusters(items, (i) => i.t, (i) => i.j)).toEqual([{ at: at('2026-10-07T03:20:00Z'), jobs: ['a', 'b', 'c'] }])
    expect(clusters(items.slice(0, 2), (i) => i.t, (i) => i.j)).toEqual([])
  })
})

describe('processes', () => {
  const inst = (startedAt: string, deployment: string | null) => ({ instanceId: 'x:1', startedAt, build: { sha: 'abc1234', deployment } })

  it('a restart under the same deployment as the last reading = a crash, not a deploy → warn', () => {
    const v = judgeProcesses({
      unreadable: null,
      scheduler: [inst('2026-10-07T03:21:10.000Z', 'dep-1')],
      worker: [inst('2026-10-05T10:00:00.000Z', 'dep-1')],
      previous: { scheduler: { startedAt: '2026-10-06T03:21:00.000Z', deployment: 'dep-1' }, worker: { startedAt: '2026-10-05T10:00:00.000Z', deployment: 'dep-1' } },
    }, NOW)
    expect(v.status).toBe('warn')
    expect(v.message).toMatch(/scheduler started again at 03:21 UTC under the same deployment/)
    expect((v.evidence.seen as Record<string, unknown>).scheduler).toEqual({ startedAt: '2026-10-07T03:21:10.000Z', deployment: 'dep-1' })
  })

  it('a restart by a new deploy is fine; a worker with no heartbeat is a fail', () => {
    const deployed = judgeProcesses({
      unreadable: null,
      scheduler: [inst('2026-10-07T01:00:00.000Z', 'dep-2')],
      worker: [inst('2026-10-07T01:00:00.000Z', 'dep-2')],
      previous: { scheduler: { startedAt: '2026-10-05T00:00:00.000Z', deployment: 'dep-1' }, worker: { startedAt: '2026-10-05T00:00:00.000Z', deployment: 'dep-1' } },
    }, NOW)
    expect(deployed.status).toBe('ok')
    expect(deployed.message).toMatch(/with a new deploy/)
    const down = judgeProcesses({ unreadable: null, scheduler: [inst('2026-10-01T00:00:00.000Z', 'dep-1')], worker: [], previous: null }, NOW)
    expect(down.status).toBe('fail')
    expect(down.message).toMatch(/No heartbeat from the worker/)
  })

  it('Redis out of reach and nothing read: could not measure', () => {
    expect(judgeProcesses({ unreadable: 'Redis is not configured', scheduler: [], worker: [], previous: null }, NOW).status).toBe('unknown')
  })
})

describe('ads-daily-reports', () => {
  it('current everywhere → ok', () => {
    const v = judgeDailyReports({ markets: [{ market: 'IT', newestDay: '2026-10-06' }, { market: 'DE', newestDay: '2026-10-05' }], liveMarkets: ['IT', 'DE'] }, NOW)
    expect(v.status).toBe('ok')
  })
  it('IT 3 days behind is a warn, 5 days a fail; a live market with no report at all is a fail', () => {
    expect(judgeDailyReports({ markets: [{ market: 'IT', newestDay: '2026-10-04' }], liveMarkets: ['IT'] }, NOW).status).toBe('warn')
    const v = judgeDailyReports({ markets: [{ market: 'IT', newestDay: '2026-10-02' }, { market: 'DE', newestDay: '2026-10-06' }], liveMarkets: ['IT', 'DE', 'FR'] }, NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/IT newest day 2026-10-02 \(5 days behind\)/)
    expect(v.message).toMatch(/FR has no daily report/)
  })
  it('no data and no live connection: could not measure', () => {
    expect(judgeDailyReports({ markets: [], liveMarkets: [] }, NOW).status).toBe('unknown')
  })
  it('C2 — a market not asked (no enabled campaign, no impression in 14 days) is ok and said so; IT with an enabled campaign 5 days late still fails', () => {
    const dormant = judgeDailyReports({ markets: [{ market: 'IT', newestDay: '2026-10-06' }, { market: 'ES', newestDay: '2026-08-21' }], liveMarkets: ['IT', 'ES'], notAsked: ['ES'] }, NOW)
    expect(dormant.status).toBe('ok')
    expect(dormant.message).toMatch(/ES: not asked: no enabled campaign and no impression in 14 days/)
    expect((dormant.evidence.markets as Array<{ market: string; notAsked?: string }>).find((m) => m.market === 'ES')?.notAsked).toMatch(/not asked/)
    const late = judgeDailyReports({ markets: [{ market: 'IT', newestDay: '2026-10-02' }, { market: 'ES', newestDay: '2026-08-21' }], liveMarkets: ['IT', 'ES'], notAsked: ['ES'] }, NOW)
    expect(late.status).toBe('fail')
    expect(late.message).toMatch(/late in 1 market: IT newest day 2026-10-02/)
  })
})

describe('ads-report-feeds', () => {
  const feed = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, label: id, cadence: 'daily', status, lastDataDay: '2026-10-06', lagDays: 1, recentFailures: 0, cronJob: `${id}-job`, ...extra })
  it('feeds current, no contradiction → ok (the feeds with checks of their own are left to them)', () => {
    const v = judgeReportFeeds({ feeds: [feed('search-terms', 'ok'), feed('daily-perf', 'late'), feed('sqp', 'late')], contradictions: [] })
    expect(v.status).toBe('ok')
  })
  it('spend without a daily report is a fail; a late search-term feed a warn', () => {
    expect(judgeReportFeeds({ feeds: [feed('search-terms', 'late', { lagDays: 6 })], contradictions: [] }).status).toBe('warn')
    const v = judgeReportFeeds({ feeds: [feed('search-terms', 'ok')], contradictions: [{ kind: 'spend-without-rows', marketplace: 'IT', date: '2026-10-03', severity: 'critical' }] })
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/IT had ad spend in the hourly feed but no daily report rows/)
  })
})

describe('sqp-feed', () => {
  const summary = 'mode=async · markets=4 dormant=1[FR] (0 ACTIVE listings — self-restoring) · requested=6 failed=24 · aim=yield-ordered(3 exploring) · week=2026-09-20 · rows=0 (collected by sqp-collect) · IT 2/10 · catchUp=1/3 weeks asked: requested=0 deferred=2 [DE 2026-09-13 0/2 2 deferred]'

  it('reads the request pass\'s own summary line, catch-up included', () => {
    expect(parseSqpSummary(summary)).toEqual({ requested: 6, failed: 24, deferred: 2, dormant: ['FR'], skipped: [] })
    expect(parseSqpSummary('mode=async · markets=4 skipped=2[IE,NL] · requested=30 failed=0 deferred=3(not sent — asked again next night)')).toMatchObject({ requested: 30, failed: 0, deferred: 3, skipped: ['IE', 'NL'] })
    expect(parseSqpSummary(null)).toBeNull()
  })

  it('24 of 30 refused under a SUCCESS row → fail, with the numbers', () => {
    const v = judgeSqp({
      markets: [{ market: 'DE', newestWeekStart: '2026-09-20' }, { market: 'IT', newestWeekStart: '2026-09-20' }],
      lastRun: { startedAt: '2026-10-07T03:45:00.000Z', status: 'SUCCESS', text: summary },
      requests24h: { PENDING: 6 },
    }, NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/only 6 of 32 Brand Analytics report requests were created \(24 failed, 2 deferred\)/)
  })

  it('IT with no new week since 08-16 → fail; FR dormant by design is not judged', () => {
    const v = judgeSqp({
      markets: [{ market: 'IT', newestWeekStart: '2026-08-16' }, { market: 'DE', newestWeekStart: '2026-09-20' }, { market: 'FR', newestWeekStart: '2026-07-12' }],
      lastRun: { startedAt: '2026-10-07T03:45:00.000Z', status: 'SUCCESS', text: 'mode=async · markets=3 dormant=1[FR] · requested=30 failed=0 · week=2026-09-20' },
      requests24h: { PENDING: 30 },
    }, NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/IT since the week of 2026-08-16/)
    expect(v.message).not.toMatch(/FR since/)
  })

  it('healthy night and current weeks → ok; no run in 36 h → fail; nothing at all → unknown', () => {
    const ok = judgeSqp({
      markets: [{ market: 'IT', newestWeekStart: '2026-09-20' }],
      lastRun: { startedAt: '2026-10-07T03:45:00.000Z', status: 'SUCCESS', text: 'mode=async · markets=1 · requested=30 failed=0 · week=2026-09-20' },
      requests24h: { PENDING: 30 },
    }, NOW)
    expect(ok.status).toBe('ok')
    expect(judgeSqp({ markets: [{ market: 'IT', newestWeekStart: '2026-09-20' }], lastRun: null, requests24h: {} }, NOW).status).toBe('fail')
    expect(judgeSqp({ markets: [], lastRun: null, requests24h: {} }, NOW).status).toBe('unknown')
  })
})

describe('economics-feed', () => {
  it('11 days behind → fail; current with queries → ok; no rows → unknown', () => {
    const late = judgeEconomics({ markets: [{ market: 'IT', newestDay: '2026-09-26' }], queries48h: { DONE: 2 } }, NOW)
    expect(late.status).toBe('fail')
    expect(late.message).toMatch(/IT \(newest 2026-09-26, 11 days\)/)
    expect(judgeEconomics({ markets: [{ market: 'IT', newestDay: '2026-10-04' }], queries48h: { DONE: 2 } }, NOW).status).toBe('ok')
    const noQueries = judgeEconomics({ markets: [{ market: 'IT', newestDay: '2026-10-04' }], queries48h: {} }, NOW)
    expect(noQueries.status).toBe('warn')
    expect(noQueries.likelyCause).toMatch(/create cron/)
    expect(judgeEconomics({ markets: [], queries48h: {} }, NOW).status).toBe('unknown')
  })
})

describe('keyword-rank-feed', () => {
  it('level with SQP → ok; three weeks behind → fail; no reading at all → warn', () => {
    const sqp = [{ market: 'IT', newestWeekStart: '2026-09-20' }]
    expect(judgeKeywordRank({ sqp, readings: [{ market: 'IT', newestCapturedAt: '2026-09-26T00:00:00.000Z' }] }, NOW).status).toBe('ok')
    expect(judgeKeywordRank({ sqp, readings: [{ market: 'IT', newestCapturedAt: '2026-09-05T00:00:00.000Z' }] }, NOW).status).toBe('fail')
    expect(judgeKeywordRank({ sqp, readings: [] }, NOW).status).toBe('warn')
    expect(judgeKeywordRank({ sqp: [], readings: [] }, NOW).status).toBe('unknown')
  })
  it('C2 — FR whose newest SQP week is older than the feed reads (63 days) is ok and "not fed"; IT 20 days behind still fails', () => {
    const sqp = [{ market: 'FR', newestWeekStart: '2026-08-02' }, { market: 'IT', newestWeekStart: '2026-09-20' }]
    const fed = judgeKeywordRank({ sqp, readings: [{ market: 'IT', newestCapturedAt: '2026-09-26T00:00:00.000Z' }] }, NOW)
    expect(fed.status).toBe('ok')
    expect(fed.message).toMatch(/FR: not fed — its newest Brand Analytics week ended 2026-08-08, which the Brand Analytics check judges/)
    const behind = judgeKeywordRank({ sqp, readings: [{ market: 'IT', newestCapturedAt: '2026-09-06T00:00:00.000Z' }] }, NOW)
    expect(behind.status).toBe('fail')
    expect(behind.message).toMatch(/IT newest reading 2026-09-06/)
    expect(behind.message).not.toMatch(/FR has no reading/)
  })
})

describe('ads-writes', () => {
  const base: AdWriteOutcomes = {
    since: ago(DAY).toISOString(), applied: 40, failed: 0, superseded: 2, refusedByGate: 3, localOnly: 1, cancelledByPerson: 0, open: 0,
    gateStages: [{ stage: 'allowlist', count: 3 }], failures: [], stuck: [], stuckTotal: 0, stuckAfterMinutes: 30,
  }
  it('writes reached Amazon, nothing stuck → ok, with the true split', () => {
    const v = judgeAdWrites(base)
    expect(v.status).toBe('ok')
    expect(v.message).toMatch(/40 of 43 ad writes .* reached Amazon \(3 refused by the write gate: allowlist 3\)/)
  })
  it('every write refused by the gate (none reached Amazon) → fail, naming the gate stage', () => {
    const v = judgeAdWrites({ ...base, applied: 0, refusedByGate: 24, gateStages: [{ stage: 'allowlist', count: 20 }, { stage: 'connection', count: 4 }] })
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/none of the 24 ad writes/)
    expect(v.likelyCause).toMatch(/write gate refuses them \(allowlist 20, connection 4\)/)
  })
  it('a write unsent 3 hours past its hold → fail; half an hour → warn', () => {
    expect(judgeAdWrites({ ...base, stuck: [{ state: 'PENDING', dueAt: ago(3 * HOUR).toISOString(), minutesLate: 180, entityType: 'AD_TARGET' }], stuckTotal: 1 }).status).toBe('fail')
    expect(judgeAdWrites({ ...base, stuck: [{ state: 'PENDING', dueAt: ago(40 * MIN).toISOString(), minutesLate: 40, entityType: 'AD_TARGET' }], stuckTotal: 1 }).status).toBe('warn')
  })
  it('no write at all is not a failure', () => {
    expect(judgeAdWrites({ ...base, applied: 0, refusedByGate: 0, gateStages: [], superseded: 0, localOnly: 0 }).status).toBe('ok')
  })
})

describe('queue-drain', () => {
  it('workers on and the drain carried everything → warn; workers off by design → ok; flag unknown → unknown', () => {
    const v = judgeQueue({ apiQueueWorkers: '1', unknownWhy: null, workerReporting: true, drainProcessed: 57, drainRuns: 30, dispatched: 60 })
    expect(v.status).toBe('warn')
    expect(v.message).toMatch(/The drain cron carried 57 of the 60/)
    expect(judgeQueue({ apiQueueWorkers: '1', unknownWhy: null, workerReporting: true, drainProcessed: 2, drainRuns: 2, dispatched: 60 }).status).toBe('ok')
    expect(judgeQueue({ apiQueueWorkers: null, unknownWhy: null, workerReporting: null, drainProcessed: 60, drainRuns: 30, dispatched: 60 }).status).toBe('ok')
    expect(judgeQueue({ apiQueueWorkers: undefined, unknownWhy: 'no live heartbeat from the api process', workerReporting: null, drainProcessed: 0, drainRuns: 0, dispatched: 0 }).status).toBe('unknown')
  })
})

describe('plan-steps', () => {
  const step = (status: string, reason: string | null = null, tool = 'bulk-ad-bid-change') => ({ status, reason, tool })
  it('reasons group by family, numbers removed', () => {
    expect(reasonFamily('not run — the facts moved since you approved it — bid 0.50 → 0.60')).toBe('the facts moved since it was approved')
    expect(reasonFamily('execution failed: the tool refused it')).toBe('execution failed')
    expect(reasonFamily('not run — a permission was lost: ads.manage')).toBe('not run — a permission was lost')
  })
  it('all ran → ok; a spike of "facts moved" → fail (basis bug)', () => {
    expect(judgePlanSteps({ steps: [step('done'), step('done')] }).status).toBe('ok')
    const v = judgePlanSteps({ steps: [step('done'), ...Array.from({ length: 5 }, () => step('skipped', 'not run — the facts moved since you approved it — bid 0.50 → 0.60'))] })
    expect(v.status).toBe('fail')
    expect(v.likelyCause).toMatch(/basis/)
    expect(JSON.stringify(v.evidence)).not.toMatch(/0\.50/)
  })
  it('a failed step → warn with its reason', () => {
    const v = judgePlanSteps({ steps: [step('done'), step('done'), step('failed', 'execution failed: Amazon said no')] })
    expect(v.status).toBe('warn')
    expect(v.message).toMatch(/execution failed \(1\)/)
  })
})

describe('ads-rule-gates', () => {
  const conn = { id: 'CONNECTION_PRODUCTION', detail: 'IT (the rule\'s market, profile 123): AmazonAdsConnection.mode = sandbox (must be production)' }
  it('every rule that earned AUTO held only by the connection → fail (no rule can reach AUTO)', () => {
    const v = judgeRuleGates({ rules: [{ id: 'r1', name: 'Bid down', failing: [conn] }, { id: 'r2', name: 'Bid up', failing: [conn, { id: 'WRITES_ENABLED', detail: 'x' }] }], unreadable: 0 })
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/2 ads rules earned AUTO/)
    expect(v.message).toMatch(/no rule can reach AUTO/)
  })
  it('one rule held, another open → warn; rules still earning evidence → ok; none → ok', () => {
    expect(judgeRuleGates({ rules: [{ id: 'r1', name: 'A', failing: [conn] }, { id: 'r2', name: 'B', failing: [] }], unreadable: 0 }).status).toBe('warn')
    expect(judgeRuleGates({ rules: [{ id: 'r1', name: 'A', failing: [{ id: 'HAS_MATCHES', detail: 'Zero matches' }, conn] }], unreadable: 0 }).status).toBe('ok')
    expect(judgeRuleGates({ rules: [], unreadable: 0 }).status).toBe('ok')
  })
})

describe('ads-engines-idle', () => {
  const engine = (id: string, verdicts: string[], runs = 600) => ({ id, name: id, level: 'AUTO', runs, writes: 0, verdicts, lastEverAt: null })
  it('engines at AUTO that ran and wrote nothing → warn (fail when all that ran are idle)', () => {
    expect(judgeEngines({ days: 7, engines: [engine('A2', ['never-written']), { ...engine('A3', ['acting']), writes: 9 }], unreadable: [] }).status).toBe('warn')
    expect(judgeEngines({ days: 7, engines: [engine('A2', ['never-written']), engine('A3', ['not-written-in-window'])], unreadable: [] }).status).toBe('fail')
    expect(judgeEngines({ days: 7, engines: [{ ...engine('A3', ['acting']), writes: 9 }], unreadable: [] }).status).toBe('ok')
    expect(judgeEngines({ days: 7, engines: [{ ...engine('A2', []), level: 'PROPOSE' }], unreadable: [] }).status).toBe('ok')
  })
})
