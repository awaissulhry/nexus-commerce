/**
 * ONE BRAIN AB-7 — the money shadow's hook in the bid brain's cron (jobs/ads-bid-brain.job.ts): at a full slot it plans
 * the money of every product whose budgets lever is OBSERVE or higher, on the database clock, inside its own recorded run;
 * its own lever levels decide, not the bid switch (it runs with the bid brain off); no such product → nothing recorded,
 * the 30-day prune still runs;
 * between the slots it never runs; a failure is logged and never reaches the bid run or the scheduler.
 * AB-8 — between the slots the products whose budgets lever is AUTO (switch live) get their money run, recorded apart;
 * none → nothing recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mode: 'shadow' as 'off' | 'shadow' | 'live',
  products: [] as Array<{ productId: string; market: string; level: string }>,
  live: [] as Array<{ productId: string; market: string; level: string }>,
  money: vi.fn(async (opts: { now: Date }) => ({ runId: 'bm', ran: true, why: '', products: [], failed: [], pruned: 0, now: opts.now })),
  bid: vi.fn(async () => ({ runId: 'bb', mode: 'shadow', markets: [], pruned: 0 })),
  prune: vi.fn(async (_now: Date) => 0),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  dbNow: new Date('2026-10-08T06:45:03Z'),
}))
vi.mock('../services/advertising/bid-brain/shadow.js', () => ({ bidBrainMode: () => h.mode, runShadowOnce: h.bid, shadowSummaryLine: () => 'bid run' }))
vi.mock('../services/advertising/bid-brain/live.js', () => ({ brainOwnedCampaignIds: vi.fn(async () => new Set<string>()) }))
vi.mock('../services/advertising/brain/budget-shadow.js', () => ({
  moneyShadowProducts: vi.fn(async () => h.products),
  moneyLiveProducts: vi.fn(async () => h.live),
  runMoneyShadowOnce: h.money,
  pruneMoneyDecisions: h.prune,
  moneySummaryLine: () => 'money run',
}))
vi.mock('./ad-rank-defend.job.js', () => ({ dbNow: vi.fn(async () => h.dbNow) }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(() => ({ stop: vi.fn() })) } }))

import { BID_BRAIN_JOB, BRAIN_MONEY_JOB, BRAIN_MONEY_LIVE_JOB, runBidBrainCron, runMoneyShadowTick } from './ads-bid-brain.job.js'

const FULL = new Date('2026-10-08T06:45:00Z')
const BETWEEN = new Date('2026-10-08T07:00:00Z')
const PRODUCT = { productId: 'product-a', market: 'IT', level: 'OBSERVE' }

beforeEach(() => { h.recorded = []; h.money.mockClear(); h.bid.mockClear(); h.prune.mockClear(); h.mode = 'shadow'; h.products = []; h.live = [] })

describe('AB-7 — the money shadow in the bid brain\'s cron', () => {
  it('a full slot: the bid run, then the money run on the database clock, each recorded', async () => {
    h.products = [PRODUCT]
    await runBidBrainCron(FULL)
    expect(h.recorded).toEqual([{ job: BID_BRAIN_JOB, summary: 'bid run' }, { job: BRAIN_MONEY_JOB, summary: 'money run' }])
    expect(h.money).toHaveBeenCalledWith({ now: h.dbNow, products: [PRODUCT] })
    expect(BRAIN_MONEY_JOB).toBe('ads-brain-money-shadow')
  })

  it('its own levels decide, not the bid switch: with the bid brain off it still plans', async () => {
    h.mode = 'off'
    h.products = [PRODUCT]
    await runBidBrainCron(FULL)
    expect(h.bid).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([{ job: BRAIN_MONEY_JOB, summary: 'money run' }])
  })

  it('no product with the budgets lever at OBSERVE or higher (production today): nothing planned, nothing recorded; old plans still pruned', async () => {
    await runBidBrainCron(FULL)
    expect(h.money).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([{ job: BID_BRAIN_JOB, summary: 'bid run' }])
    expect(h.prune).toHaveBeenCalledWith(h.dbNow)
  })

  it('between the full slots the money shadow never runs', async () => {
    h.products = [PRODUCT]
    await runBidBrainCron(BETWEEN)
    expect(h.money).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('AB-8 — between the full slots a product whose budgets lever is AUTO (switch live) gets its money run, recorded apart', async () => {
    const auto = { ...PRODUCT, level: 'AUTO' }
    h.products = [auto]
    h.live = [auto]
    await runBidBrainCron(BETWEEN)
    expect(h.money).toHaveBeenCalledWith({ now: h.dbNow, products: [auto], between: true })
    expect(h.recorded).toEqual([{ job: BRAIN_MONEY_LIVE_JOB, summary: 'money run' }])
    expect(BRAIN_MONEY_LIVE_JOB).toBe('ads-brain-money-live')
  })

  it('a failed money run is logged and never thrown; a clock handed in is used as it is', async () => {
    h.products = [PRODUCT]
    h.money.mockRejectedValueOnce(new Error('database away'))
    await expect(runBidBrainCron(FULL)).resolves.toBeUndefined()
    expect(h.recorded).toEqual([{ job: BID_BRAIN_JOB, summary: 'bid run' }])
    const at = new Date('2026-10-08T12:45:00Z')
    await runMoneyShadowTick(at)
    expect(h.money).toHaveBeenLastCalledWith({ now: at, products: [PRODUCT] })
  })
})
