/**
 * ONE BRAIN AB-9 — the term ledger's cron (jobs/ads-brain-terms.job.ts): registered through lib/cron/clustered.ts daily at
 * 05:05 UTC; a tick with nothing due runs only the prune and records no run; a due tick runs the shadow once inside a
 * recorded run; a failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  due: { due: false, why: 'no product is enrolled in the brain: no term to decide', products: [] as unknown[] },
  run: vi.fn(async (opts: { due: { due: boolean; why: string } }) => (opts.due.due
    ? { ran: true, why: opts.due.why, products: 1, markets: ['IT'], terms: 12, byState: { WATCH: 12 }, ledger: { created: 12, changed: 0, unchanged: 0, removed: 0 }, leads: 1, skipped: [], sharedCampaigns: 0, pruned: 0 }
    : { ran: false, why: opts.due.why, products: 0, markets: [], terms: 0, byState: {}, ledger: { created: 0, changed: 0, unchanged: 0, removed: 0 }, leads: 0, skipped: [], sharedCampaigns: 0, pruned: 0 })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedules: [] as Array<{ expr: string; options: unknown }>,
}))
vi.mock('../services/advertising/brain/terms-shadow.js', () => ({
  termsDue: vi.fn(async () => h.due),
  runTermsOnce: h.run,
  termsSummaryLine: (s: { terms: number }) => `terms=${s.terms}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { BRAIN_TERMS_JOB, BRAIN_TERMS_SCHEDULE, runBrainTermsTick, startBrainTermsCron } from './ads-brain-terms.job.js'

beforeEach(() => { h.run.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-9 — the term ledger\'s daily shadow run (cron)', () => {
  it('is registered through the clustered cron, daily at 05:05 UTC, with a lock that outlives a slow run', () => {
    startBrainTermsCron()
    startBrainTermsCron()
    expect(h.schedules).toEqual([{ expr: '5 5 * * *', options: { lockTtlMs: 900_000 } }])
    expect(BRAIN_TERMS_SCHEDULE).toBe('5 5 * * *')
  })

  it('no-op: nothing due — only the prune runs (inside the run, with the due it was handed), no run is recorded', async () => {
    h.due = { due: false, why: 'no product is enrolled in the brain: no term to decide', products: [] }
    expect(await runBrainTermsTick()).toMatchObject({ ran: false, terms: 0 })
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0]).toMatchObject({ due: { due: false } })
    expect(h.recorded).toEqual([])
  })

  it('due: the shadow runs once inside a recorded run', async () => {
    h.due = { due: true, why: '1 product with the negatives or harvest lever at OBSERVE or higher', products: [{}] }
    const at = new Date('2026-10-09T05:05:00Z')
    expect(await runBrainTermsTick(at)).toMatchObject({ ran: true, terms: 12 })
    expect(h.run).toHaveBeenCalledWith({ now: at, due: h.due })
    expect(h.recorded).toEqual([{ job: BRAIN_TERMS_JOB, summary: 'terms=12' }])
  })

  it('a failed run is logged and answers null: the scheduler never sees it throw', async () => {
    h.due = { due: true, why: 'due', products: [{}] }
    h.run.mockRejectedValueOnce(new Error('database away'))
    expect(await runBrainTermsTick()).toBeNull()
  })
})
