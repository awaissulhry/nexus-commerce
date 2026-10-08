/**
 * ONE BRAIN AB-7 — each campaign's daily budget, the intraday ladder and the day-move "intraday" exception
 * (budget-campaigns.ts): spend ÷ 70 % inside the pace, the gate's day-move bound for today's step, the holds (paused, no
 * spend, excluded, the Owner's lock, shared, a brake), the ladder's rungs and bounds on the market's clock, and the give-back
 * exception. GALE IT figures from the design (€12.84 a day over 10 campaigns, ACoS 31.6 %); values otherwise made up.
 */
import { describe, expect, it } from 'vitest'
import { budgetDayMoveBounds } from '../ads-write-gate.js'
import type { OverrideRow } from './settings.js'
import { brakeOf } from './budget-pace.js'
import { bandStateOf, dayMoveCheck, ladderRung, planCampaignBudgets, weakestToStop, type CampaignMoneyFacts, type CampaignPlanInput } from './budget-campaigns.js'
import { camp, GALE_BAND, ov } from './__fixtures__/budget-facts.js'

const plan = (campaigns: CampaignMoneyFacts[], over: Partial<CampaignPlanInput> = {}) => planCampaignBudgets({
  campaigns, allowanceCents: null, brake: brakeOf(0, 40_000), ladderHour: 10.75, band: GALE_BAND, limits: { minCents: 100, maxCents: 100_000_000 }, bounds: budgetDayMoveBounds, ...over,
})
const one = (c: CampaignMoneyFacts, over: Partial<CampaignPlanInput> = {}) => plan([c], over).campaigns[0]

describe('AB-7 — GALE IT\'s ten campaigns at 10:45 Rome on 8 October (projected 99.5 % → no raises)', () => {
  const SPEND = [310, 240, 190, 150, 120, 94, 80, 50, 30, 20]
  const gale = SPEND.map((s, i) => camp(`c${String(i + 1).padStart(2, '0')}`, { avgDailySpendCents: s, bidRatio: i === 0 ? 0.92 : i === 1 ? 1.05 : null }))
  const out = plan(gale, { allowanceCents: 1_123, brake: brakeOf(39_804, 40_000) })

  it('expected spend at the goal bids (the bid brain: c01 −8 %, c02 +5 %) is scaled into the pace\'s €11.23 a day, ÷ 70 %, at least Amazon\'s €1', () => {
    expect(out.scale).toBeCloseTo(1_123 / 1_271, 10)
    expect(out.fitWhy).toBe('the own campaigns expect €12.71 a day, more than the pace leaves (€11.23 a day): each is scaled to 88.4 %')
    expect(out.campaigns.map((c) => [c.campaignId, c.expectedSpendCents, c.targetCents])).toEqual([
      ['c01', 285, 360], ['c02', 252, 319], ['c03', 190, 240], ['c04', 150, 190], ['c05', 120, 152],
      ['c06', 94, 119], ['c07', 80, 101], ['c08', 50, 100], ['c09', 30, 100], ['c10', 20, 100],
    ])
    expect(out.campaigns[0].why).toBe('expected €2.85 a day (its average €3.10 × the bid brain\'s goal bids -8 %); scaled to the pace 88.4 % → €2.52; ÷ 70 % use = €3.60; today €14.00: the day-move bound (€14.00–€30.00) lets it move that far today')
    expect(out.campaigns[9].why).toContain('held at the lowest budget €1.00 (Amazon\'s minimum)')
  })

  it('today every €20 budget steps down 30 % to €14 (the gate\'s day-move bound); no ladder under the brake', () => {
    expect(out.campaigns.every((c) => c.action === 'lower' && c.stepCents === 1_400 && c.dayMove.bounded && c.dayMove.floorCents === 1_400 && c.dayMove.ceilCents === 3_000)).toBe(true)
    expect(out.campaigns.every((c) => c.ladder === null && c.ladderWhy === 'no ladder: the pace brake holds raises (hold_raises)')).toBe(true)
    // Each under 3 orders of its own: the product's pooled ACoS 31.6 % — inside the band.
    expect(out.campaigns[0]).toMatchObject({ band: 'in', bandFrom: 'product', acosPct: 31.6 })
  })
})

describe('the target and today\'s step', () => {
  it('within 5 % of today: kept; a raise inside the bound; a raise past it stops at the ceiling (+€10 at the €1 floor)', () => {
    expect(one(camp('k', { todayCents: 400, avgDailySpendCents: 280 }))).toMatchObject({ action: 'keep', targetCents: 400, stepCents: 400 })
    expect(one(camp('k', { todayCents: 390, avgDailySpendCents: 280 }))).toMatchObject({ action: 'keep', targetCents: 400, stepCents: 390 })
    expect(one(camp('r', { todayCents: 300, avgDailySpendCents: 280 }))).toMatchObject({ action: 'raise', targetCents: 400, stepCents: 400, dayMove: { bounded: false } })
    const floor = one(camp('f', { todayCents: 100, avgDailySpendCents: 2_000 }))
    expect(floor).toMatchObject({ action: 'raise', targetCents: 2_858, stepCents: 1_100, dayMove: { ceilCents: 1_100, bounded: true } })
  })

  it('the Owner\'s own min and max budget bound the target; his budgetUsePct (50 %) sizes it', () => {
    expect(one(camp('x', { avgDailySpendCents: 2_000, maxCents: 1_500 }))).toMatchObject({ targetCents: 1_500, stepCents: 1_500, action: 'lower' })
    expect(one(camp('x', { avgDailySpendCents: 2_000, maxCents: 1_500 })).why).toContain('held at the highest budget €15.00 (the Owner\'s maximum)')
    expect(one(camp('m', { todayCents: 600, avgDailySpendCents: 100, minCents: 500 }))).toMatchObject({ targetCents: 500, action: 'lower', stepCents: 500 })
    const half = one(camp('u', { todayCents: 500, avgDailySpendCents: 280 }, [ov('VALUE', 'budgetUsePct', 50, 'u')]))
    expect(half).toMatchObject({ targetCents: 560, action: 'raise' })
    expect(half.why).toContain('÷ 50 % use (the Owner\'s setting) = €5.60')
  })

  it('holds: paused, nothing to size on, excluded (not the brain\'s), the Owner\'s budget lock, a shared campaign only goes down', () => {
    expect(one(camp('p', { status: 'PAUSED' }))).toMatchObject({ action: 'hold', targetCents: 2_000, stepCents: 2_000, why: 'paused: the budget is left as it is' })
    expect(one(camp('z', { avgDailySpendCents: 0 }))).toMatchObject({ action: 'hold', why: 'no spend in the last 14 reported days: nothing to size the budget on, left as it is' })
    expect(one(camp('e', {}, [ov('EXCLUDE', '*', null, 'e')]))).toMatchObject({ action: 'skip', targetCents: null })
    const locked = one(camp('l', {}, [ov('LOCK', 'budgets', { dailyBudgetCents: 2_500 }, 'l')]))
    expect(locked).toMatchObject({ action: 'hold', targetCents: 2_500, stepCents: 2_000, ladder: null })
    expect(locked.why).toMatch(/^locked at the Owner's own value by the Owner's campaign override \(user:owner, 2026-10-08\).*: the Owner's own budget €25.00$/)
    expect(one(camp('l2', {}, [ov('LOCK', 'budgets', null)]))).toMatchObject({ action: 'hold', targetCents: 2_000 })
    expect(one(camp('s', { owner: 'shared', todayCents: 300, avgDailySpendCents: 280 }))).toMatchObject({ action: 'keep', targetCents: 300 })
    expect(one(camp('s', { owner: 'shared', todayCents: 300, avgDailySpendCents: 280 })).why).toContain('a shared campaign (D2): the brain may lower it, never raise it')
    expect(one(camp('s', { owner: 'shared', todayCents: 2_000, avgDailySpendCents: 280 }))).toMatchObject({ action: 'lower', targetCents: 400 })
  })

  it('a brake holds raises: budgets may only go down', () => {
    expect(one(camp('r', { todayCents: 300, avgDailySpendCents: 280 }), { brake: brakeOf(38_400, 40_000) })).toMatchObject({ action: 'keep', targetCents: 300 })
  })
})

describe('the intraday ladder (Adbrew, inside the band, on the Rome clock)', () => {
  const ready = (over: Partial<CampaignMoneyFacts> = {}, ovs: OverrideRow[] = []) => camp('l', { avgDailySpendCents: 1_300, usage: 0.82, settled: { spendCents: 9_000, salesCents: 30_000, orders: 4 }, ...over }, ovs)

  it('the rungs: +25 % before 06:00, +50 % before 12:00, +75 % before 18:00, +100 % before 23:00; none after, nor past local midnight', () => {
    expect([0.5, 5.9, 6, 11.9, 12, 17.9, 18, 22.9, 23, 23.5, 24.5, -0.5].map(ladderRung)).toEqual([25, 25, 50, 50, 75, 75, 100, 100, 0, 0, 0, 25])
  })

  it('82 % used at 10:45 inside the band: +50 % on top of today\'s base', () => {
    const c = one(ready())
    expect(c).toMatchObject({ action: 'lower', targetCents: 1_858, stepCents: 1_858, band: 'in', bandFrom: 'campaign', acosPct: 30, usagePct: 82 })
    expect(c.ladder).toEqual({ pct: 50, cents: 929, exception: false, why: '82 % used, ACoS 30 % (campaign) is inside the band — aim 30% (default band 27%–34.5%): +50 % of today\'s €18.58 = €27.87 (the rung before 12:00); inside the day-move bound' })
  })

  it('bounds: the Owner\'s largest raise, the campaign\'s maximum budget; above the day-move ceiling it needs the intraday give-back', () => {
    expect(one(ready({}, [ov('VALUE', 'intradayLadderMaxPct', 40, 'l')])).ladder).toMatchObject({ pct: 40, cents: 743 })
    expect(one(ready({ maxCents: 2_500 })).ladder).toMatchObject({ pct: 50, cents: 642 })
    // 19:00 Rome, already +50 % today, kept at €20: +100 % → €40, past the €30 ceiling → the give-back exception.
    const late = one(ready({ avgDailySpendCents: 1_400, ladderedTodayPct: 50 }), { ladderHour: 19 })
    expect(late.ladder).toMatchObject({ pct: 100, cents: 2_000, exception: true })
    expect(late.ladder!.why).toContain('allowed as an intraday give-back')
    expect(one(ready({}, [ov('VALUE', 'intradayLadderMaxPct', 0, 'l')])).ladderWhy).toBe('no ladder: the Owner set its largest raise to 0 % (user:owner)')
  })

  it('never: over the band (bids go down instead), a spike, a brake, 75 % or less used, no reading, the day\'s last hours, a shared campaign', () => {
    expect(one(ready({ settled: { spendCents: 9_000, salesCents: 20_000, orders: 4 } })).ladderWhy).toBe('no ladder: over the band — its bids go down instead')
    expect(one(ready({ spikeWhy: 'this hour\'s spend heads for €4.00' })).ladderWhy).toBe('no ladder: this hour\'s spend heads for €4.00')
    expect(one(ready(), { brake: brakeOf(38_400, 40_000) }).ladder).toBeNull()
    expect(one(ready({ usage: 0.75 })).ladderWhy).toBe('no ladder: 75 % used (it climbs above 75 %)')
    expect(one(ready({ usage: null })).ladderWhy).toBe('no ladder: no budget usage reading today')
    expect(one(ready(), { ladderHour: 23.5 }).ladder).toBeNull()
    expect(one(ready(), { ladderHour: 24.5 }).ladderWhy).toContain('the budget day\'s last hours')
    expect(one(ready({ owner: 'shared' })).ladderWhy).toBe('no ladder: a shared campaign is never raised')
  })

  it('it starts only before 18:00; after it only a campaign already on the ladder climbs; a rung already given is not given twice', () => {
    expect(one(ready(), { ladderHour: 18.5 }).ladderWhy).toBe('no ladder: 82 % used only after 18:00 — it lasts through the evening')
    expect(one(ready({ ladderedTodayPct: 50 }), { ladderHour: 18.5 }).ladder).toMatchObject({ pct: 100 })
    expect(one(ready({ ladderedTodayPct: 50 })).ladderWhy).toBe('on the ladder at +50 % already today (this hour\'s rung +50 %)')
  })

  it('a thin campaign (under 3 orders) reads the product\'s pooled ACoS; no goal, no ladder', () => {
    const thin = one(ready({ settled: { spendCents: 2_000, salesCents: 0, orders: 0 } }))
    expect(thin).toMatchObject({ band: 'in', bandFrom: 'product', acosPct: 31.6 })
    expect(thin.ladder).toMatchObject({ pct: 50 })
    expect(one(ready(), { band: { ...GALE_BAND, goal: null } }).ladderWhy).toBe('no ladder: no ACoS goal in the ads strategy: the band is unknown')
    expect(bandStateOf({ settled: { spendCents: 0, salesCents: 0, orders: 0 } }, { ...GALE_BAND, product: { spendCents: 0, salesCents: 0, orders: 0 } }).state).toBeNull()
  })
})

describe('the day-move check and its intraday give-back exception', () => {
  const bounds = { floorCents: 1_400, ceilCents: 3_000 }
  it('inside the bound passes; above it only the brain\'s ladder within its maximum, on a base inside the bound', () => {
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 2_900, bounds })).toMatchObject({ allowed: true, exception: null })
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 4_000, bounds, ladder: { baseCents: 2_000, pct: 100, maxPct: 100 } })).toMatchObject({ allowed: true, exception: 'intraday-give-back' })
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 4_000, bounds })).toMatchObject({ allowed: false, why: 'above the day-move ceiling' })
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 4_200, bounds, ladder: { baseCents: 2_000, pct: 100, maxPct: 100 } })).toMatchObject({ allowed: false, why: 'above the day-move ceiling and beyond the ladder\'s +100 %' })
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 6_400, bounds, ladder: { baseCents: 3_200, pct: 100, maxPct: 100 } })).toMatchObject({ allowed: false, why: 'above the day-move ceiling, and the base itself is outside the day-move bound' })
    expect(dayMoveCheck({ openingCents: 2_000, intendedCents: 1_000, bounds })).toMatchObject({ allowed: false, why: 'below the day-move floor' })
  })
})

describe('> 105 %: the weakest campaigns to stop', () => {
  it('no sales first (most spend first), then the highest ACoS, until the projection is back to the envelope', () => {
    const list = [
      camp('a', { avgDailySpendCents: 300, settled: { spendCents: 4_000, salesCents: 20_000, orders: 3 } }),
      camp('b', { avgDailySpendCents: 200, settled: { spendCents: 3_000, salesCents: 0, orders: 0 } }),
      camp('c', { avgDailySpendCents: 400, settled: { spendCents: 5_000, salesCents: 10_000, orders: 2 } }),
      camp('d', { avgDailySpendCents: 500, status: 'PAUSED' }),
      camp('e', { avgDailySpendCents: 100, settled: { spendCents: 1_000, salesCents: 0, orders: 0 } }),
    ]
    expect(weakestToStop(list, 46_000, 40_000, 10)).toEqual([
      { campaignId: 'b', name: 'b', savesCents: 2_000 }, { campaignId: 'e', name: 'e', savesCents: 1_000 }, { campaignId: 'c', name: 'c', savesCents: 4_000 },
    ])
    expect(weakestToStop(list, 40_000, 40_000, 10)).toEqual([])
  })
})
