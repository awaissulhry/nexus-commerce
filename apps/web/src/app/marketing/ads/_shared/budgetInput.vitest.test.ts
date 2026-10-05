import { describe, it, expect } from 'vitest'
import {
  AMAZON_MIN_DAILY_BUDGET, BUDGET_MESSAGES, atMinimumNote, nextDailyBudget, readAmount, readBudgetChange,
  readBudgetPercent, readDailyBudget, readTargetAcosPercent, roundToCents, summariseBudgetChange,
} from './budgetInput'

/**
 * PR 1c (CM-7 = AM-1, CM-13) — a budget or Target ACoS box sends what was typed, to the cent,
 * or nothing at all. Each case below is a value a screen used to write differently.
 */
describe('readDailyBudget', () => {
  it('keeps the cents (the pencil wrote €12.34 as €12.00)', () => {
    expect(readDailyBudget('12.34')).toEqual({ ok: true, value: 12.34 })
    expect(readDailyBudget('12.50')).toEqual({ ok: true, value: 12.5 })
    expect(readDailyBudget(' 7 ')).toEqual({ ok: true, value: 7 })
  })
  it('reads a comma as the decimal mark', () => {
    expect(readDailyBudget('12,34')).toEqual({ ok: true, value: 12.34 })
  })
  it('rounds a third decimal to the cent, never to the euro', () => {
    expect(readDailyBudget('12.345')).toEqual({ ok: true, value: 12.35 })
    expect(readDailyBudget('1.005')).toEqual({ ok: true, value: 1.01 })
    expect(readDailyBudget('12.341')).toEqual({ ok: true, value: 12.34 })
  })
  it('sends nothing for an empty box (it used to write €1.00)', () => {
    expect(readDailyBudget('')).toEqual({ ok: false, message: BUDGET_MESSAGES.empty })
    expect(readDailyBudget('   ')).toEqual({ ok: false, message: BUDGET_MESSAGES.empty })
  })
  it('sends nothing for text that is not a number', () => {
    for (const raw of ['abc', '4.4.2', '1e3', '€5', '5€', 'Infinity', '.']) {
      expect(readDailyBudget(raw)).toEqual({ ok: false, message: BUDGET_MESSAGES.notNumber })
    }
  })
  it('refuses an amount below Amazon’s €1.00 and says so', () => {
    for (const raw of ['0', '0.99', '0.994', '-5']) {
      expect(readDailyBudget(raw)).toEqual({ ok: false, message: BUDGET_MESSAGES.belowMinimum })
    }
    expect(readDailyBudget('0.995')).toEqual({ ok: true, value: AMAZON_MIN_DAILY_BUDGET })
    expect(readDailyBudget('1')).toEqual({ ok: true, value: 1 })
  })
})

describe('readBudgetPercent / readBudgetChange', () => {
  it('reads a percentage', () => {
    expect(readBudgetPercent('10', 'incPct')).toEqual({ ok: true, value: 10 })
    expect(readBudgetPercent('12,5', 'decPct')).toEqual({ ok: true, value: 12.5 })
  })
  it('sends nothing for an empty, non-number or zero percentage', () => {
    expect(readBudgetPercent('', 'incPct')).toEqual({ ok: false, message: BUDGET_MESSAGES.percentEmpty })
    expect(readBudgetPercent('ten', 'incPct')).toEqual({ ok: false, message: BUDGET_MESSAGES.percentNotNumber })
    expect(readBudgetPercent('0', 'decPct')).toEqual({ ok: false, message: BUDGET_MESSAGES.percentNotAboveZero })
    expect(readBudgetPercent('-5', 'incPct')).toEqual({ ok: false, message: BUDGET_MESSAGES.percentNotAboveZero })
  })
  it('refuses a decrease over 100% but allows a large increase', () => {
    expect(readBudgetPercent('101', 'decPct')).toEqual({ ok: false, message: BUDGET_MESSAGES.decreaseOver100 })
    expect(readBudgetPercent('100', 'decPct')).toEqual({ ok: true, value: 100 })
    expect(readBudgetPercent('250', 'incPct')).toEqual({ ok: true, value: 250 })
  })
  it('a bulk "Set" with no value is refused (its review showed €0.00 and it wrote €1.00)', () => {
    expect(readBudgetChange('set', '')).toEqual({ ok: false, message: BUDGET_MESSAGES.empty })
    expect(readBudgetChange('set', '0')).toEqual({ ok: false, message: BUDGET_MESSAGES.belowMinimum })
    expect(readBudgetChange('set', '9.99')).toEqual({ ok: true, value: 9.99 })
    expect(readBudgetChange('incPct', '')).toEqual({ ok: false, message: BUDGET_MESSAGES.percentEmpty })
  })
})

describe('nextDailyBudget', () => {
  it('a percentage keeps the cents (€12.34 +10% wrote €14.00)', () => {
    expect(nextDailyBudget(12.34, 'incPct', 10)).toEqual({ value: 13.57, atMinimum: false })
    expect(nextDailyBudget(7.45, 'incPct', 10)).toEqual({ value: 8.2, atMinimum: false })
    expect(nextDailyBudget(12.5, 'decPct', 20)).toEqual({ value: 10, atMinimum: false })
  })
  it('a Set sends the value as read', () => {
    expect(nextDailyBudget(50, 'set', 12.34)).toEqual({ value: 12.34, atMinimum: false })
  })
  it('a cut below €1.00 stops at Amazon’s minimum and says so', () => {
    expect(nextDailyBudget(1.2, 'decPct', 50)).toEqual({ value: 1, atMinimum: true })
    expect(nextDailyBudget(10, 'decPct', 100)).toEqual({ value: 1, atMinimum: true })
    expect(nextDailyBudget(2, 'decPct', 50)).toEqual({ value: 1, atMinimum: false })
  })
})

describe('summariseBudgetChange / atMinimumNote', () => {
  it('names the lowest and highest new budget and the count stopped at €1.00', () => {
    expect(summariseBudgetChange([12.34, 1.2, 30], 'decPct', 50)).toEqual({ lowest: 1, highest: 15, atMinimum: 1 })
    expect(summariseBudgetChange([12.34, 10], 'set', 7.5)).toEqual({ lowest: 7.5, highest: 7.5, atMinimum: 0 })
    expect(summariseBudgetChange([], 'set', 7.5)).toBeNull()
  })
  it('only speaks when a campaign stops at the minimum', () => {
    expect(atMinimumNote(0)).toBeNull()
    expect(atMinimumNote(1)).toBe('1 campaign would go below €1.00 and stops at €1.00, Amazon’s smallest daily budget.')
    expect(atMinimumNote(3)).toBe('3 campaigns would go below €1.00 and stop at €1.00, Amazon’s smallest daily budget.')
  })
})

describe('readTargetAcosPercent', () => {
  it('blank is "unset", never 0% (CM-13)', () => {
    expect(readTargetAcosPercent('')).toEqual({ ok: true, fraction: null })
    expect(readTargetAcosPercent('  ')).toEqual({ ok: true, fraction: null })
  })
  it('a number is sent as a fraction', () => {
    expect(readTargetAcosPercent('30')).toEqual({ ok: true, fraction: 0.3 })
    expect(readTargetAcosPercent('12,5')).toEqual({ ok: true, fraction: 0.125 })
    expect(readTargetAcosPercent('0')).toEqual({ ok: true, fraction: 0 })
  })
  it('refuses text and values the endpoint would quietly clamp', () => {
    expect(readTargetAcosPercent('abc')).toEqual({ ok: false, message: BUDGET_MESSAGES.acosNotNumber })
    expect(readTargetAcosPercent('-1')).toEqual({ ok: false, message: BUDGET_MESSAGES.acosOutOfRange })
    expect(readTargetAcosPercent('501')).toEqual({ ok: false, message: BUDGET_MESSAGES.acosOutOfRange })
    expect(readTargetAcosPercent('500')).toEqual({ ok: true, fraction: 5 })
  })
})

describe('roundToCents / readAmount', () => {
  it('rounds to the cent', () => {
    expect(roundToCents(12.3449)).toBe(12.34)
    expect(roundToCents(13.572)).toBe(13.57)
    expect(roundToCents(1.005)).toBe(1.01)
  })
  it('accepts only plain numbers', () => {
    expect(readAmount('.5')).toBe(0.5)
    expect(readAmount('5.')).toBe(5)
    expect(readAmount('+3')).toBe(3)
    expect(readAmount('0x10')).toBeNull()
    expect(readAmount('1 000')).toBeNull()
  })
})
