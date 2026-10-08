/**
 * ONE BRAIN AB-16 — the structure lever's cron (jobs/ads-brain-structure.job.ts): registered through lib/cron/clustered.ts
 * daily at 05:35 UTC (after the harvest's 05:25); a tick with nothing due runs only the prune and records no run; a due
 * tick runs the structure once inside a recorded run; while the product cycle runs a product, the cron leaves it; a
 * failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const zero = { decided: { skc: 0, split: 0, portfolio: 0, held: 0 }, acted: { logged: 0, proposed: 0 }, pending: { synced: 0, built: 0, liveAsked: 0, live: 0, retireAsked: 0, done: 0, declined: 0, failed: 0 } }
  return {
    due: { due: false, why: 'no product is enrolled in the brain: no structure to decide', products: [] as Array<{ productId: string; market: string }> },
    orchestrated: new Set<string>(),
    run: vi.fn(async (opts: { due: { due: boolean; why: string } }) => (opts.due.due
      ? { ran: true, why: opts.due.why, products: 1, markets: ['IT'], ...zero, decided: { skc: 1, split: 0, portfolio: 0, held: 0 }, notDue: 0, skipped: [], failed: [], pruned: 0 }
      : { ran: false, why: opts.due.why, products: 0, markets: [], ...zero, notDue: 0, skipped: [], failed: [], pruned: 0 })),
    recorded: [] as Array<{ job: string; summary: unknown }>,
    schedules: [] as Array<{ expr: string; options: unknown }>,
  }
})
vi.mock('../services/advertising/brain/structure-load.js', () => ({ structureDue: vi.fn(async () => h.due) }))
vi.mock('../services/advertising/brain/structure-run.js', () => ({
  runStructureOnce: h.run,
  structureSummaryLine: (s: { decided: { skc: number } }) => `skc=${s.decided.skc}`,
}))
vi.mock('../services/advertising/brain/cycle-switch.js', () => ({
  CYCLE_RUNS_IT: 'the product cycle runs it',
  withoutOrchestrated: vi.fn(async <T extends { productId: string; market: string }>(list: readonly T[]) => ({
    kept: list.filter((p) => !h.orchestrated.has(`${p.market}|${p.productId}`)), skipped: list.filter((p) => h.orchestrated.has(`${p.market}|${p.productId}`)),
  })),
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { BRAIN_STRUCTURE_JOB, BRAIN_STRUCTURE_SCHEDULE, runBrainStructureTick, startBrainStructureCron } from './ads-brain-structure.job.js'

beforeEach(() => { h.run.mockClear(); h.recorded = []; h.orchestrated = new Set() })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-16 — the structure lever\'s daily run (cron)', () => {
  it('is registered through the clustered cron, daily at 05:35 UTC (after the harvest), with a lock that outlives a slow run', () => {
    startBrainStructureCron()
    startBrainStructureCron()
    expect(h.schedules).toEqual([{ expr: '35 5 * * *', options: { lockTtlMs: 1_200_000 } }])
    expect(BRAIN_STRUCTURE_SCHEDULE).toBe('35 5 * * *')
  })

  it('no-op: nothing due — only the prune runs (inside the run, with the due it was handed), no run is recorded', async () => {
    h.due = { due: false, why: 'no product is enrolled in the brain: no structure to decide', products: [] }
    expect(await runBrainStructureTick()).toMatchObject({ ran: false })
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0]).toMatchObject({ due: { due: false } })
    expect(h.recorded).toEqual([])
  })

  it('due: the structure runs once inside a recorded run', async () => {
    h.due = { due: true, why: '1 product with the structure lever at OBSERVE, PROPOSE or locked', products: [{ productId: 'jacket', market: 'IT' }] }
    const at = new Date('2026-10-12T05:35:00Z')
    expect(await runBrainStructureTick(at)).toMatchObject({ ran: true, decided: { skc: 1 } })
    expect(h.run).toHaveBeenCalledWith({ now: at, due: h.due })
    expect(h.recorded).toEqual([{ job: BRAIN_STRUCTURE_JOB, summary: 'skc=1' }])
  })

  it('a product the product cycle runs is left to its structure step: nothing due here, no run recorded', async () => {
    h.due = { due: true, why: 'due', products: [{ productId: 'jacket', market: 'IT' }] }
    h.orchestrated = new Set(['IT|jacket'])
    expect(await runBrainStructureTick()).toMatchObject({ ran: false })
    expect(h.run.mock.calls[0][0]).toMatchObject({ due: { due: false, why: '1 due product: the product cycle runs it', products: [] } })
    expect(h.recorded).toEqual([])
  })

  it('a failed run is logged and answers null: the scheduler never sees it throw', async () => {
    h.due = { due: true, why: 'due', products: [{ productId: 'jacket', market: 'IT' }] }
    h.run.mockRejectedValueOnce(new Error('database away'))
    expect(await runBrainStructureTick()).toBeNull()
  })
})
