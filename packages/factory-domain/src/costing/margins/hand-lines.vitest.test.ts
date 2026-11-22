import { describe, expect, it } from 'vitest'
import { HAND_MARGIN_REFUSALS, HAND_MARGIN_WORDS, handCostOf, ORDER_COST_LINE_KINDS, targetPctOf } from './hand-lines'
import { waterfallOf, WATERFALL_REASONS } from './rules'

/** B-OM-021 (order money tab; lead L2, L4): hand cost lines (added only) and the order's target margin. Every figure is made up. */
describe('B-OM-021: an order’s margin set by hand', () => {
  it('the four kinds of an added line (replacing a computed part is a later job)', () => {
    expect(ORDER_COST_LINE_KINDS).toEqual(['FREIGHT_ESTIMATE', 'COMMISSION', 'BANK_CHARGES', 'OTHER'])
  })

  it('counts the lines not removed', () => {
    expect(handCostOf([])).toBe(0)
    expect(handCostOf([{ amount: 30_000, removedAt: null }, { amount: 5_000, removedAt: new Date('2026-11-22T10:00:00.000Z') }, { amount: 1_250, removedAt: null }])).toBe(31_250)
  })

  it('a target is a percent above 0 and below 100, with at most 4 decimals', () => {
    expect(targetPctOf('38')).toBe('38')
    expect(targetPctOf(' 38.50 ')).toBe('38.5')
    expect(targetPctOf('12.3456')).toBe('12.3456')
    for (const text of ['0', '100', '-5', '12.34567', 'abc', '']) expect(targetPctOf(text), text).toBeNull()
  })

  it('the hand lines are the waterfall’s own last step, so the steps still add up to the margin now', () => {
    expect(WATERFALL_REASONS.at(-1)).toBe('BY_HAND')
    const parts = { material: 100_000, labour: 40_000, subcontract: 0, overhead: 0, adjustment: 0 }
    const steps = waterfallOf({ value: 200_000, parts }, { value: 200_000, parts, freight: 1_000, byHand: 3_000 })
    expect(steps.slice(-2)).toEqual([{ reason: 'FREIGHT', amount: -1_000 }, { reason: 'BY_HAND', amount: -3_000 }])
    // None: no step (the waterfall reads as before).
    expect(waterfallOf({ value: 200_000, parts }, { value: 200_000, parts }).map((step) => step.reason)).not.toContain('BY_HAND')
  })

  it('every refusal has its words in English and Italian', () => {
    for (const code of HAND_MARGIN_REFUSALS) {
      expect(HAND_MARGIN_WORDS[code].en.length, code).toBeGreaterThan(10)
      expect(HAND_MARGIN_WORDS[code].it.length, code).toBeGreaterThan(10)
    }
  })
})
