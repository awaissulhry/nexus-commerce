/**
 * ONE BRAIN AB-13 — the hours cron (jobs/ads-brain-hours.job.ts): registered through lib/cron/clustered.ts daily at
 * 04:50 UTC; with no product enrolled a tick researches nothing, writes nothing and records no run; with one it runs the
 * hours once inside a recorded run; NEXUS_ADS_BRAIN_HOURS=0 stops it; a failure is logged, never thrown into the
 * scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enrolled: false,
  run: vi.fn(async () => ({ ran: true, products: 1, stored: 1, proposed: 1, shadow: 0, noChange: 0, held: 0, notDue: 0, off: 0, failed: 0, synced: 0, pruned: 0 })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedules: [] as Array<{ expr: string; options: unknown }>,
}))
vi.mock('../services/advertising/brain/hours-proposal.js', () => ({
  anyProductEnrolled: vi.fn(async () => h.enrolled),
  NOTHING_ENROLLED: { ran: false, why: 'no product is enrolled in the brain: nothing to research' },
  runHoursOnce: h.run,
  hoursSummaryLine: (s: { proposed: number }) => `proposed=${s.proposed}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { BRAIN_HOURS_JOB, BRAIN_HOURS_SCHEDULE, runBrainHoursTick, startBrainHoursCron } from './ads-brain-hours.job.js'

beforeEach(() => { h.run.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-13 — the brain\'s hourly research (cron)', () => {
  it('is registered once through the clustered cron, daily at 04:50 UTC', () => {
    startBrainHoursCron()
    startBrainHoursCron()
    expect(h.schedules).toEqual([{ expr: '50 4 * * *', options: { lockTtlMs: 900_000 } }])
    expect(BRAIN_HOURS_SCHEDULE).toBe('50 4 * * *')
  })

  it('no-op: nothing enrolled — no research, no run recorded (production today)', async () => {
    h.enrolled = false
    expect(await runBrainHoursTick()).toMatchObject({ ran: false, why: expect.stringMatching(/no product is enrolled/) })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('a product enrolled: the hours run once inside a recorded run', async () => {
    h.enrolled = true
    const at = new Date('2026-10-12T04:50:00Z')
    expect(await runBrainHoursTick(at)).toMatchObject({ ran: true, proposed: 1 })
    expect(h.run).toHaveBeenCalledWith({ now: at })
    expect(h.recorded).toEqual([{ job: BRAIN_HOURS_JOB, summary: 'proposed=1' }])
  })

  it('switched off by NEXUS_ADS_BRAIN_HOURS=0; a failure answers null and is never thrown', async () => {
    h.enrolled = true
    vi.stubEnv('NEXUS_ADS_BRAIN_HOURS', '0')
    expect(await runBrainHoursTick()).toBeNull()
    expect(h.run).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
    h.run.mockRejectedValueOnce(new Error('database away'))
    expect(await runBrainHoursTick()).toBeNull()
  })

  it('AB-14 — the product cycle on: it runs every enrolled product\'s hours step, so this tick runs none and records nothing', async () => {
    h.enrolled = true
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    expect(await runBrainHoursTick(new Date('2026-10-12T04:50:00Z'))).toMatchObject({ ran: false, why: expect.stringMatching(/the product cycle runs it/) })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })
})
