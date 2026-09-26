/**
 * P1.8 re-review (2026-09-24) — which CronRun rows prove a cron RAN, for the overdue-cron alert.
 *
 * A run that finished PARTIAL or NOT_CONFIGURED (the contract run records these since P1.8) still ran on
 * schedule. Counting only SUCCESS made such a job look silent — or, once it had fewer than three SUCCESS
 * rows, dropped it from the alert entirely. FAILED and RUNNING prove nothing about cadence and stay out.
 * The database is stood in and applies the `where` it is given, so the test reads the real query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<{ jobName: string; status: string; startedAt: Date }>, where: null as any }))
vi.mock('../db.js', () => ({ default: { cronRun: {
  findMany: vi.fn(async ({ where }: any) => {
    h.where = where
    const statuses: string[] = typeof where.status === 'string' ? [where.status] : where.status.in
    return h.rows.filter((row) => statuses.includes(row.status) && row.startedAt >= where.startedAt.gte).map(({ jobName, startedAt }) => ({ jobName, startedAt }))
  }),
} } }))

import { overdueCronJobs } from './alert-evaluator.service.js'

const HOUR = 3_600_000
const NOW = new Date('2026-09-24T12:00:00.000Z').getTime()
const nightly = (jobName: string, statuses: string[]) =>
  statuses.map((status, i) => ({ jobName, status, startedAt: new Date(NOW - (statuses.length - i) * 24 * HOUR + 6 * HOUR) }))

beforeEach(() => { h.rows = []; h.where = null })

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
