/**
 * ONE BRAIN AB-7 — one product's money plan in the design's order (budget-plan.ts + budget-portfolio.ts): Product A on
 * 2026-10-08 at 14:00 Rome with a €320 envelope (its own monthly budget) and €10 a day of spend: projected 96.88 % → no
 * raises; the portfolio cap 115 % on its own portfolio; four campaigns stepping down to the pace. The Owner's overrides
 * win (pacing limit, portfolio cap off / amount / lock, N2); a zero-spend product; the plan's fingerprint ignores the
 * readings. Every value is made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { budgetDayMoveBounds } from '../ads-write-gate.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { moneyClock } from './budget-pace.js'
import { planPortfolioCaps, type PortfolioFacts } from './budget-portfolio.js'
import { moneyPlanHash, planProductMoney, type ProductMoneyFacts } from './budget-plan.js'
import { BAND, camp, ov, PRODUCT } from './__fixtures__/budget-facts.js'

const NOW = new Date('2026-10-08T12:00:00Z')
const SPEND = [400, 300, 200, 100]
const PF: PortfolioFacts = { portfolioId: 'pf-x', name: 'Portfolio X', campaignIds: ['c1', 'c2', 'c3', 'c4'], otherCampaigns: 0, lastMonthSpendCents: 30_000, monthSpendCents: 7_500, today: { policy: 'NO_CAP', amountCents: null, inBudget: true } }

function productA(over: Partial<ProductMoneyFacts> = {}, overrides: OverrideRow[] = [], now = NOW): ProductMoneyFacts {
  const s = resolveBrainSettings({ productId: PRODUCT, market: 'IT', enrolled: true, overrides })
  return {
    productId: PRODUCT, name: 'Product A', market: 'IT', currency: 'EUR', clock: moneyClock(now, 'Europe/Rome', 'IT'), enrolled: true,
    settings: { levers: s.levers, values: s.values, excluded: s.excluded },
    envelope: { productId: PRODUCT, cents: 32_000, source: 'own', why: 'its own monthly budget (ads strategy: Product A (IT) v2)' },
    split: { budgetCents: null, budgetFrom: null, fixedCents: 32_000, sharedCents: 0, reserveCents: 0, totalCents: 32_000, why: 'IT has no monthly budget', warnings: [] },
    pace: { dayWeights: null, hourWeights: null, spentCents: 7_000, reportedThroughDay: 7, stream: { gapCents: 0, todayCents: 500 }, runRateCents: 1_000, dayWeightsFrom: 'even', hourCurveFrom: 'even', dataThrough: '2026-10-07' },
    portfolios: [PF],
    campaigns: SPEND.map((sp, i) => camp(`c${i + 1}`, { avgDailySpendCents: sp, todayCents: i < 2 ? 1_500 : 1_000, bidRatio: i === 0 ? 0.9 : i === 1 ? 1.1 : null }, overrides)),
    band: BAND,
    limits: { minCents: 100, maxCents: 100_000_000 },
    warnings: [],
    ...over,
  }
}

describe('AB-7 — one product\'s money plan', () => {
  const plan = planProductMoney(productA(), budgetDayMoveBounds)

  it('the envelope, the pace (96.88 %), the brake (no raises), the levers in shadow', () => {
    expect(plan).toMatchObject({ v: 1, productId: PRODUCT, market: 'IT', month: '2026-10', day: '2026-10-08', enrolled: true })
    expect(plan.levers.budgets).toMatchObject({ effective: 'OBSERVE' })
    expect(plan.envelope).toEqual({ cents: 32_000, source: 'own', why: 'its own monthly budget (ads strategy: Product A (IT) v2)' })
    expect(plan.pace).toMatchObject({ aimPct: 90, aimCents: 28_800, projectedCents: 31_000, pacePct: 96.88, allowanceCents: 906, runRateCents: 1_000, dataThrough: '2026-10-07' })
    expect(plan.brake).toMatchObject({ level: 'hold_raises', abovePct: 95, bidStepPct: null, stop: null })
  })

  it('the portfolio cap: 115 % of the envelope on its own portfolio, which holds the product alone and has no cap today', () => {
    expect(plan.portfolioCap).toMatchObject({ on: true, source: 'envelope', pct: 115, totalCents: 36_800 })
    expect(plan.portfolioCap.portfolios).toEqual([expect.objectContaining({ portfolioId: 'pf-x', capCents: 36_800, sharePct: 100, action: 'set', todayPolicy: 'NO_CAP' })])
    expect(plan.portfolioCap.why).toBe('monthly portfolio cap 115 % of the envelope €320.00 = €368.00: a hard backstop Amazon enforces even if Nexus is down; across 1 portfolio group by last month\'s spend')
  })

  it('the campaigns: four lower today, none raised, none on the ladder; the one line says it all', () => {
    expect(plan.counts).toEqual({ raise: 0, lower: 4, keep: 0, hold: 0, skip: 0, ladder: 0, exceptions: 0 })
    expect(plan.why).toBe('Product A (IT) 2026-10 day 8: envelope €320.00 (own) · projected €310.00 = 96.88 % → brake hold_raises · portfolio cap €368.00 (envelope) · 4 campaigns: 4 lower, 0 raise, 0 keep, 0 hold')
  })

  it('the fingerprint: an hour later the readings drift (c1\'s target, the projection) but the writes do not — the same plan; a changed decision is not', () => {
    const later = planProductMoney(productA({}, [], new Date('2026-10-08T13:00:00Z')), budgetDayMoveBounds)
    expect([later.campaigns[0].targetCents, later.pace.projectedCents]).toEqual([472, 30_958])
    expect(moneyPlanHash(later)).toBe(moneyPlanHash(plan))
    expect(moneyPlanHash(planProductMoney(productA({}, [ov('VALUE', 'portfolioCapPct', 130)]), budgetDayMoveBounds))).not.toBe(moneyPlanHash(plan))
    expect(moneyPlanHash(planProductMoney(productA({}, [ov('LOCK', 'budgets', null, 'c3')]), budgetDayMoveBounds))).not.toBe(moneyPlanHash(plan))
  })

  it('the Owner\'s pacing limit (80 %) moves the aim and what it leaves a day', () => {
    expect(planProductMoney(productA({}, [ov('VALUE', 'paceTargetPct', 80)]), budgetDayMoveBounds).pace).toMatchObject({ aimPct: 80, aimCents: 25_600, allowanceCents: 770 })
  })
})

describe('the brakes in the plan', () => {
  it('> 100 %: bids step down 10 % a day; > 105 %: the weakest campaigns stop first', () => {
    const cut = planProductMoney(productA({ envelope: { productId: PRODUCT, cents: 30_000, source: 'own', why: 'x' } }), budgetDayMoveBounds)
    expect(cut.brake).toMatchObject({ level: 'cut_bids', bidStepPct: -10, stop: null })
    const stop = planProductMoney(productA({ envelope: { productId: PRODUCT, cents: 29_000, source: 'own', why: 'x' } }), budgetDayMoveBounds)
    expect(stop.brake.level).toBe('stop_weakest')
    // No campaign has sales of its own: the biggest spender goes first, until the projection is back to the envelope.
    expect(stop.brake.stop).toEqual([{ campaignId: 'c1', name: 'c1', savesCents: 9_400 }])
  })
})

describe('the Owner\'s own values win', () => {
  it('portfolio cap off (N1) → none; his own amount → his, even below spend (kept, warned); a lock → the brain writes nothing', () => {
    const off = planProductMoney(productA({}, [ov('VALUE', 'portfolioCapOn', false)]), budgetDayMoveBounds).portfolioCap
    expect(off).toMatchObject({ on: false, source: 'off', totalCents: null })
    expect(off.why).toBe('no portfolio cap: portfolioCapOn is off by the Owner\'s product setting (user:owner)')
    const own = planProductMoney(productA({}, [ov('VALUE', 'portfolioCapCents', 50_000)]), budgetDayMoveBounds).portfolioCap
    expect(own).toMatchObject({ source: 'owner-amount', totalCents: 50_000, portfolios: [expect.objectContaining({ capCents: 50_000, action: 'set' })] })
    const low = planProductMoney(productA({}, [ov('VALUE', 'portfolioCapCents', 5_000)]), budgetDayMoveBounds).portfolioCap.portfolios[0]
    expect(low).toMatchObject({ capCents: 5_000, belowSpend: true, action: 'set' })
    expect(low.why).toContain('below this month\'s spend in it plus one day (€85.00): Amazon would stop every campaign in it at once — the Owner\'s amount is kept')
    const pct = planProductMoney(productA({}, [ov('VALUE', 'portfolioCapPct', 130)]), budgetDayMoveBounds).portfolioCap
    expect(pct).toMatchObject({ source: 'envelope', pct: 130, totalCents: 41_600 })
    const locked = planProductMoney(productA({}, [ov('LOCK', 'portfolioCap', { amountCents: 40_000 })]), budgetDayMoveBounds).portfolioCap
    expect(locked).toMatchObject({ source: 'owner-lock', totalCents: 40_000, portfolios: [expect.objectContaining({ action: 'keep' })] })
    expect(locked.why).toContain('it would plan €368.00 (115 % of the envelope)')
  })

  it('the brain\'s own cap below this month\'s spend is raised to it (a lower cap stops everything at once)', () => {
    const p = planPortfolioCaps({ envelopeCents: 6_000, settings: settingsOf(), portfolios: [PF], runRateCents: 1_000 })
    expect(p.portfolios[0]).toMatchObject({ capCents: 8_500, belowSpend: true, action: 'set' })
  })

  it('Amazon already holding the plan\'s cap: keep', () => {
    const p = planPortfolioCaps({ envelopeCents: 32_000, settings: settingsOf(), portfolios: [{ ...PF, today: { policy: 'MONTHLY_RECURRING', amountCents: 36_800, inBudget: true } }], runRateCents: 1_000 })
    expect(p.portfolios[0]).toMatchObject({ action: 'keep', capCents: 36_800 })
  })

  it('N2: a portfolio holding another product\'s campaign, or campaigns in no portfolio, move first; with N2 off they get none', () => {
    const mixed: PortfolioFacts[] = [PF, { ...PF, portfolioId: 'pf-y', name: 'Portfolio Y', campaignIds: ['c-mixed'], otherCampaigns: 1, lastMonthSpendCents: 10_000 }, { ...PF, portfolioId: null, name: null, campaignIds: ['c-loose'], lastMonthSpendCents: 0 }]
    const p = planPortfolioCaps({ envelopeCents: 32_000, settings: settingsOf(), portfolios: mixed, runRateCents: 1_000 })
    expect(p.portfolios.map((x) => [x.portfolioId, x.action, x.capCents])).toEqual([['pf-x', 'set', 27_600], ['pf-y', 'move-first', 9_200], [null, 'move-first', 0]])
    expect(p.totalCents).toBe(36_800)
    const off = planPortfolioCaps({ envelopeCents: 32_000, settings: settingsOf([ov('VALUE', 'ownPortfolio', false)]), portfolios: mixed, runRateCents: 1_000 })
    expect(off.portfolios.map((x) => x.action)).toEqual(['set', 'none', 'none'])
  })

  it('a campaign\'s budget lock and exclusion; the budgets lever OFF on the product is named', () => {
    const p = planProductMoney(productA({}, [ov('LOCK', 'budgets', { dailyBudgetCents: 2_000 }, 'c1'), ov('EXCLUDE', '*', null, 'c2')]), budgetDayMoveBounds)
    expect(p.campaigns.find((c) => c.campaignId === 'c1')).toMatchObject({ action: 'hold', targetCents: 2_000 })
    expect(p.campaigns.find((c) => c.campaignId === 'c2')).toMatchObject({ action: 'skip', targetCents: null })
    expect(p.counts).toMatchObject({ hold: 1, skip: 1, lower: 2 })
    expect(planProductMoney(productA({}, [ov('LEVEL', 'budgets', 'OFF')]), budgetDayMoveBounds).levers.budgets).toMatchObject({ effective: 'OFF' })
  })
})

describe('edge cases', () => {
  it('zero spend: no pace to brake, every campaign left as it is, the cap split by campaign count', () => {
    const zero = productA({
      envelope: { productId: PRODUCT, cents: 10_000, source: 'own', why: 'its own monthly budget' },
      pace: { dayWeights: null, hourWeights: null, spentCents: 0, reportedThroughDay: 7, stream: { gapCents: 0, todayCents: 0 }, runRateCents: 0, dayWeightsFrom: 'even', hourCurveFrom: 'even', dataThrough: '2026-10-07' },
      portfolios: [{ ...PF, lastMonthSpendCents: 0, monthSpendCents: 0 }],
      campaigns: [camp('z1', { avgDailySpendCents: 0 }), camp('z2', { avgDailySpendCents: null })],
    })
    const p = planProductMoney(zero, budgetDayMoveBounds)
    expect(p.pace).toMatchObject({ projectedCents: 0, pacePct: 0 })
    expect(p.brake.level).toBe('none')
    expect(p.counts).toMatchObject({ hold: 2 })
    expect(p.portfolioCap).toMatchObject({ totalCents: 11_500, portfolios: [expect.objectContaining({ capCents: 11_500, action: 'set' })] })
    expect(p.portfolioCap.why).toContain('by their number of campaigns')
  })

  it('no envelope: no pace, no brake, no cap; budgets follow the expected spend alone', () => {
    const p = planProductMoney(productA({ envelope: { productId: PRODUCT, cents: null, source: 'none', why: 'no envelope' } }), budgetDayMoveBounds)
    expect(p).toMatchObject({ pace: { pacePct: null, allowanceCents: null }, brake: { level: 'none' }, portfolioCap: { source: 'none', totalCents: null }, fit: { scale: null } })
    expect(p.campaigns[0].targetCents).toBe(515)
  })

  it('a market with no checked Amazon limits is said (the gate would refuse every write there)', () => {
    expect(planProductMoney(productA({ market: 'SE', limits: null }), budgetDayMoveBounds).warnings).toEqual([expect.stringContaining('no checked Amazon budget limits for SE')])
  })
})

function settingsOf(overrides: OverrideRow[] = []) {
  const s = resolveBrainSettings({ productId: PRODUCT, market: 'IT', enrolled: true, overrides })
  return { on: s.values.portfolioCapOn, pct: s.values.portfolioCapPct, amountCents: s.values.portfolioCapCents, ownPortfolio: s.values.ownPortfolio, lock: s.levers.portfolioCap.lock }
}
