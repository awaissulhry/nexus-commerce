/**
 * BID BRAIN BB-17 — the intraday brakes' maths on made-up hourly data, and what they do to a keyword's decision.
 *
 *   switch     NEXUS_BID_BRAIN_INTRADAY: off · shadow (default; anything unknown) · on
 *   spend      projected day spend against the day's planned spend: hold above 130 %, cut above 160 % (latched for the
 *              day from the hour it first crossed), projected by the hour curve once a quarter of a usual day is behind
 *   cpc        a lane's cost per click over the last two hours against its 14-day median for those hours, with a click
 *              floor; a capped grain day, a late first delta or too few days is a gap — no brake
 *   budget     the budget used up before the best hours → the low-value hours slow to the factor that leaves the best
 *              hours their usual spend (quantised, floored), the strongest of the day held; after the best hours, used
 *              up already, or no slowdown allowed → no raises only
 *   decide     a hold holds raises only; the cut steps down from the bid before it and a rerun holds (no ratchet); the next
 *              day gives it back; a light tick lands where a full run did; a goal cut deeper than the brake goes as the
 *              goal's; a CPC spike caps the bid lane-aware (the lane's own %, its dynamic bidding) or the lane the brain
 *              sets; a pin beats every brake; the give-back after a stop stops at the brake, not held as a raise
 *   gaps       no planned day, no budget, a silent feed: no brake, said
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import {
  applyIntraday, bestHoursOf, brakeLabels, budgetBrakeOf, campaignBrakes, compareIntraday, cpcSpikeOf, hourRanges, intradayClock, intradayMode,
  intradaySummaryWords, plannedDay, spendBrakeOf, thresholdsOf, type CampaignBrakes, type CampaignHours, type IntradayRun, type LaneWindow,
} from './intraday.js'

const T = thresholdsOf()
const at = (iso: string) => intradayClock(new Date(iso))
const even = (cents: number, through: number) => Array.from({ length: 24 }, (_, h) => (h < through ? cents : 0))
const PLAN = { cents: 1000, from: 'the money brain\'s plan of today' }

describe('the switch', () => {
  it('reads off, shadow and on; anything else is shadow', () => {
    expect(intradayMode('off')).toBe('off')
    expect(intradayMode('0')).toBe('off')
    expect(intradayMode('on')).toBe('on')
    expect(intradayMode(' TRUE ')).toBe('on')
    expect(intradayMode('shadow')).toBe('shadow')
    expect(intradayMode(undefined)).toBe('shadow')
    expect(intradayMode('live')).toBe('shadow')
  })

  it('takes the brain\'s settings, the Owner\'s values over them', () => {
    expect(T).toEqual({ spendHoldPct: 130, spendCutPct: 160, spendCutStepPct: 10, cpcSpikePct: 200, cpcMinClicks: 5, budgetSlowMinPct: 50 })
    expect(thresholdsOf({ intradaySpendHoldPct: 150, intradayCpcMinClicks: 'x' })).toMatchObject({ spendHoldPct: 150, cpcMinClicks: 5 })
  })
})

describe('the spend brake', () => {
  it('holds raises above 130 % of the day\'s plan, projected by an even day', () => {
    // 700¢ by 12:00 on an even day: half a day gone, heads for 1,400¢ — 140 % of the 1,000¢ plan.
    const b = spendBrakeOf({ todayCents: even(700 / 12, 12), weights: null, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })!
    expect(b).toMatchObject({ level: 'hold', projectedCents: 1400, spentCents: 700, plannedCents: 1000 })
    expect(b.why).toBe('intraday spend: today heads for €14.00 (€7.00 spent by 12:00 UTC, 50 % of a usual day) — above 130 % of the day\'s planned €10.00 (the money brain\'s plan of today): no raises today')
    expect(spendBrakeOf({ todayCents: even(600 / 12, 12), weights: null, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })).toBeNull()
  })

  it('cuts above 160 %, from the end of the first hour whose projection crossed it', () => {
    // 850¢ evenly by 12:00 heads for 1,700¢ all day; projected first at the end of 05:00 (a quarter of the day gone).
    const b = spendBrakeOf({ todayCents: even(850 / 12, 12), weights: null, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })!
    expect(b).toMatchObject({ level: 'cut', projectedCents: 1700, since: 6, stepPct: 10 })
    expect(b.why).toMatch(/above 160 % of the day's planned €10\.00 \(the money brain's plan of today\) since 06:00 UTC: bids step down 10 % from the bid before for the rest of the budget day \(back at 00:00 UTC\), and no raises$/)
  })

  it('a cut holds the day: a morning spike, then a quiet afternoon', () => {
    // 100¢ an hour until 08:00 (heads for 2,400¢), nothing after: at 16:00 it heads for 1,200¢ — the cut still holds.
    const today = Array.from({ length: 24 }, (_, h) => (h < 8 ? 100 : 0))
    const b = spendBrakeOf({ todayCents: today, weights: null, clock: at('2026-10-08T16:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })!
    expect(b).toMatchObject({ level: 'cut', since: 6, projectedCents: 1200 })
  })

  it('projects by the hour curve: a day whose spend comes in the evening', () => {
    // Weights 1 until noon, 3 after: at 12:00 only a quarter of a usual day is gone — 300¢ heads for 1,200¢ (no brake),
    // where an even day would read 600¢ … and 500¢ heads for 2,000¢ (a cut).
    const w = Array.from({ length: 24 }, (_, h) => (h < 12 ? 1 : 3))
    expect(spendBrakeOf({ todayCents: even(25, 12), weights: w, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })).toBeNull()
    expect(spendBrakeOf({ todayCents: even(500 / 12, 12), weights: w, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })).toMatchObject({ level: 'cut', projectedCents: 2000 })
  })

  it('before a quarter of a usual day: no projection, only the spend so far', () => {
    expect(spendBrakeOf({ todayCents: even(100, 3), weights: null, clock: at('2026-10-08T03:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })).toBeNull()
    const b = spendBrakeOf({ todayCents: even(600, 3), weights: null, clock: at('2026-10-08T03:00:00Z'), planned: PLAN, t: T, currency: 'EUR' })!
    expect(b).toMatchObject({ level: 'cut', projectedCents: 1800, since: 3 })
    expect(b.why).toMatch(/today has spent €18\.00 by 03:00 UTC \(under a quarter of a usual day: not projected\)/)
  })

  it('the Owner\'s thresholds: a cut below the hold line cuts at the hold line', () => {
    const b = spendBrakeOf({ todayCents: even(700 / 12, 12), weights: null, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: { ...T, spendHoldPct: 150, spendCutPct: 120, spendCutStepPct: 20 }, currency: 'EUR' })
    expect(b).toBeNull()
    expect(spendBrakeOf({ todayCents: even(800 / 12, 12), weights: null, clock: at('2026-10-08T12:00:00Z'), planned: PLAN, t: { ...T, spendHoldPct: 150, spendCutPct: 120, spendCutStepPct: 20 }, currency: 'EUR' })).toMatchObject({ level: 'cut', stepPct: 20 })
  })

  it('the planned day: the money plan, else the median of at least 5 days that spent, never under €2', () => {
    expect(plannedDay({ moneyPlanCents: 900, dailyCents: [100, 100, 100, 100, 100] })).toEqual({ cents: 900, from: 'the money brain\'s plan of today' })
    expect(plannedDay({ moneyPlanCents: null, dailyCents: [800, 1000, 0, 1200, 900, 5000] })).toEqual({ cents: 1000, from: 'the median of its last 5 days that spent' })
    expect(plannedDay({ moneyPlanCents: null, dailyCents: [800, 1000, 1200, 900] })).toBeNull()
    expect(plannedDay({ moneyPlanCents: 150, dailyCents: [150, 150, 150, 150, 150] })).toBeNull()
  })
})

const lane = (todaySpend: number, todayClicks: number, pastCpc: number | null, opts: { days?: number; late?: boolean } = {}): LaneWindow => ({
  lane: 'TOP_OF_SEARCH',
  today: { spendCents: todaySpend, clicks: todayClicks, late: !!opts.late },
  past: Array.from({ length: 14 }, (_, k) => ({ day: `2026-09-${String(30 - k).padStart(2, '0')}`, spendCents: pastCpc != null && k < (opts.days ?? 14) ? pastCpc * 10 : 0, clicks: pastCpc != null && k < (opts.days ?? 14) ? 10 : 0 })),
})
const CPC = { t: T, cappedDays: new Set<string>(), today: '2026-10-08', currency: 'EUR' }

describe('the CPC spike brake', () => {
  it('a lane over 2 × its 14-day median for these hours: held to 2 × the median', () => {
    // 12 clicks for 840¢ = 70¢ against a 30¢ median.
    const r = cpcSpikeOf(lane(840, 12, 30), CPC)
    expect(r).toEqual({ spike: expect.objectContaining({ lane: 'TOP_OF_SEARCH', readingCents: 70, clicks: 12, medianCents: 30, days: 14, ceilingCents: 60 }) })
    expect((r as { spike: { why: string } }).spike.why).toBe('intraday CPC spike: top-of-search cost per click €0.70 over the last two hours (12 clicks) is 2.3 × its 14-day median for these hours (€0.30) — a competitor surge or a shift in Amazon\'s auction: no raises, and its dearest click held to €0.60 while it lasts')
  })

  it('no brake under the line, or under the click floor', () => {
    expect(cpcSpikeOf(lane(600, 12, 30), CPC)).toBeNull()
    expect(cpcSpikeOf(lane(400, 4, 30), CPC)).toBeNull()
    expect(cpcSpikeOf(lane(400, 4, 30), { ...CPC, t: { ...T, cpcMinClicks: 3 } })).toMatchObject({ spike: { ceilingCents: 60 } })
  })

  it('gaps: too few days with clicks, a capped grain day, a late first delta — no brake, said', () => {
    expect(cpcSpikeOf(lane(840, 12, 30, { days: 4 }), CPC)).toEqual({ gap: 'top-of-search CPC: 4 of the last 14 days had clicks in these hours (5 needed)' })
    expect(cpcSpikeOf(lane(840, 12, 30), { ...CPC, cappedDays: new Set(['2026-10-08']) })).toEqual({ gap: 'top-of-search CPC: the hourly grain capped today\'s rows — today\'s cost per click is not known' })
    expect(cpcSpikeOf(lane(840, 12, 30, { late: true }), CPC)).toEqual({ gap: 'top-of-search CPC: a late first delta in the last two hours — earlier deltas may be missing' })
  })

  it('a capped past day is left out of the median', () => {
    const l = lane(840, 12, 30)
    const skewed: LaneWindow = { ...l, past: l.past.map((d, k) => (k < 3 ? { ...d, spendCents: 3000 } : d)) }
    // Three days at 3€ a click would lift the median of 14 to … still 30¢; capped they are not read at all.
    expect(cpcSpikeOf(skewed, { ...CPC, cappedDays: new Set(skewed.past.slice(0, 3).map((d) => d.day)) })).toMatchObject({ spike: { days: 11, medianCents: 30 } })
  })
})

/** Sales between 18:00 and 22:00: the best hours (smoothed) are 17:00–23:00. */
const EVENING = Array.from({ length: 24 }, (_, h) => (h >= 18 && h <= 21 ? 10 : 0))

describe('the budget brake', () => {
  it('finds the best hours on a smoothed value curve', () => {
    expect([...bestHoursOf(EVENING)].sort((a, b) => a - b)).toEqual([17, 18, 19, 20, 21, 22])
    expect(hourRanges([17, 18, 19, 20, 21, 22, 3])).toBe('03:00–04:00, 17:00–23:00 UTC')
    expect(bestHoursOf(null).size).toBe(24)
  })

  it('a budget that runs out before the best hours: its low-value hours slow so the best hours keep their spend', () => {
    // 600¢ evenly by 12:00 heads for 1,200¢ against an 1,100¢ budget: it runs out about 21:00, before 17–23. The low hours
    // left (12–16 and 23) carry a quarter of a day: f = (1,100 − 600 − 1,200 × ¼) ÷ (1,200 × ¼) = ⅔ → 0.65.
    const b = budgetBrakeOf({ todayCents: even(50, 12), weights: null, value: { curve: EVENING, from: 'by its 1-day sales over 28 days' }, clock: at('2026-10-08T12:00:00Z'), budgetCents: 1100, t: T, currency: 'EUR' })!
    expect(b).toMatchObject({ factor: 0.65, lowHour: true, bestHours: [17, 18, 19, 20, 21, 22] })
    expect(b.why).toBe('intraday budget: today heads past its €11.00 daily budget (€6.00 spent by 12:00 UTC), about 21:00 UTC, before its best hours (17:00–23:00 UTC, by its 1-day sales over 28 days): its low-value hours slowed to 65 % of the bid since 12:00 UTC — now is one; no raises today — the money brain owns the budget')
  })

  it('in a best hour the slowdown waits; the floor is intradayBudgetSlowMinPct', () => {
    const late = budgetBrakeOf({ todayCents: even(1000 / 19, 19), weights: null, value: { curve: EVENING, from: 'x' }, clock: at('2026-10-08T19:00:00Z'), budgetCents: 1100, t: T, currency: 'EUR' })!
    expect(late.lowHour).toBe(false)
    // A much smaller budget: the best hours alone would use it up — the floor (50 %), and it says so.
    const tight = budgetBrakeOf({ todayCents: even(50, 12), weights: null, value: { curve: EVENING, from: 'x' }, clock: at('2026-10-08T12:00:00Z'), budgetCents: 800, t: T, currency: 'EUR' })!
    expect(tight.factor).toBe(0.5)
    expect(tight.why).toMatch(/the most intradayBudgetSlowMinPct allows; even so the best hours may not get their usual spend/)
    expect(budgetBrakeOf({ todayCents: even(50, 12), weights: null, value: { curve: EVENING, from: 'x' }, clock: at('2026-10-08T12:00:00Z'), budgetCents: 1100, t: { ...T, budgetSlowMinPct: 100 }, currency: 'EUR' })).toMatchObject({ factor: 1 })
  })

  it('no slowdown when it runs out after the best hours, or the budget is used up already — only no raises', () => {
    const morning = Array.from({ length: 24 }, (_, h) => (h >= 6 && h <= 9 ? 10 : 0))
    const after = budgetBrakeOf({ todayCents: even(50, 12), weights: null, value: { curve: morning, from: 'by its usual spend' }, clock: at('2026-10-08T12:00:00Z'), budgetCents: 1100, t: T, currency: 'EUR' })!
    expect(after.factor).toBe(1)
    expect(after.why).toMatch(/about 21:00 UTC, after its best hours \(05:00–11:00 UTC, by its usual spend\): no raises today/)
    const out = budgetBrakeOf({ todayCents: even(100, 12), weights: null, value: { curve: EVENING, from: 'x' }, clock: at('2026-10-08T12:30:00Z'), budgetCents: 1100, t: T, currency: 'EUR' })!
    expect(out).toMatchObject({ factor: 1 })
    expect(out.why).toBe('intraday budget: €12.00 spent by 12:30 UTC — its €11.00 daily budget is used up: no raises today (the money brain owns the budget)')
    // A budget that lasts the day: nothing.
    expect(budgetBrakeOf({ todayCents: even(40, 12), weights: null, value: { curve: EVENING, from: 'x' }, clock: at('2026-10-08T12:00:00Z'), budgetCents: 1100, t: T, currency: 'EUR' })).toBeNull()
  })
})

const hours = (extra: Partial<CampaignHours> = {}): CampaignHours => ({
  todayCents: even(0, 0), curveCents: null, salesCurveCents: null, orders: 0, dailyCents: [], moneyPlanCents: null, budgetCents: null, lanes: [], ...extra,
})

describe('a campaign\'s brakes, and the gaps', () => {
  it('no planned day, no budget, no clicks: no brake, each said', () => {
    const b = campaignBrakes(hours(), { pool: null, t: T, clock: at('2026-10-08T12:00:00Z'), cappedDays: new Set(), currency: 'EUR' })
    expect(b).toEqual({ spend: null, cpc: [], budget: null, gaps: [expect.stringMatching(/^spend: no planned day/), 'budget: no daily budget known'] })
  })

  it('every brake together, in short words', () => {
    const b = campaignBrakes(hours({ todayCents: even(850 / 12, 12), moneyPlanCents: 1000, budgetCents: 1100, salesCurveCents: EVENING, orders: 12, lanes: [lane(840, 12, 30)] }), { pool: null, t: T, clock: at('2026-10-08T12:00:00Z'), cappedDays: new Set(), currency: 'EUR' })
    expect(brakeLabels(b)).toEqual(['spend cut −10 %', 'CPC spike top-of-search', 'budget slow ×0.5'])
    // Without a sales curve (and no spend curve) every hour is alike: nothing to slow, the raises wait.
    const flat = campaignBrakes(hours({ todayCents: even(850 / 12, 12), budgetCents: 1100 }), { pool: null, t: T, clock: at('2026-10-08T12:00:00Z'), cappedDays: new Set(), currency: 'EUR' })
    expect(brakeLabels(flat)).toEqual(['budget hold'])
    expect(flat.budget!.why).toMatch(/with no low-value hour left to slow: no raises today/)
  })
})

// ── what the brakes do to a decision (the §7 worked example: goal 16¢, in band 15–22¢) ───────────────────────────────

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
function example(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: '2026-10-07',
    chain: [{ level: 'target', evidence: ev(1, 0, 0, 30) }, { level: 'product', evidence: ev(2300, 20, 162_300, 69_000) }, { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) }],
    listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    ...extra,
  }
}
const NO_LANES = { placements: [], biddingStrategy: 'LEGACY_FOR_SALES' }
const spend = (level: 'hold' | 'cut'): CampaignBrakes => ({ spend: { level, projectedCents: 1700, spentCents: 850, plannedCents: 1000, plannedFrom: 'plan', since: 6, stepPct: 10, why: `intraday spend: ${level}` }, cpc: [], budget: null, gaps: [] })

describe('the brakes in a decision', () => {
  it('a spend hold holds a raise only; a cut still goes', () => {
    const raise = decide(applyIntraday(example(14), spend('hold'), NO_LANES))
    expect(raise).toMatchObject({ action: 'hold', layer: 'goal', bidCents: 14 })
    expect(raise.why).toMatch(/^goal: raise held — intraday spend: hold; 14¢ → 16¢ waits/)
    expect(decide(applyIntraday(example(33), spend('hold'), NO_LANES))).toMatchObject({ action: 'write', layer: 'goal', bidCents: 25 })
  })

  it('a spend cut steps down 10 % from the bid before; the rerun holds (no ratchet); the next day gives it back', () => {
    const first = decide(applyIntraday(example(19), spend('cut'), NO_LANES))
    expect(first).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 17 })
    expect(first.why).toBe('intraday: the intraday spend cut (−10 % for the rest of the budget day) → 17¢ from the 19¢ before it')
    // The next tick: the bid sits at the cut, the brain's memory says what was before it.
    const memory = { layer: 'intraday' as const, heldCents: 17, beforeCents: 19 }
    expect(decide(applyIntraday(example(17, { restore: memory }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'intraday', bidCents: 17 })
    // A light tick (no evidence, no goal) lands where the full run did.
    expect(decide(applyIntraday(example(17, { restore: memory, chain: [] }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'intraday', bidCents: 17 })
    // The next budget day: no brake — back to the bid before, as if the cut never happened (in band at 19¢: 19¢).
    const back = decide(example(17, { restore: memory }))
    expect(back).toMatchObject({ action: 'write', layer: 'restore', bidCents: 19 })
    expect(back.why).toMatch(/^restore: the intraday layer no longer applies → back to 19¢ from the 17¢ it held/)
  })

  it('the goal\'s own cut deeper than the brake goes as the goal\'s; the brake applies on top of it next', () => {
    // 33¢: the goal steps to 25¢, under the cut's 29¢.
    expect(decide(applyIntraday(example(33), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', layer: 'goal', bidCents: 25, step: { fromCents: 33, toCents: 25 } })
    const next = decide(applyIntraday(example(25, { lastStep: { dataDay: '2026-10-07', fromCents: 33, toCents: 25 } }), spend('cut'), NO_LANES))
    expect(next).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 22 })
  })

  it('never below the strategy\'s lowest bid or the engine floor; a brake that cannot bite leaves the goal to decide', () => {
    expect(decide(applyIntraday(example(19, { limits: { minBidCents: 18, maxBidCents: 80, maxChangePct: 25 } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', bidCents: 18 })
    expect(decide(applyIntraday(example(19, { limits: { minBidCents: 19, maxBidCents: 80, maxChangePct: 25 } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'band', bidCents: 19 })
    expect(decide(applyIntraday(example(5), spend('cut'), NO_LANES)).bidCents).toBe(5)
  })

  it('a pin beats every brake; a stop beats it too, and its end gives back up to the brake — not held as a raise', () => {
    expect(decide(applyIntraday(example(19, { overrides: { pin: { by: 'a person' } } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'pin' })
    expect(decide(applyIntraday(example(19, { overrides: { stop: { bidCents: 3, by: 'a playbook STOP' } } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', layer: 'stop', bidCents: 3 })
    const lifted = decide(applyIntraday(example(3, { restore: { layer: 'stop', heldCents: 3, beforeCents: 19 } }), spend('cut'), NO_LANES))
    expect(lifted).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 17 })
    // The give-back would land lower than the brake (from 33¢ the goal steps to 25¢, under the cut's 29¢): the give-back goes.
    expect(decide(applyIntraday(example(3, { restore: { layer: 'stop', heldCents: 3, beforeCents: 33 } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', layer: 'restore', bidCents: 25 })
  })

  it('with the money step or a freeze named first, the intraday bid keeps its layer: the next run reads its memory (no cut after cut)', () => {
    const money = { money: { stepPct: 10, by: 'the money brain\'s brake' } }
    // The month's step (19 → 17¢) and the spend cut (19 → 17¢) tie: the intraday brake's, under its own layer.
    expect(decide(applyIntraday(example(19, { overrides: money }), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 17 })
    expect(decide(applyIntraday(example(17, { overrides: money, restore: { layer: 'intraday', heldCents: 17, beforeCents: 19 } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'intraday', bidCents: 17 })
    // Auto-undo's freeze (no raise) named first, the cut lower: the cut's layer, then a hold.
    const freeze = { freeze: { by: 'auto-undo' } }
    expect(decide(applyIntraday(example(14, { overrides: freeze }), spend('cut'), NO_LANES))).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 12 })
    expect(decide(applyIntraday(example(12, { overrides: freeze, restore: { layer: 'intraday', heldCents: 12, beforeCents: 14 } }), spend('cut'), NO_LANES))).toMatchObject({ action: 'hold', layer: 'intraday', bidCents: 12 })
  })

  it('a CPC spike caps the bid lane-aware: the lane\'s own % and dynamic bidding count where the brain does not set it', () => {
    const spike: CampaignBrakes = { spend: null, cpc: [{ lane: 'TOP_OF_SEARCH', readingCents: 70, clicks: 12, medianCents: 20, days: 14, ceilingCents: 40, why: 'intraday CPC spike: top' }], budget: null, gaps: [] }
    // Top of search at +100 % on "down only": 40¢ ÷ 2 → 20¢; at 22¢ (in band, the goal holds) the bid comes down.
    const live = { placements: [{ placement: 'PLACEMENT_TOP', percentage: 100 }], biddingStrategy: 'LEGACY_FOR_SALES' }
    const d = decide(applyIntraday(example(22), spike, live))
    expect(d).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 20 })
    expect(d.why).toBe('intraday: the intraday CPC spike (top-of-search click ≤ 40¢: bid ≤ 20¢) → 20¢ from the 22¢ before it')
    // "Up and down" may add up to +100 % at the top of search: 40¢ ÷ (2 × 2) → 10¢.
    expect(decide(applyIntraday(example(22), spike, { ...live, biddingStrategy: 'AUTO_FOR_SALES' })).bidCents).toBe(10)
    // Under the cap the brake does not bite: the goal decides, its raise held while the spike lasts.
    expect(decide(applyIntraday(example(14), spike, live))).toMatchObject({ action: 'hold', layer: 'goal', bidCents: 14 })
    // At 40¢ the goal's own cut (30¢) stays above the cap: the cap goes.
    expect(decide(applyIntraday(example(40), spike, live))).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 20 })
    // The spike over: back to the bid before.
    expect(decide(example(20, { restore: { layer: 'intraday', heldCents: 20, beforeCents: 22 } }))).toMatchObject({ action: 'write', layer: 'restore', bidCents: 22 })
  })

  it('a CPC spike in a lane the brain sets: the lane\'s % comes down under the spike ceiling first', () => {
    const spike: CampaignBrakes = { spend: null, cpc: [{ lane: 'TOP_OF_SEARCH', readingCents: 70, clicks: 12, medianCents: 30, days: 14, ceilingCents: 60, why: 'intraday CPC spike: top' }], budget: null, gaps: [] }
    const f = applyIntraday(example(20, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: null }] }), spike, { placements: [{ placement: 'PLACEMENT_TOP', percentage: 300 }], biddingStrategy: 'LEGACY_FOR_SALES' })
    expect(f.lanes).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 60 }])
    const d = decide(f)
    // 20¢ in band: the bid stays; top of search held to 20 × (1 + p) ≤ 60 → 200 %.
    expect(d).toMatchObject({ action: 'hold', layer: 'band', bidCents: 20 })
    expect(d.placements).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 300, pct: 200, held: 'the top-of-search CPC ceiling 60¢' }])
  })

  it('lane-aware cut: the lanes the brain sets step their CPC ceilings down with the bid', () => {
    const f = applyIntraday(example(19, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 100, maxCpcCents: 50, baseCeilingCents: 40 }] }), spend('cut'), NO_LANES)
    expect(f.lanes).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 100, maxCpcCents: 45, baseCeilingCents: 36 }])
    const d = decide(f)
    expect(d).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 17 })
    expect(d.placements[0]).toMatchObject({ pct: 100 })
  })

  it('a budget\'s slow hour steps down by its factor; a best hour gives it back', () => {
    const slow = (lowHour: boolean): CampaignBrakes => ({ spend: null, cpc: [], budget: { factor: 0.65, lowHour, bestHours: [18, 19], why: 'intraday budget: slow' }, gaps: [] })
    expect(decide(applyIntraday(example(19), slow(true), NO_LANES))).toMatchObject({ action: 'write', layer: 'intraday', bidCents: 12 })
    const best = decide(applyIntraday(example(12, { restore: { layer: 'intraday', heldCents: 12, beforeCents: 19 } }), slow(false), NO_LANES))
    expect(best).toMatchObject({ action: 'write', layer: 'restore', bidCents: 19 })
    // The spend cut and a slow hour together: the stronger.
    const both: CampaignBrakes = { ...slow(true), spend: spend('cut').spend }
    expect(decide(applyIntraday(example(19), both, NO_LANES)).bidCents).toBe(12)
  })

  it('no brake: the facts unchanged, byte for byte', () => {
    const f = example(19)
    expect(applyIntraday(f, undefined, NO_LANES)).toBe(f)
    expect(applyIntraday(f, { spend: null, cpc: [], budget: null, gaps: ['budget: no daily budget known'] }, NO_LANES)).toBe(f)
  })
})

describe('the run\'s words', () => {
  const run = (mode: 'shadow' | 'on'): IntradayRun => ({ mode, campaigns: 2, gaps: [], brakes: new Map([['c1', spend('cut')], ['c2', { spend: null, cpc: [], budget: null, gaps: [] }]]) })
  const of = (id: string) => (id.startsWith('a') ? 'c1' : 'c2')

  it('shadow: a note where a brake would change a decision, and the count', () => {
    const plain = [decide(example(19, { targetId: 'a1' })), decide(example(19, { targetId: 'b1' }))]
    const braked = [decide(applyIntraday(example(19, { targetId: 'a1' }), spend('cut'), NO_LANES)), plain[1]]
    const { notes, summary } = compareIntraday(plain, braked, run('shadow'), of)
    expect([...notes]).toEqual([['a1', 'intraday (shadow): would write 17¢ (intraday; spend cut −10 %)']])
    expect(intradaySummaryWords(summary)).toBe('intraday shadow: 2 campaigns — spend hold 0, spend cut 1, CPC spikes 0, budget 0; 1 of 2 decisions would change')
    const on = compareIntraday(plain, braked, run('on'), of)
    expect(on.notes.size).toBe(0)
    expect(intradaySummaryWords(on.summary)).toMatch(/; 1 of 2 decisions changed$/)
  })

  it('a silent feed: no brake, said', () => {
    expect(intradaySummaryWords({ mode: 'shadow', campaigns: 3, spendHold: 0, spendCut: 0, cpcLanes: 0, budget: 0, changed: 0, decided: 9, gaps: ['the hourly feed has sent nothing for these campaigns today (3 hours or more)'] }))
      .toBe('intraday shadow: no brake — the hourly feed has sent nothing for these campaigns today (3 hours or more)')
    expect(intradaySummaryWords({ mode: 'on', campaigns: 1, spendHold: 0, spendCut: 0, cpcLanes: 0, budget: 0, changed: 0, decided: 4, gaps: [] })).toBe('intraday on: 1 campaign, no brake')
  })
})
