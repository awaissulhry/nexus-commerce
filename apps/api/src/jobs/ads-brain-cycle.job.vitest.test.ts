/**
 * ONE BRAIN AB-14 — the product cycle's cron (jobs/ads-brain-cycle.job.ts): off (the default) a tick returns at once and
 * loads nothing; on with no product enrolled it prunes and records no run; on with a product enrolled one recorded run on
 * the database clock; a failure is logged, never thrown; scheduled hourly at :55 through the clustered cron, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enrolled: 0,
  loaded: 0,
  run: vi.fn(async (_opts: { now: Date }) => ({ ran: true, why: 'x', dataDay: '2026-10-02', cycles: [], statePasses: [], left: [], pruned: 0 })),
  prune: vi.fn(async (_now: Date) => 0),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  dbNow: new Date('2026-10-09T05:55:01Z'),
  schedule: vi.fn((_expr: string, _fn: () => Promise<void>, _opts: unknown) => ({ stop: vi.fn() })),
}))
vi.mock('../services/advertising/brain/cycle-run.js', () => {
  h.loaded++
  return { runCycleTick: h.run, cycleSummaryLine: () => 'cycle run', pruneCycles: h.prune }
})
vi.mock('../db.js', () => ({ default: { adsBrainEnrollment: { count: vi.fn(async () => h.enrolled) } } }))
vi.mock('./ad-rank-defend.job.js', () => ({ dbNow: vi.fn(async () => h.dbNow) }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: h.schedule } }))

import { BRAIN_CYCLE_JOB, BRAIN_CYCLE_SCHEDULE, runBrainCycleTick, startBrainCycleCron } from './ads-brain-cycle.job.js'

beforeEach(() => { h.recorded = []; h.run.mockClear(); h.prune.mockClear(); h.enrolled = 0 })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-14 — the product cycle\'s cron', () => {
  it('off (the default): the tick returns at once — the cycle\'s run is never loaded, nothing read or recorded', async () => {
    h.enrolled = 3
    expect(await runBrainCycleTick()).toBeNull()
    expect(h.loaded).toBe(0)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('on, nothing enrolled: old cycles pruned on the database clock, nothing run or recorded', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    expect(await runBrainCycleTick()).toBeNull()
    expect(h.prune).toHaveBeenCalledWith(h.dbNow)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('on, a product enrolled: one recorded run on the database clock; a clock handed in is used as it is', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.enrolled = 1
    expect(await runBrainCycleTick()).toMatchObject({ ran: true, dataDay: '2026-10-02' })
    expect(h.run).toHaveBeenCalledWith({ now: h.dbNow })
    expect(h.recorded).toEqual([{ job: BRAIN_CYCLE_JOB, summary: 'cycle run' }])
    const at = new Date('2026-10-09T06:55:00Z')
    await runBrainCycleTick(at)
    expect(h.run).toHaveBeenLastCalledWith({ now: at })
  })

  it('a failed run is logged and never thrown', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.enrolled = 1
    h.run.mockRejectedValueOnce(new Error('database away'))
    await expect(runBrainCycleTick()).resolves.toBeNull()
  })

  it('scheduled hourly at :55 through the clustered cron (hard rule 7), once', () => {
    startBrainCycleCron()
    startBrainCycleCron()
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.schedule.mock.calls[0][0]).toBe(BRAIN_CYCLE_SCHEDULE)
    expect(BRAIN_CYCLE_SCHEDULE).toBe('55 * * * *')
  })
})
