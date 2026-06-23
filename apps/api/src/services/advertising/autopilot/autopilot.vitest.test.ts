import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GUARDRAILS, GOAL_PRESETS, effectiveTargetAcosPct, inventoryThrottle,
  intradayCorrection, smoothedCvr, rampLimit, exceedsDeadband, type CampaignSignals,
} from './presets.js'
import { decideBid, decideBudget } from './modules.js'
import { runConductorCycle } from './conductor.js'

const G = DEFAULT_GUARDRAILS
const BAL = GOAL_PRESETS.BALANCED

const sig = (p: Partial<CampaignSignals>): CampaignSignals => ({
  campaignId: 'c1', spendCents: 0, salesCents: 0, clicks: 0, orders: 0, impressions: 0,
  dailyBudgetCents: 1000, currentBidCents: 100, daysOfSupply: null, marginPct: null,
  tosImpressionSharePct: null, deliveryOutOfBudget: false, acos1hPct: null, ...p,
})

describe('presets math', () => {
  it('effective target ACoS by goal', () => {
    expect(effectiveTargetAcosPct('BALANCED', G, { marginPct: null })).toBe(30)
    expect(effectiveTargetAcosPct('PROFIT', G, { marginPct: 40 })).toBe(26)   // min(30, 0.65*40)
    expect(effectiveTargetAcosPct('LAUNCH', G, { marginPct: 40 })).toBe(48)   // 30 * 1.6, break-even clamp skipped
    expect(effectiveTargetAcosPct('LIQUIDATE', G, { marginPct: 40 })).toBe(75) // 30 * 2.5
  })
  it('inventory throttle', () => {
    expect(inventoryThrottle(null)).toBe(1)        // unknown → no throttle
    expect(inventoryThrottle(3)).toBe(0)           // at/below d0 → fully throttled
    expect(inventoryThrottle(60)).toBeGreaterThan(0.99)
  })
  it('intraday correction stays within band', () => {
    expect(intradayCorrection(null, 30)).toBe(1)
    expect(intradayCorrection(60, 30)).toBeGreaterThanOrEqual(0.8) // high hourly ACoS → nudge down, bounded
    expect(intradayCorrection(10, 30)).toBeLessThanOrEqual(1.2)
  })
  it('smoothed CVR shrinks toward prior with no data', () => {
    expect(smoothedCvr(0, 0)).toBeCloseTo(0.10, 5)
    expect(smoothedCvr(10, 100)).toBeCloseTo(0.10, 5)
  })
  it('ramp limit + deadband', () => {
    expect(rampLimit(150, 100, 25)).toBe(125)
    expect(rampLimit(50, 100, 25)).toBe(75)
    expect(exceedsDeadband(101, 100)).toBe(false)
    expect(exceedsDeadband(125, 100)).toBe(true)
  })
})

describe('decideBid', () => {
  it('raises toward the max profitable CPC (ramp-limited)', () => {
    const a = decideBid(sig({ orders: 10, salesCents: 50000, clicks: 100, currentBidCents: 100 }), 30, G, BAL)
    expect(a?.action).toBe('BID_RAISE')
    expect(a?.afterCents).toBe(125) // base 150 ramp-limited to +25%
  })
  it('cuts a proven non-converter to the floor', () => {
    const a = decideBid(sig({ orders: 0, clicks: 20, currentBidCents: 100 }), 30, G, BAL)
    expect(a?.action).toBe('BID_LOWER')
    expect(a?.afterCents).toBe(75)
  })
  it('keeps exploring before enough clicks', () => {
    expect(decideBid(sig({ orders: 0, clicks: 5, currentBidCents: 100 }), 30, G, BAL)).toBeNull()
  })
  it('no-ops inside the deadband', () => {
    expect(decideBid(sig({ orders: 10, salesCents: 50000, clicks: 100, currentBidCents: 150 }), 30, G, BAL)).toBeNull()
  })
  it('throttles hard on low inventory', () => {
    const a = decideBid(sig({ orders: 10, salesCents: 50000, clicks: 100, currentBidCents: 100, daysOfSupply: 3 }), 30, G, BAL)
    expect(a?.action).toBe('BID_LOWER') // θ_inv = 0 at DoS 3 → bid floored (ramp-limited to 75)
    expect(a?.afterCents).toBe(75)
  })
})

describe('decideBudget', () => {
  it('raises a starved, profitable campaign', () => {
    const a = decideBudget(sig({ deliveryOutOfBudget: true, salesCents: 10000, spendCents: 2000, dailyBudgetCents: 1000 }), 30, G, BAL)
    expect(a?.action).toBe('BUDGET_UP')
    expect(a?.afterCents).toBe(1200) // +20% balanced posture
  })
  it('trims a high-ACoS spender', () => {
    const a = decideBudget(sig({ salesCents: 10000, spendCents: 10000, dailyBudgetCents: 2000 }), 30, G, BAL)
    expect(a?.action).toBe('BUDGET_DOWN')
    expect(a?.afterCents).toBe(1600) // -20%
  })
  it('does nothing when in budget and efficient', () => {
    expect(decideBudget(sig({ salesCents: 10000, spendCents: 2000, dailyBudgetCents: 1000 }), 30, G, BAL)).toBeNull()
  })
})

describe('runConductorCycle', () => {
  it('respects module on/off flags', () => {
    const r = runConductorCycle({
      goal: 'BALANCED', guardrails: {}, modules: { bid: { on: false } },
      signals: [sig({ orders: 10, salesCents: 50000, clicks: 100, currentBidCents: 100 })],
    })
    expect(r.actions.filter((a) => a.module === 'bid')).toHaveLength(0)
  })
  it('scales budget raises to fit the max-daily-spend cap', () => {
    const r = runConductorCycle({
      goal: 'BALANCED', guardrails: { maxDailySpendCents: 2200 },
      modules: { bid: { on: false }, placement: { on: false } },
      signals: [
        sig({ campaignId: 'a', deliveryOutOfBudget: true, salesCents: 10000, spendCents: 2000, dailyBudgetCents: 1000 }),
        sig({ campaignId: 'b', deliveryOutOfBudget: true, salesCents: 10000, spendCents: 2000, dailyBudgetCents: 1000 }),
      ],
    })
    const ups = r.actions.filter((a) => a.action === 'BUDGET_UP')
    expect(ups).toHaveLength(2)
    expect(ups.every((a) => a.afterCents === 1100)).toBe(true) // 2×1200 → capped, each scaled to 1100
    expect(r.skipped.some((s) => /maxDailySpend/.test(s.reason))).toBe(true)
  })
})
