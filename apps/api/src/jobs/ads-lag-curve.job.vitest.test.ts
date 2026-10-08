/**
 * BID BRAIN BB-15 — the nightly lag-curve fit's cron (jobs/ads-lag-curve.job.ts): registered once through
 * lib/cron/clustered.ts at 05:10 UTC; with the bid brain off or the nowcast off the tick reads nothing, writes nothing and
 * records no run; otherwise the fit runs once inside a recorded run; a failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fit: vi.fn(async () => ({ markets: [{ market: 'IT', source: 'seed', usable: true, firstSharePct: 70, vintageDays: 3, finalOrders: 4, seeded: true, products: 0, calibration: null }], removed: 0 })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedules: [] as Array<{ expr: string; options: unknown }>,
}))
vi.mock('../services/advertising/bid-brain/lag-curve-store.js', () => ({
  fitLagCurves: h.fit,
  lagFitSummaryLine: (s: { markets: Array<{ market: string }> }) => `markets=${s.markets.map((m) => m.market).join(',')}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { LAG_CURVE_JOB, LAG_CURVE_SCHEDULE, lagFitIdle, runLagCurveTick, startLagCurveCron } from './ads-lag-curve.job.js'

beforeEach(() => { h.fit.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('BB-15 — the nightly lag-curve fit (cron)', () => {
  it('is registered once through the clustered cron, daily at 05:10 UTC, with a lock that outlives a slow fit', () => {
    startLagCurveCron()
    startLagCurveCron()
    expect(h.schedules).toEqual([{ expr: '10 5 * * *', options: { lockTtlMs: 600_000 } }])
    expect(LAG_CURVE_SCHEDULE).toBe('10 5 * * *')
  })

  it('no-op while the bid brain is off, or the nowcast is off: no read, no run recorded', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'off')
    expect(await lagFitIdle()).toMatch(/bid brain is off/)
    expect(await runLagCurveTick()).toBeNull()
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    expect(await lagFitIdle()).toMatch(/nowcast is off/)
    expect(await runLagCurveTick()).toBeNull()
    expect(h.fit).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('by default (the nowcast in shadow) the fit runs once inside a recorded run', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', '')
    const at = new Date('2026-10-09T05:10:00Z')
    expect(await runLagCurveTick(at)).toMatchObject({ markets: [{ market: 'IT', source: 'seed' }] })
    expect(h.fit).toHaveBeenCalledWith({ now: at })
    expect(h.recorded).toEqual([{ job: LAG_CURVE_JOB, summary: 'markets=IT' }])
  })

  it('a failed fit is logged and answers null: the scheduler never sees it throw', async () => {
    h.fit.mockRejectedValueOnce(new Error('database away'))
    expect(await runLagCurveTick()).toBeNull()
  })
})
