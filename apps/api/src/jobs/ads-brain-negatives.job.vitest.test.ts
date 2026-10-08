/**
 * ONE BRAIN AB-10 — the negatives run's cron (jobs/ads-brain-negatives.job.ts): registered through lib/cron/clustered.ts
 * daily at 05:25 UTC (after the term ledger's 05:05); a tick with nothing due runs only the prune and records no run; a
 * due tick runs once inside a recorded run; a failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  due: { due: false, why: 'no product is enrolled in the brain: no negative to decide', products: [] as unknown[] },
  run: vi.fn(async (opts: { due: { due: boolean; why: string } }) => (opts.due.due
    ? { ran: true, why: opts.due.why, products: 1, markets: ['IT'], planned: 3, byStatus: { SHADOW: 3 }, stored: { created: 3, changed: 0, unchanged: 0 }, proposed: [], skipped: [], pruned: 0 }
    : { ran: false, why: opts.due.why, products: 0, markets: [], planned: 0, byStatus: {}, stored: { created: 0, changed: 0, unchanged: 0 }, proposed: [], skipped: [], pruned: 0 })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedules: [] as Array<{ expr: string; options: unknown }>,
}))
vi.mock('../services/advertising/brain/negatives-run.js', () => ({
  negativesDue: vi.fn(async () => h.due),
  runNegativesOnce: h.run,
  negativesSummaryLine: (s: { planned: number }) => `planned=${s.planned}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { BRAIN_NEGATIVES_JOB, BRAIN_NEGATIVES_SCHEDULE, runBrainNegativesTick, startBrainNegativesCron } from './ads-brain-negatives.job.js'

beforeEach(() => { h.run.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-10 — the negatives run (cron)', () => {
  it('is registered through the clustered cron, daily at 05:25 UTC, with a lock that outlives a slow run', () => {
    startBrainNegativesCron()
    startBrainNegativesCron()
    expect(h.schedules).toEqual([{ expr: '25 5 * * *', options: { lockTtlMs: 900_000 } }])
    expect(BRAIN_NEGATIVES_SCHEDULE).toBe('25 5 * * *')
  })

  it('no-op: nothing due — only the prune runs (inside the run, with the due it was handed), no run is recorded', async () => {
    h.due = { due: false, why: 'no product is enrolled in the brain: no negative to decide', products: [] }
    expect(await runBrainNegativesTick()).toMatchObject({ ran: false, planned: 0 })
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0]).toMatchObject({ due: { due: false } })
    expect(h.recorded).toEqual([])
  })

  it('due: the run happens once inside a recorded run', async () => {
    h.due = { due: true, why: '1 product with the negatives lever at OBSERVE or higher', products: [{}] }
    const at = new Date('2026-10-09T05:25:00Z')
    expect(await runBrainNegativesTick(at)).toMatchObject({ ran: true, planned: 3 })
    expect(h.run).toHaveBeenCalledWith({ now: at, due: h.due })
    expect(h.recorded).toEqual([{ job: BRAIN_NEGATIVES_JOB, summary: 'planned=3' }])
  })

  it('a failed run is logged and answers null: the scheduler never sees it throw', async () => {
    h.due = { due: true, why: 'due', products: [{}] }
    h.run.mockRejectedValueOnce(new Error('database away'))
    expect(await runBrainNegativesTick()).toBeNull()
  })
})
