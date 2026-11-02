/**
 * The overdue-cron alert reads the newest runs of each job, not every run of the 14 days (2026-11-02, the largest item on
 * the database bill). This runs the real statement on real PostgreSQL. The rules for which rows count as "it ran" stay in
 * alert-evaluator.overdue-status.p18.vitest.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await original<any>(), default: state.db.client, prisma: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { detectOverdueCrons, overdueCronJobs, OVERDUE_RUNS_PER_JOB, recentCompletedCronRuns } from './alert-evaluator.service.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date('2026-11-02T12:00:00.000Z').getTime()
const SINCE = new Date(NOW - 14 * DAY)
const scoped = <T>(fn: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, fn)
const seed = (rows: Array<{ jobName: string; status?: string; startedAt: Date }>) =>
  scoped(() => prisma.cronRun.createMany({ data: rows.map(({ jobName, status = 'SUCCESS', startedAt }) => ({ jobName, status, startedAt })) }))
const every = (jobName: string, last: number, gap: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ jobName, startedAt: new Date(last - i * gap) }))

beforeAll(async () => { await import('@nexus/database') }, 120_000)
afterAll(async () => { await state.db?.close() })
beforeEach(async () => { await scoped(() => prisma.cronRun.deleteMany({})) })

describe('overdue crons read the newest runs of each job', () => {
  it('a job with more runs than the limit gives its newest runs, as dates', async () => {
    await seed(every('busy-job', NOW, 60_000, 120))
    const rows = await scoped(() => recentCompletedCronRuns(SINCE))
    expect(rows).toHaveLength(OVERDUE_RUNS_PER_JOB)
    expect(rows.every((row) => row.startedAt instanceof Date)).toBe(true)
    expect(Math.max(...rows.map((row) => row.startedAt.getTime()))).toBe(NOW)
    expect(Math.min(...rows.map((row) => row.startedAt.getTime()))).toBe(NOW - (OVERDUE_RUNS_PER_JOB - 1) * 60_000)
  })

  it('the limit is per job: a daily job keeps its runs beside a busy job', async () => {
    await seed([...every('busy-job', NOW, 60_000, 120), ...every('daily-job', NOW, DAY, 10)])
    const rows = await scoped(() => recentCompletedCronRuns(SINCE))
    expect(rows.filter((row) => row.jobName === 'busy-job')).toHaveLength(OVERDUE_RUNS_PER_JOB)
    expect(rows.filter((row) => row.jobName === 'daily-job')).toHaveLength(10)
  })

  it('reads completed runs only, and none older than the window', async () => {
    await seed([
      { jobName: 'job', status: 'SUCCESS', startedAt: new Date(NOW - HOUR) },
      { jobName: 'job', status: 'PARTIAL', startedAt: new Date(NOW - 2 * HOUR) },
      { jobName: 'job', status: 'NOT_CONFIGURED', startedAt: new Date(NOW - 3 * HOUR) },
      { jobName: 'job', status: 'FAILED', startedAt: new Date(NOW - 4 * HOUR) },
      { jobName: 'job', status: 'RUNNING', startedAt: new Date(NOW - 5 * HOUR) },
      { jobName: 'job', status: 'SUCCESS', startedAt: new Date(SINCE.getTime() - 1) },
      { jobName: 'job-of-old', status: 'SUCCESS', startedAt: new Date(SINCE.getTime() - DAY) },
    ])
    const rows = await scoped(() => recentCompletedCronRuns(SINCE))
    expect(rows.map((row) => row.startedAt.getTime()).sort((a, b) => b - a)).toEqual([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR])
    expect(rows.every((row) => row.jobName === 'job')).toBe(true)
  })

  it('a job with only failed runs in the window is not read: it has no cadence to judge', async () => {
    await seed([{ jobName: 'failing', status: 'FAILED', startedAt: new Date(NOW - HOUR) }])
    expect(await scoped(() => recentCompletedCronRuns(SINCE))).toEqual([])
  })

  it('the same jobs are overdue as when every run of the 14 days was read', async () => {
    const runs = [
      // Runs: on time.
      ...every('minute-on-time', NOW, 60_000, 20_160),
      ...every('quarter-on-time', NOW, 15 * 60_000, 1_344),
      ...every('daily-on-time', NOW, DAY, 14),
      // Silent past three times the cadence and past its cadence + 2 h.
      ...every('minute-silent', NOW - 3 * HOUR, 60_000, 19_980),
      ...every('quarter-silent', NOW - 4 * HOUR, 15 * 60_000, 1_328),
      ...every('daily-silent', NOW - 4 * DAY, DAY, 10),
      // Silent for less than its threshold.
      ...every('hourly-quiet-for-now', NOW - 2 * HOUR, HOUR, 334),
    ]
    await seed(runs)
    const all = detectOverdueCrons(runs, NOW).sort()
    expect(all).toEqual(['daily-silent', 'minute-silent', 'quarter-silent'])
    expect((await scoped(() => overdueCronJobs(NOW))).sort()).toEqual(all)
  }, 60_000)

  it('the read stays small however long a job has run', async () => {
    await seed(Array.from({ length: 30 }, (_, i) => every(`minute-job-${i}`, NOW, 60_000, 200)).flat())
    expect(await scoped(() => recentCompletedCronRuns(SINCE))).toHaveLength(30 * OVERDUE_RUNS_PER_JOB)
  }, 60_000)
})
