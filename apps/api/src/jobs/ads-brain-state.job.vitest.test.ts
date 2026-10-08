/**
 * ONE BRAIN AB-12 — the state brain's cron (jobs/ads-brain-state.job.ts): a tick decides every product whose state lever
 * is OBSERVE or higher, on the database clock, inside its own recorded run; no such product (production today) → nothing
 * recorded, the 30-day prune still runs; a failure is logged and never thrown; scheduled through the clustered cron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  products: [] as Array<{ productId: string; market: string; level: string }>,
  run: vi.fn(async (_opts: { now: Date }) => ({ runId: 'bs', ran: true, why: '', campaigns: [], failed: [], pruned: 0 })),
  prune: vi.fn(async (_now: Date) => 0),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  dbNow: new Date('2026-10-08T06:50:02Z'),
  schedule: vi.fn((_expr: string, _fn: () => Promise<void>, _opts: unknown) => ({ stop: vi.fn() })),
}))
vi.mock('../services/advertising/brain/state-run.js', () => ({ runStateBrainOnce: h.run, stateSummaryLine: () => 'state run', pruneStateDecisions: h.prune }))
vi.mock('../services/advertising/brain/state-load.js', () => ({ stateWatchProducts: vi.fn(async () => h.products) }))
vi.mock('./ad-rank-defend.job.js', () => ({ dbNow: vi.fn(async () => h.dbNow) }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: h.schedule } }))
// AB-14 — the enrollments the product cycle's switch reads (only while it is on).
const enrolled = vi.hoisted(() => ({ rows: [] as Array<{ productId: string; marketplace: string }>, reads: 0 }))
vi.mock('../db.js', () => ({ default: { adsBrainEnrollment: { findMany: vi.fn(async () => { enrolled.reads++; return enrolled.rows }) } } }))

import { BRAIN_STATE_JOB, BRAIN_STATE_SCHEDULE, runBrainStateTick, startBrainStateCron } from './ads-brain-state.job.js'

const PRODUCT = { productId: 'product-a', market: 'IT', level: 'OBSERVE' }

beforeEach(() => { h.recorded = []; h.run.mockClear(); h.prune.mockClear(); h.products = []; enrolled.rows = []; enrolled.reads = 0 })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-12 — the state brain\'s cron', () => {
  it('a tick with a watched product: one recorded run on the database clock', async () => {
    h.products = [PRODUCT]
    await runBrainStateTick()
    expect(h.recorded).toEqual([{ job: BRAIN_STATE_JOB, summary: 'state run' }])
    expect(h.run).toHaveBeenCalledWith({ now: h.dbNow, products: [PRODUCT] })
  })

  it('no product with the state lever at OBSERVE or higher (production today): nothing decided or recorded; old rows still pruned', async () => {
    await runBrainStateTick()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
    expect(h.prune).toHaveBeenCalledWith(h.dbNow)
  })

  it('a failed run is logged and never thrown; a clock handed in is used as it is', async () => {
    h.products = [PRODUCT]
    h.run.mockRejectedValueOnce(new Error('database away'))
    await expect(runBrainStateTick()).resolves.toBeUndefined()
    const at = new Date('2026-10-08T12:50:00Z')
    await runBrainStateTick(at)
    expect(h.run).toHaveBeenLastCalledWith({ now: at, products: [PRODUCT] })
  })

  it('scheduled hourly at :50 through the clustered cron (hard rule 7), once', () => {
    startBrainStateCron()
    startBrainStateCron()
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.schedule.mock.calls[0][0]).toBe(BRAIN_STATE_SCHEDULE)
    expect(BRAIN_STATE_SCHEDULE).toBe('50 * * * *')
  })

  it('AB-14 — off (the default): the cycle\'s switch reads nothing and the run gets every watched product, as before', async () => {
    h.products = [PRODUCT]
    enrolled.rows = [{ productId: 'product-a', marketplace: 'IT' }]
    await runBrainStateTick()
    expect(h.run).toHaveBeenCalledWith({ now: h.dbNow, products: [PRODUCT] })
    expect(enrolled.reads).toBe(0)
  })

  it('AB-14 — the product cycle on: a product it runs is left here (its state step runs there, hourly); the others as before', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    const other = { productId: 'product-b', market: 'IT', level: 'AUTO' }
    h.products = [PRODUCT, other]
    enrolled.rows = [{ productId: 'product-a', marketplace: 'IT' }]
    await runBrainStateTick()
    expect(h.run).toHaveBeenCalledWith({ now: h.dbNow, products: [other] })
    // Every watched product the cycle's: nothing decided or recorded here, the prune still runs.
    h.run.mockClear()
    h.recorded = []
    enrolled.rows = [{ productId: 'product-a', marketplace: 'IT' }, { productId: 'product-b', marketplace: 'IT' }]
    await runBrainStateTick()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
    expect(h.prune).toHaveBeenCalledWith(h.dbNow)
  })
})
