/**
 * ONE BRAIN AB-20 — the retired writers' cron (jobs/ads-brain-retire.job.ts): nothing retired and nothing enrolled (production
 * as it ships) reads two counts and loads nothing more; a retired row → one recorded run that checks it; the scan of ready
 * products only at the first tick of the hour and only with a product enrolled; a failure is logged, never thrown; scheduled
 * every 15 minutes through the clustered cron, once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  retired: 0,
  enrolled: 0,
  loaded: 0,
  run: vi.fn(async (_opts: { now: Date; scan: boolean }) => ({ checked: 1, gaveBack: [], asked: [], wouldAsk: [], failed: [] })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedule: vi.fn((_expr: string, _fn: () => Promise<void>, _opts: unknown) => ({ stop: vi.fn() })),
}))
vi.mock('../services/advertising/brain/retire-run.js', () => {
  h.loaded++
  return { runRetireTick: h.run, retireTickLine: () => 'RETIRE checked=1' }
})
vi.mock('../db.js', () => ({ default: { adsBrainRetirement: { count: vi.fn(async () => h.retired) }, adsBrainEnrollment: { count: vi.fn(async () => h.enrolled) } } }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: h.schedule } }))

import { BRAIN_RETIRE_JOB, BRAIN_RETIRE_SCHEDULE, runBrainRetireTick, startBrainRetireCron } from './ads-brain-retire.job.js'

beforeEach(() => { h.recorded = []; h.run.mockClear(); h.retired = 0; h.enrolled = 0 })

describe('AB-20 — the retired writers\' cron', () => {
  it('nothing retired and nothing enrolled: two counts, the run never loaded, nothing recorded', async () => {
    expect(await runBrainRetireTick(new Date('2026-10-09T06:08:00Z'))).toBeNull()
    expect(h.loaded).toBe(0)
    expect(h.recorded).toEqual([])
  })

  it('a retired row: one recorded run that checks it; the scan only at the first tick of the hour with a product enrolled', async () => {
    h.retired = 2
    await runBrainRetireTick(new Date('2026-10-09T06:23:00Z'))
    expect(h.run).toHaveBeenLastCalledWith({ now: new Date('2026-10-09T06:23:00Z'), scan: false })
    expect(h.recorded).toEqual([{ job: BRAIN_RETIRE_JOB, summary: 'RETIRE checked=1' }])
    await runBrainRetireTick(new Date('2026-10-09T07:08:00Z'))
    expect(h.run).toHaveBeenLastCalledWith({ now: new Date('2026-10-09T07:08:00Z'), scan: false })
    h.enrolled = 1
    await runBrainRetireTick(new Date('2026-10-09T08:08:00Z'))
    expect(h.run).toHaveBeenLastCalledWith({ now: new Date('2026-10-09T08:08:00Z'), scan: true })
  })

  it('nothing retired but a product enrolled: the hourly scan runs; the other ticks read one count', async () => {
    h.enrolled = 1
    expect(await runBrainRetireTick(new Date('2026-10-09T06:38:00Z'))).toBeNull()
    expect(h.run).not.toHaveBeenCalled()
    await runBrainRetireTick(new Date('2026-10-09T06:08:00Z'))
    expect(h.run).toHaveBeenCalledWith({ now: new Date('2026-10-09T06:08:00Z'), scan: true })
  })

  it('a failed run is logged and never thrown', async () => {
    h.retired = 1
    h.run.mockRejectedValueOnce(new Error('database away'))
    await expect(runBrainRetireTick(new Date('2026-10-09T06:23:00Z'))).resolves.toBeNull()
  })

  it('scheduled every 15 minutes through the clustered cron (hard rule 7), once', () => {
    startBrainRetireCron()
    startBrainRetireCron()
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.schedule.mock.calls[0][0]).toBe(BRAIN_RETIRE_SCHEDULE)
    expect(BRAIN_RETIRE_SCHEDULE).toBe('8,23,38,53 * * * *')
  })
})
