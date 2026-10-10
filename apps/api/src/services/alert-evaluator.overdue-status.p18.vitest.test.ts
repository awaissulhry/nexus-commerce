/**
 * P1.8 re-review (2026-09-24) — which CronRun rows prove a cron RAN, for the overdue-cron alert.
 *
 * A run that finished PARTIAL or NOT_CONFIGURED (the contract run records these since P1.8) still ran on
 * schedule. Counting only SUCCESS made such a job look silent — or, once it had fewer than three SUCCESS
 * rows, dropped it from the alert entirely. FAILED and RUNNING prove nothing about cadence and stay out.
 * The database is stood in and applies the `where` it is given, so the test reads the real query.
 *
 * C2 (2026-10-10) — jobs quiet by design (utils/cron-quiet.ts): a work-only job is never overdue by its silence, a
 * windowed one counts only the ticks it expects, and the alert names the jobs in every channel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<{ jobName: string; status: string; startedAt: Date }>, where: null as any, rules: [] as any[], events: [] as any[] }))
vi.mock('../db.js', () => ({ default: {
  cronRun: {
    findMany: vi.fn(async ({ where }: any) => {
      h.where = where
      const statuses: string[] = typeof where.status === 'string' ? [where.status] : where.status.in
      return h.rows.filter((row) => statuses.includes(row.status) && row.startedAt >= where.startedAt.gte).map(({ jobName, startedAt }) => ({ jobName, startedAt }))
    }),
  },
  alertRule: { findMany: vi.fn(async () => h.rules), update: vi.fn(async () => ({})) },
  alertEvent: { create: vi.fn(async ({ data }: any) => { h.events.push(data); return data }), updateMany: vi.fn(async () => ({ count: 0 })) },
} }))

import { overdueCronJobs, overdueCronsDetail, runAlertEvaluator } from './alert-evaluator.service.js'
import { logger } from '../utils/logger.js'

const HOUR = 3_600_000
const NOW = new Date('2026-09-24T12:00:00.000Z').getTime()
const nightly = (jobName: string, statuses: string[]) =>
  statuses.map((status, i) => ({ jobName, status, startedAt: new Date(NOW - (statuses.length - i) * 24 * HOUR + 6 * HOUR) }))

beforeEach(() => { h.rows = []; h.where = null; h.rules = []; h.events = [] })

describe('overdue crons — a PARTIAL or NOT_CONFIGURED run is proof the job ran', () => {
  it('a nightly job whose last four runs were PARTIAL is NOT overdue', async () => {
    h.rows = nightly('channel-contract-run', ['SUCCESS', 'SUCCESS', 'SUCCESS', 'PARTIAL', 'PARTIAL', 'PARTIAL', 'PARTIAL'])
    expect(await overdueCronJobs(NOW)).toEqual([])
  })
  it('a nightly job that only ever finished NOT_CONFIGURED keeps its cadence (and is judged on it)', async () => {
    h.rows = nightly('channel-contract-run', ['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED'])
    expect(await overdueCronJobs(NOW)).toEqual([])
    // Positive control: the same history, silent for a week, IS overdue.
    h.rows = h.rows.map((row) => ({ ...row, startedAt: new Date(row.startedAt.getTime() - 7 * 24 * HOUR) }))
    expect(await overdueCronJobs(NOW)).toEqual(['channel-contract-run'])
  })
  it('FAILED and RUNNING rows still prove nothing: a job with only those since its last success is overdue', async () => {
    h.rows = [
      ...nightly('some-job', ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']).map((row) => ({ ...row, startedAt: new Date(row.startedAt.getTime() - 7 * 24 * HOUR) })),
      ...nightly('some-job', ['FAILED', 'FAILED', 'RUNNING']),
    ]
    expect(await overdueCronJobs(NOW)).toEqual(['some-job'])
    const statuses: string[] = typeof h.where.status === 'string' ? [h.where.status] : [...h.where.status.in]
    expect(statuses.sort()).toEqual(['NOT_CONFIGURED', 'PARTIAL', 'SUCCESS'])
  })
})

/** Runs of `jobName` at each of these UTC hours (minute :20) on each of these days. */
const atHours = (jobName: string, days: string[], hours: number[], minute = 20) =>
  days.flatMap((d) => hours.map((hr) => ({ jobName, status: 'SUCCESS', startedAt: new Date(`${d}T${String(hr).padStart(2, '0')}:${String(minute).padStart(2, '0')}:03.000Z`) })))
/** Runs of `jobName` every `everyMs` from `from` to `to`. */
const every = (jobName: string, from: number, to: number, everyMs: number) =>
  Array.from({ length: Math.floor((to - from) / everyMs) + 1 }, (_, i) => ({ jobName, status: 'SUCCESS', startedAt: new Date(from + i * everyMs) }))

describe('C2 — overdue crons: jobs quiet by design', () => {
  const WINDOW = [3, 4, 5, 6, 7, 8, 9]
  it('the settle catch-up (03:20–09:20 UTC) is not overdue through its night; silent through its window it is', async () => {
    h.rows = atHours('ads-report-settle', ['2026-09-22', '2026-09-23'], WINDOW)
    expect(await overdueCronJobs(Date.parse('2026-09-24T03:00:00.000Z'))).toEqual([]) // 18 h after 09:20: nothing was due
    expect(await overdueCronJobs(Date.parse('2026-09-24T07:30:00.000Z'))).toEqual(['ads-report-settle']) // 03:20…07:20 missed
  })
  it('a work-only job silent for 40 h is not overdue (it records a run only when it has work)', async () => {
    const end = NOW - 40 * HOUR
    h.rows = every('fulfilment-conversion-confirm', end - 24 * HOUR, end, 15 * 60_000)
    expect(await overdueCronJobs(NOW)).toEqual([])
    // Positive control: a job with no rule and the same history is.
    h.rows = every('some-quarter-hour-job', end - 24 * HOUR, end, 15 * 60_000)
    expect(await overdueCronJobs(NOW)).toEqual(['some-quarter-hour-job'])
  })
  it('a brain step the cycle took over is not overdue while the cycle runs; when the cycle stops, both are', async () => {
    const cycleTo = (end: number) => every('ads-brain-cycle', end - 48 * HOUR, end, HOUR)
    const state = every('ads-brain-state', NOW - 72 * HOUR, NOW - 30 * HOUR, HOUR)
    h.rows = [...state, ...cycleTo(NOW - 20 * 60_000)]
    expect(await overdueCronJobs(NOW)).toEqual([])
    h.rows = [...state, ...cycleTo(NOW - 5 * HOUR)]
    expect((await overdueCronJobs(NOW)).sort()).toEqual(['ads-brain-cycle', 'ads-brain-state'])
  })
  it('the bid brain\'s live tick: the skipped full slot alone is never overdue; silent for 3 h it is', async () => {
    const start = Date.parse('2026-09-24T00:00:03.000Z')
    h.rows = every('ads-bid-brain-live', start, Date.parse('2026-09-24T06:30:03.000Z'), 15 * 60_000).filter((r) => !(r.startedAt.getUTCHours() % 6 === 0 && r.startedAt.getUTCMinutes() >= 45))
    expect(await overdueCronJobs(Date.parse('2026-09-24T06:59:00.000Z'))).toEqual([])
    expect(await overdueCronJobs(Date.parse('2026-09-24T09:40:00.000Z'))).toEqual(['ads-bid-brain-live'])
  })
})

describe('C2 — "Critical cron stopped" names the jobs', () => {
  it('the detail lists every overdue job; none overdue → no detail', () => {
    const d = overdueCronsDetail(['sales-report-ingest', 'review-request-mailer'])!
    expect(d.status).toBe('fail')
    expect(d.message).toMatch(/^2 scheduled jobs have not run for more than three times their usual interval: sales-report-ingest, review-request-mailer\.$/)
    expect(overdueCronsDetail(['a']).message).toMatch(/^1 scheduled job has not run/)
    expect(overdueCronsDetail([])).toBeUndefined()
  })
  it('the minute evaluator carries the names into the channel when the rule fires', async () => {
    // The evaluator reads the real clock: a nightly job whose last run was 4 days ago.
    h.rows = every('sales-report-ingest', Date.now() - 8 * 24 * HOUR, Date.now() - 4 * 24 * HOUR, 24 * HOUR)
    h.rules = [{ id: 'r1', name: 'Critical cron stopped', metric: 'overdueCrons', operator: 'gte', threshold: 1, windowMinutes: 15, channel: null, notificationChannels: ['log'], lastFired: false, lastValue: 0 }]
    const warn = vi.spyOn(logger, 'warn')
    const r = await runAlertEvaluator()
    expect(r.rulesFired).toBe(1)
    expect(h.events[0]).toMatchObject({ ruleId: 'r1', value: 1 })
    const fired = warn.mock.calls.find((c) => c[0] === '[ALERT] rule fired')
    expect((fired?.[1] as { message?: string })?.message).toMatch(/sales-report-ingest/)
    warn.mockRestore()
  })
})
