/**
 * Platform health — the data feeds the ads run decides on, each against its OWN expected lag.
 *
 * Why (2026-10-07): Brand Analytics (SQP) requests were refused 24 of 30 every night since ~08-16 while the cron row said
 * SUCCESS; Italy had no new SQP week from 08-16 to 10-05; the Economics (Data Kiosk) feed was 11 days behind. A job that
 * succeeds can bring back nothing, so these checks read the newest DATA each feed holds, per market — never only the
 * job's status — and, for SQP, what last night's request pass really asked Amazon for.
 *
 *   ads-daily-reports   AmazonAdsDailyPerformance newest day per market (dataAsOf): ≤ 2 days behind is normal
 *   ads-report-feeds    the other ads report feeds and the cross-feed contradictions (ads-pipeline-health.service.ts,
 *                       the same read as ads-overview's "data feeds health")
 *   sqp-feed            SearchQueryPerformance newest complete week per market, and last night's sqp-ingest outcome:
 *                       report requests created against failed or deferred (not sent)
 *   economics-feed      AmazonEconomicsDaily newest day per market, and the Data Kiosk queries of the last 48 h
 *   keyword-rank-feed   KeywordRank's newest Brand Analytics reading per market against the SQP week it is made from
 *
 * Read only. Amounts are never read: these checks count rows and compare dates.
 */
import prisma from '../../../db.js'
import { DAY, HOUR, daysBehind, isoDay, plural, worst, type CheckStatus, type HealthCheck, type Verdict } from '../types.js'

// ── ads-daily-reports ────────────────────────────────────────────────────────────────────────────────

export interface DailyReportFacts {
  /** Newest day of daily ads performance per market (markets with rows in the last 60 days). */
  markets: Array<{ market: string; newestDay: string }>
  /** Markets with an active production ads connection (sandbox connections are not expected to have data). */
  liveMarkets: string[]
}

/** ≤ this many days behind is normal: yesterday lands during the morning. */
const DAILY_OK_DAYS = 2
const DAILY_FAIL_DAYS = 4

export function judgeDailyReports(facts: DailyReportFacts, now: Date): Verdict {
  const byMarket = new Map(facts.markets.map((m) => [m.market, m.newestDay]))
  const all = [...new Set([...facts.markets.map((m) => m.market), ...facts.liveMarkets])].sort()
  if (!all.length) {
    return { status: 'unknown', message: 'Could not measure: this business has no Amazon ads data in 60 days and no live ads connection.', likelyCause: null, nextStep: null, evidence: { markets: [] } }
  }
  const rows = all.map((market) => {
    const newest = byMarket.get(market) ?? null
    const lag = daysBehind(newest, now)
    const status: CheckStatus = newest == null ? 'fail' : lag! >= DAILY_FAIL_DAYS ? 'fail' : lag! > DAILY_OK_DAYS ? 'warn' : 'ok'
    return { market, newestDay: newest, daysBehind: lag, live: facts.liveMarkets.includes(market), status }
  })
  const late = rows.filter((r) => r.status !== 'ok')
  const status = worst(rows.map((r) => r.status))
  return {
    status,
    message: late.length
      ? `The daily ads report is late in ${plural(late.length, 'market')}: ${late.map((r) => (r.newestDay ? `${r.market} newest day ${r.newestDay} (${r.daysBehind} days behind)` : `${r.market} has no daily report in 60 days though its ads connection is live`)).join('; ')}. Normal is at most ${DAILY_OK_DAYS} days.`
      : `The daily ads report is current in every market (${rows.map((r) => `${r.market} ${r.newestDay}`).join(', ')}).`,
    likelyCause: late.length ? 'The ads report jobs did not create, download or ingest that market\'s report: the report jobs failed, the market\'s ads connection lost access, or the scheduler skipped them.' : null,
    nextStep: late.length ? 'Read ads-overview for those markets (data feeds health) and the Scheduled jobs check; until the data is current, no bid or budget change should be made there.' : null,
    evidence: { markets: rows, okWithinDays: DAILY_OK_DAYS, failFromDays: DAILY_FAIL_DAYS },
  }
}

export const dailyReportsCheck: HealthCheck<DailyReportFacts> = {
  id: 'ads-daily-reports',
  subsystem: 'data-feeds',
  title: 'Amazon ads daily reports',
  watches: 'The newest day of Amazon ads performance data in each market is at most 2 days old (the dataAsOf every bid and budget decision rests on).',
  async gather(ctx) {
    const [rows, conns] = await Promise.all([
      prisma.amazonAdsDailyPerformance.groupBy({
        by: ['marketplace'],
        where: { entityType: { in: ['CAMPAIGN', 'PRODUCT_AD'] }, date: { gte: new Date(ctx.now.getTime() - 60 * DAY) } },
        _max: { date: true },
      }),
      prisma.amazonAdsConnection.findMany({ where: { isActive: true, mode: 'production' }, select: { marketplace: true } }),
    ])
    return {
      markets: rows.filter((r) => r._max.date).map((r) => ({ market: r.marketplace, newestDay: isoDay(r._max.date)! })),
      liveMarkets: [...new Set(conns.map((c) => c.marketplace))],
    }
  },
  judge: judgeDailyReports,
}

// ── ads-report-feeds ─────────────────────────────────────────────────────────────────────────────────

export interface ReportFeedFacts {
  feeds: Array<{ id: string; label: string; cadence: string; status: string; lastDataDay: string | null; lagDays: number | null; recentFailures: number; cronJob: string | null }>
  /** Two feeds asserting what cannot both be true (no amounts: kind, market and day only). */
  contradictions: Array<{ kind: string; marketplace: string; date: string; severity: string }>
}

/** These have checks of their own, per market. */
const OWN_CHECK_FEEDS = new Set(['daily-perf', 'sqp', 'economics'])

export function judgeReportFeeds(facts: ReportFeedFacts): Verdict {
  const feeds = facts.feeds.filter((f) => !OWN_CHECK_FEEDS.has(f.id))
  const late = feeds.filter((f) => f.status === 'late' || f.status === 'failing')
  const critical = facts.contradictions.filter((c) => c.severity === 'critical')
  const parts: string[] = []
  if (critical.length) {
    const markets = [...new Set(critical.map((c) => c.marketplace))]
    parts.push(`${plural(critical.length, 'day')} in ${markets.join(', ')} had ad spend in the hourly feed but no daily report rows — one of the two feeds is wrong`)
  }
  for (const f of late) {
    parts.push(f.status === 'failing'
      ? `${f.label}: ${plural(f.recentFailures, 'failed run')} of ${f.cronJob ?? 'its job'} in 3 days`
      : `${f.label} is ${f.lagDays} days behind (newest ${f.lastDataDay}) for a ${f.cadence} feed`)
  }
  const never = feeds.filter((f) => f.status === 'never')
  return {
    status: critical.length ? 'fail' : late.length || facts.contradictions.length ? 'warn' : 'ok',
    message: parts.length
      ? `${parts.join('; ')}.`
      : `The ads report feeds are current (${feeds.filter((f) => f.status === 'ok').map((f) => f.label).join(', ') || 'none active'}) and no two feeds contradict each other.`
        + (never.length ? ` Never produced a row here: ${never.map((f) => f.label).join(', ')}.` : ''),
    likelyCause: critical.length
      ? 'The daily report for those days was never ingested (a report job failed or was dropped) while the ads ran.'
      : late.length ? 'The feed\'s report job failed or stopped bringing rows back.' : null,
    nextStep: parts.length ? 'Open ads-overview (data feeds health) for the feed and its last runs; a missing day can be fetched again from the Sync Logs hub with Run now on its report job.' : null,
    evidence: {
      feeds: feeds.map((f) => ({ id: f.id, label: f.label, status: f.status, lastDataDay: f.lastDataDay, lagDays: f.lagDays, recentFailures: f.recentFailures })),
      contradictions: facts.contradictions.slice(0, 30),
    },
  }
}

export const reportFeedsCheck: HealthCheck<ReportFeedFacts> = {
  id: 'ads-report-feeds',
  subsystem: 'data-feeds',
  title: 'Amazon ads report feeds',
  watches: 'Search terms, targeting, placement, hourly and brand metrics feeds are within their own cadence, and no two feeds contradict each other (spend without a report).',
  async gather() {
    const { pipelineHealth } = await import('../../advertising/ads-pipeline-health.service.js')
    const health = await pipelineHealth()
    return {
      feeds: health.feeds.map((f) => ({ id: f.id, label: f.label, cadence: f.cadence, status: f.status, lastDataDay: f.lastDataDay, lagDays: f.lagDays, recentFailures: f.recentFailures, cronJob: f.cronJob })),
      contradictions: health.contradictions.map((c) => ({ kind: c.kind, marketplace: c.marketplace, date: c.date, severity: c.severity })),
    }
  },
  judge: judgeReportFeeds,
}

// ── sqp-feed ─────────────────────────────────────────────────────────────────────────────────────────

/** What last night's sqp-ingest request pass said it did (its own summary line, or the error it threw). */
export interface SqpPassOutcome {
  requested: number
  failed: number
  deferred: number
  dormant: string[]
  skipped: string[]
}

/** PURE. The counts in sqp-ingest's summary (or its thrown message, which carries the same summary). */
export function parseSqpSummary(text: string | null | undefined): SqpPassOutcome | null {
  if (!text) return null
  const main = /·\s*requested=(\d+) failed=(\d+)(?: deferred=(\d+))?/.exec(text)
  if (!main) return null
  const catchUp = /catchUp=[^[]*?requested=(\d+)(?: deferred=(\d+))?(?: failed=(\d+))?/.exec(text)
  const list = (re: RegExp) => (re.exec(text)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    requested: Number(main[1]) + Number(catchUp?.[1] ?? 0),
    failed: Number(main[2]) + Number(catchUp?.[3] ?? 0),
    deferred: Number(main[3] ?? 0) + Number(catchUp?.[2] ?? 0),
    dormant: list(/dormant=\d+\[([A-Z,]+)\]/),
    skipped: list(/skipped=\d+\[([A-Z,]+)\]/),
  }
}

export interface SqpFacts {
  /** Newest complete WEEK held per market (markets with a week in the last 180 days). */
  markets: Array<{ market: string; newestWeekStart: string }>
  /** The newest sqp-ingest run of the last 36 h, or null. */
  lastRun: { startedAt: string; status: string; text: string | null } | null
  /** SqpReportRequest rows of the last 24 h by status (INGESTED is the only success). */
  requests24h: Record<string, number>
}

const SQP_WARN_DAYS = 21
const SQP_FAIL_DAYS = 28

export function judgeSqp(facts: SqpFacts, now: Date): Verdict {
  if (!facts.markets.length && !facts.lastRun) {
    return { status: 'unknown', message: 'Could not measure: this business holds no Brand Analytics (SQP) week and sqp-ingest did not run in 36 h.', likelyCause: null, nextStep: null, evidence: {} }
  }
  const pass = parseSqpSummary(facts.lastRun?.text)
  const excluded = new Set([...(pass?.dormant ?? []), ...(pass?.skipped ?? [])])
  const statuses: CheckStatus[] = []
  const parts: string[] = []
  let likelyCause: string | null = null

  // Last night's request pass.
  if (!facts.lastRun) {
    statuses.push('fail')
    parts.push('sqp-ingest did not run in the last 36 h')
    likelyCause = 'The scheduler skipped it (see Scheduled jobs) or it is switched off (NEXUS_DISABLE_SQP_INGEST_CRON).'
  } else if (facts.lastRun.status === 'RUNNING') {
    statuses.push('warn')
    parts.push(`sqp-ingest started at ${facts.lastRun.startedAt.slice(11, 16)} UTC and has not finished`)
  } else if (facts.lastRun.status === 'FAILED') {
    statuses.push('fail')
    parts.push(`sqp-ingest failed last night: ${(facts.lastRun.text ?? 'no message').slice(0, 220)}`)
    likelyCause = 'The request pass created no report request (Amazon or the channel gateway refused them, or no market was eligible).'
  }
  let outcome: Record<string, unknown> | null = null
  if (pass) {
    const asked = pass.requested + pass.failed + pass.deferred
    const notSent = pass.failed + pass.deferred
    const share = asked ? notSent / asked : 0
    outcome = { requested: pass.requested, failed: pass.failed, deferred: pass.deferred, asked, notSentShare: Math.round(share * 100) / 100, dormant: pass.dormant, skipped: pass.skipped }
    if (asked >= 4 && share >= 0.5) {
      statuses.push('fail')
      parts.push(`last night only ${pass.requested} of ${asked} Brand Analytics report requests were created (${pass.failed} failed, ${pass.deferred} deferred)`)
      likelyCause ??= 'Amazon\'s createReport rate limit (or the gateway\'s bucket) refused most requests: the pass asks faster than the account allows, or the window ran out.'
    } else if (notSent >= 2 && share >= 0.2) {
      statuses.push('warn')
      parts.push(`last night ${notSent} of ${asked} report requests were not created (${pass.failed} failed, ${pass.deferred} deferred to the next night)`)
    }
  }
  const reqFailed = (facts.requests24h.FATAL ?? 0) + (facts.requests24h.ERROR ?? 0) + (facts.requests24h.CANCELLED ?? 0)
  const reqTotal = Object.values(facts.requests24h).reduce((a, b) => a + b, 0)
  if (reqTotal >= 4 && reqFailed / reqTotal >= 0.5) {
    statuses.push('warn')
    parts.push(`${reqFailed} of ${reqTotal} report requests of the last 24 h ended FATAL, ERROR or CANCELLED at Amazon`)
  }

  // The newest complete week per market.
  const markets = facts.markets.map((m) => {
    const lag = daysBehind(m.newestWeekStart, now)!
    const status: CheckStatus = excluded.has(m.market) ? 'ok' : lag > SQP_FAIL_DAYS ? 'fail' : lag > SQP_WARN_DAYS ? 'warn' : 'ok'
    return { market: m.market, newestWeekStart: m.newestWeekStart, daysBehind: lag, status, notAsked: excluded.has(m.market) ? (pass?.dormant.includes(m.market) ? 'dormant (0 active listings)' : 'skipped (no ASIN)') : null }
  })
  const late = markets.filter((m) => m.status !== 'ok')
  if (late.length) {
    statuses.push(...late.map((m) => m.status))
    parts.push(`no new SQP week in ${late.map((m) => `${m.market} since the week of ${m.newestWeekStart} (${m.daysBehind} days)`).join(', ')}`)
    likelyCause ??= 'Requests for that market are not created or not collected: the market comes last when requests run out, or sqp-collect does not ingest what Amazon finished.'
  }
  const status = statuses.length ? worst(statuses) : 'ok'
  return {
    status,
    message: parts.length
      ? `${parts.join('; ')}.`
      : `Brand Analytics is current: ${markets.map((m) => `${m.market} week of ${m.newestWeekStart}`).join(', ')}${pass ? `; last night ${pass.requested} report requests were created, none refused` : ''}.`,
    likelyCause: status === 'ok' ? null : likelyCause,
    nextStep: status === 'ok' ? null : 'Read sqp-ingest\'s and sqp-collect\'s last runs on the Sync Logs hub (their summaries name each market); run sqp-collect now if reports are DONE and not ingested.',
    evidence: {
      markets,
      lastRun: facts.lastRun ? { startedAt: facts.lastRun.startedAt, status: facts.lastRun.status } : null,
      lastNight: outcome,
      requests24h: facts.requests24h,
      warnAfterDays: SQP_WARN_DAYS,
      failAfterDays: SQP_FAIL_DAYS,
    },
  }
}

async function sqpNewestWeeks(now: Date): Promise<Array<{ market: string; newestWeekStart: string }>> {
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace'],
    where: { reportPeriod: 'WEEK', startDate: { gte: new Date(now.getTime() - 180 * DAY) } },
    _max: { startDate: true },
  })
  return rows.filter((r) => r._max.startDate).map((r) => ({ market: r.marketplace, newestWeekStart: isoDay(r._max.startDate)! })).sort((a, b) => a.market.localeCompare(b.market))
}

export const sqpFeedCheck: HealthCheck<SqpFacts> = {
  id: 'sqp-feed',
  subsystem: 'data-feeds',
  title: 'Brand Analytics (SQP) feed',
  watches: 'Each market holds a recent complete Brand Analytics week, and last night\'s request pass created its report requests instead of having them refused or deferred.',
  async gather(ctx) {
    const [markets, lastRun, requests] = await Promise.all([
      ctx.memo('sqp-weeks', () => sqpNewestWeeks(ctx.now)),
      prisma.cronRun.findFirst({
        where: { jobName: 'sqp-ingest', startedAt: { gte: new Date(ctx.now.getTime() - 36 * HOUR) } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
      }),
      prisma.sqpReportRequest.groupBy({ by: ['status'], where: { requestedAt: { gte: new Date(ctx.now.getTime() - 24 * HOUR) } }, _count: { _all: true } }),
    ])
    return {
      markets,
      lastRun: lastRun ? { startedAt: lastRun.startedAt.toISOString(), status: lastRun.status, text: lastRun.outputSummary ?? lastRun.errorMessage } : null,
      requests24h: Object.fromEntries(requests.map((r) => [r.status, r._count._all])),
    }
  },
  judge: judgeSqp,
}

// ── economics-feed ───────────────────────────────────────────────────────────────────────────────────

export interface EconomicsFacts {
  markets: Array<{ market: string; newestDay: string }>
  /** Data Kiosk economics queries created in the last 48 h, by status. */
  queries48h: Record<string, number>
}

const ECON_WARN_DAYS = 4
const ECON_FAIL_DAYS = 7

export function judgeEconomics(facts: EconomicsFacts, now: Date): Verdict {
  const queries = Object.values(facts.queries48h).reduce((a, b) => a + b, 0)
  if (!facts.markets.length) {
    return {
      status: 'unknown',
      message: `Could not measure: this business holds no Economics (Data Kiosk) day in 120 days${queries ? `, though ${plural(queries, 'query', 'queries')} ran in 48 h` : ''}.`,
      likelyCause: null, nextStep: null, evidence: { queries48h: facts.queries48h },
    }
  }
  const markets = facts.markets.map((m) => {
    const lag = daysBehind(m.newestDay, now)!
    const status: CheckStatus = lag > ECON_FAIL_DAYS ? 'fail' : lag > ECON_WARN_DAYS ? 'warn' : 'ok'
    return { market: m.market, newestDay: m.newestDay, daysBehind: lag, status }
  })
  const late = markets.filter((m) => m.status !== 'ok')
  const fatal = facts.queries48h.FATAL ?? 0
  const statuses: CheckStatus[] = markets.map((m) => m.status)
  const parts: string[] = []
  if (late.length) parts.push(`the Economics feed is behind in ${late.map((m) => `${m.market} (newest ${m.newestDay}, ${m.daysBehind} days)`).join(', ')}`)
  if (queries === 0) { statuses.push(late.length ? 'fail' : 'warn'); parts.push('no Data Kiosk economics query was created in 48 h') }
  if (fatal) { statuses.push('warn'); parts.push(`${plural(fatal, 'Data Kiosk query', 'Data Kiosk queries')} ended FATAL in 48 h`) }
  const status = worst(statuses)
  return {
    status,
    message: parts.length ? `${parts.join('; ')}.` : `Economics is current: ${markets.map((m) => `${m.market} ${m.newestDay}`).join(', ')}.`,
    likelyCause: status === 'ok' ? null : queries === 0
      ? 'The Data Kiosk create cron (data-kiosk-economics-create) did not run or is gated off, so no new day is asked for.'
      : 'Data Kiosk queries are created but not completed or not ingested (FATAL at Amazon, or the poll does not collect them).',
    nextStep: status === 'ok' ? null : 'Read data-kiosk-economics-create and data-kiosk-poll on the Sync Logs hub; profit and true-ACoS figures stay stale until the feed catches up.',
    evidence: { markets, queries48h: facts.queries48h, warnAfterDays: ECON_WARN_DAYS, failAfterDays: ECON_FAIL_DAYS },
  }
}

export const economicsFeedCheck: HealthCheck<EconomicsFacts> = {
  id: 'economics-feed',
  subsystem: 'data-feeds',
  title: 'Economics (Data Kiosk) feed',
  watches: 'Each market\'s newest Economics (Data Kiosk) day is at most 4 days old and new queries are being created.',
  async gather(ctx) {
    const [rows, queries] = await Promise.all([
      prisma.amazonEconomicsDaily.groupBy({ by: ['marketplace'], where: { date: { gte: new Date(ctx.now.getTime() - 120 * DAY) } }, _max: { date: true } }),
      prisma.dataKioskQueryJob.groupBy({ by: ['status'], where: { queryType: 'economics', createdAt: { gte: new Date(ctx.now.getTime() - 48 * HOUR) } }, _count: { _all: true } }),
    ])
    return {
      markets: rows.filter((r) => r._max.date).map((r) => ({ market: r.marketplace, newestDay: isoDay(r._max.date)! })).sort((a, b) => a.market.localeCompare(b.market)),
      queries48h: Object.fromEntries(queries.map((q) => [q.status, q._count._all])),
    }
  },
  judge: judgeEconomics,
}

// ── keyword-rank-feed ────────────────────────────────────────────────────────────────────────────────

export interface KeywordRankFacts {
  sqp: Array<{ market: string; newestWeekStart: string }>
  /** Newest Brand Analytics reading per market (KeywordRank source brand-analytics-sqp). */
  readings: Array<{ market: string; newestCapturedAt: string }>
}

export function judgeKeywordRank(facts: KeywordRankFacts): Verdict {
  if (!facts.sqp.length) {
    return { status: 'unknown', message: 'Could not measure: the keyword-rank feed is made from Brand Analytics weeks, and this business holds none in 180 days.', likelyCause: null, nextStep: null, evidence: { readings: facts.readings } }
  }
  const readings = new Map(facts.readings.map((r) => [r.market, r.newestCapturedAt]))
  const markets = facts.sqp.map((s) => {
    const weekEnd = new Date(Date.parse(`${s.newestWeekStart}T00:00:00Z`) + 6 * DAY)
    const reading = readings.get(s.market) ?? null
    const behind = reading == null ? null : Math.max(0, Math.round((Date.parse(`${isoDay(weekEnd)}T00:00:00Z`) - Date.parse(`${isoDay(reading)}T00:00:00Z`)) / DAY))
    const status: CheckStatus = reading == null ? 'warn' : behind! > 14 ? 'fail' : behind! > 7 ? 'warn' : 'ok'
    return { market: s.market, sqpWeekEnd: isoDay(weekEnd), newestReading: reading ? isoDay(reading) : null, daysBehindSqp: behind, status }
  })
  const behind = markets.filter((m) => m.status !== 'ok')
  return {
    status: worst(markets.map((m) => m.status)),
    message: behind.length
      ? `The keyword-rank feed lags the Brand Analytics weeks Nexus holds: ${behind.map((m) => (m.newestReading ? `${m.market} newest reading ${m.newestReading}, SQP week ends ${m.sqpWeekEnd}` : `${m.market} has no reading although SQP holds the week ending ${m.sqpWeekEnd}`)).join('; ')}.`
      : `The keyword-rank feed is level with Brand Analytics in every market (${markets.map((m) => `${m.market} ${m.newestReading}`).join(', ')}).`,
    likelyCause: behind.length ? 'keyword-rank-feed did not run, or found no bid-on keyword in the newer weeks.' : null,
    nextStep: behind.length ? 'Read keyword-rank-feed\'s last run on the Sync Logs hub, and press Run now (it calls no Amazon API).' : null,
    evidence: { markets },
  }
}

export const keywordRankFeedCheck: HealthCheck<KeywordRankFacts> = {
  id: 'keyword-rank-feed',
  subsystem: 'data-feeds',
  title: 'Keyword rank feed',
  watches: 'The Keyword Tracker\'s search-volume readings keep up with the newest Brand Analytics week of each market.',
  async gather(ctx) {
    const [sqp, rows] = await Promise.all([
      ctx.memo('sqp-weeks', () => sqpNewestWeeks(ctx.now)),
      prisma.keywordRank.groupBy({ by: ['marketplace'], where: { source: 'brand-analytics-sqp', capturedAt: { gte: new Date(ctx.now.getTime() - 180 * DAY) } }, _max: { capturedAt: true } }),
    ])
    return { sqp, readings: rows.filter((r) => r._max.capturedAt).map((r) => ({ market: r.marketplace, newestCapturedAt: r._max.capturedAt!.toISOString() })) }
  },
  judge: judgeKeywordRank,
}

