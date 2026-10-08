/**
 * ONE BRAIN AB-11 — the harvest's cron (jobs/ads-brain-harvest.job.ts): registered through lib/cron/clustered.ts daily at
 * 05:25 UTC (after the term ledger's 05:05); a tick with nothing due runs only the prune and records no run; a due tick
 * runs the harvest once inside a recorded run; a failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const zero = { decided: { pairs: 0, newCampaigns: 0, held: 0 }, acted: { logged: 0, proposed: 0, written: 0, campaignsProposed: 0 }, pending: { synced: 0, completed: 0, retried: 0, judged: 0, undoProposed: 0 } }
  return {
    due: { due: false, why: 'no product is enrolled in the brain: no harvest to decide', products: [] as unknown[] },
    run: vi.fn(async (opts: { due: { due: boolean; why: string } }) => (opts.due.due
      ? { ran: true, why: opts.due.why, products: 1, markets: ['IT'], ...zero, decided: { pairs: 2, newCampaigns: 0, held: 1 }, skipped: [], pruned: 0 }
      : { ran: false, why: opts.due.why, products: 0, markets: [], ...zero, skipped: [], pruned: 0 })),
    recorded: [] as Array<{ job: string; summary: unknown }>,
    schedules: [] as Array<{ expr: string; options: unknown }>,
  }
})
vi.mock('../services/advertising/brain/harvest-load.js', () => ({ harvestDue: vi.fn(async () => h.due) }))
vi.mock('../services/advertising/brain/harvest-run.js', () => ({
  runHarvestOnce: h.run,
  harvestSummaryLine: (s: { decided: { pairs: number } }) => `pairs=${s.decided.pairs}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { BRAIN_HARVEST_JOB, BRAIN_HARVEST_SCHEDULE, runBrainHarvestTick, startBrainHarvestCron } from './ads-brain-harvest.job.js'

beforeEach(() => { h.run.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-11 — the harvest\'s daily run (cron)', () => {
  it('is registered through the clustered cron, daily at 05:25 UTC (after the ledger), with a lock that outlives a slow run', () => {
    startBrainHarvestCron()
    startBrainHarvestCron()
    expect(h.schedules).toEqual([{ expr: '25 5 * * *', options: { lockTtlMs: 1_200_000 } }])
    expect(BRAIN_HARVEST_SCHEDULE).toBe('25 5 * * *')
  })

  it('no-op: nothing due — only the prune runs (inside the run, with the due it was handed), no run is recorded', async () => {
    h.due = { due: false, why: 'no product is enrolled in the brain: no harvest to decide', products: [] }
    expect(await runBrainHarvestTick()).toMatchObject({ ran: false })
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0]).toMatchObject({ due: { due: false } })
    expect(h.recorded).toEqual([])
  })

  it('due: the harvest runs once inside a recorded run', async () => {
    h.due = { due: true, why: '1 product with the harvest lever at OBSERVE or higher', products: [{}] }
    const at = new Date('2026-10-09T05:25:00Z')
    expect(await runBrainHarvestTick(at)).toMatchObject({ ran: true, decided: { pairs: 2 } })
    expect(h.run).toHaveBeenCalledWith({ now: at, due: h.due })
    expect(h.recorded).toEqual([{ job: BRAIN_HARVEST_JOB, summary: 'pairs=2' }])
  })

  it('a failed run is logged and answers null: the scheduler never sees it throw', async () => {
    h.due = { due: true, why: 'due', products: [{}] }
    h.run.mockRejectedValueOnce(new Error('database away'))
    expect(await runBrainHarvestTick()).toBeNull()
  })
})
