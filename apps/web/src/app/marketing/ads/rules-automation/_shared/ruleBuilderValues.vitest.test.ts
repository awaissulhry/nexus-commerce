/**
 * 4g (review 4.1 web, 5.8) — the rule and schedule builders read a typed number the way the server does, and a
 * typed value that cannot be read or is out of range holds Save instead of leaving as null, NaN or 0.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  BID_FLOOR_EUR, criteriaProblems, normalizeDecimalText, readRuleNumbers, scheduleWindowValue,
  type RuleNumberInputs, type RuleNumberShape,
} from './ruleBuilderValues'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** The builder's own starting values. */
const BLANK: RuleNumberInputs = {
  budgetFloor: '1', budgetCeiling: '', placeFloor: '0', placeCeiling: '900', bidFloor: '0.05', bidCeiling: '',
  maxAdSpend: '100', maxWrites: '', maxExecs: '10', protectDays: '30', everyN: '', harvestBid: '',
}
const BID: RuleNumberShape = { locked: false, budget: false, placement: false, bidLike: true, negative: false, harvest: false, harvestBidMode: 'cpc', customFrequency: false }
const BUDGET: RuleNumberShape = { ...BID, bidLike: false, budget: true }
const nums = (over: Partial<RuleNumberInputs>, shape: RuleNumberShape = BID) => readRuleNumbers({ ...BLANK, ...over }, shape)

describe('the premise', () => {
  it('Number() cannot read a decimal comma, and JSON sends what it makes as null', () => {
    expect(JSON.stringify({ bidCeiling: Number('12,50') })).toBe('{"bidCeiling":null}')
  })
})

describe('readRuleNumbers — ceilings and caps', () => {
  it('reads a decimal comma as the number it is', () => {
    const n = nums({ bidCeiling: '12,50', maxAdSpend: '12,50' })
    expect(n.errors).toEqual({})
    expect(n.values.bidCeiling).toBe(12.5)
    expect(n.caps.maxDailyAdSpendCentsEur).toBe(1250)
    expect(JSON.stringify({ bidCeiling: n.values.bidCeiling })).toBe('{"bidCeiling":12.5}')
  })

  it('an EMPTY Max is the one null: "no cap"', () => {
    expect(nums({}).values.bidCeiling).toBeNull()
    expect(nums({}, BUDGET).values.budgetCeiling).toBeNull()
    expect(nums({ maxWrites: '' }).caps.maxWritesPerDay).toBeUndefined()
  })

  it('a typed value that cannot be read holds Save and is never sent as null', () => {
    const n = nums({ bidCeiling: '12,5x' })
    expect(n.errors.bidCeiling).toMatch(/^Max bid: "12,5x" is not a number/)
    expect(n.values.bidCeiling).toBe('12,5x')
    expect(JSON.stringify({ bidCeiling: n.values.bidCeiling })).not.toContain('null')
  })

  it('a cap that cannot be read is not sent (a null cap would clear it), and holds Save', () => {
    const n = nums({ maxAdSpend: 'abc', maxWrites: '2,5', maxExecs: '0' })
    expect(n.caps).toEqual({ maxDailyAdSpendCentsEur: undefined, maxWritesPerDay: undefined, maxExecutionsPerDay: undefined })
    expect(n.errors.maxAdSpend).toMatch(/^Max daily ad spend: "abc" is not a number/)
    expect(n.errors.maxWrites).toBe('Max writes per day must be a whole number (it is 2.5).')
    expect(n.errors.maxExecs).toBe('Max runs per day must be at least 1 (it is 0).')
  })

  it('a Min above its Max is an error on the Max field (the server refuses it)', () => {
    expect(nums({ bidFloor: '0,80', bidCeiling: '0,60' }).errors).toEqual({ bidCeiling: 'Max bid (0.6) is below the min bid (0.8): raise the max or lower the min.' })
    expect(nums({ budgetFloor: '20', budgetCeiling: '15,5' }, BUDGET).errors.budgetCeiling).toMatch(/^Max daily budget \(15.5\) is below/)
    expect(nums({ placeFloor: '50', placeCeiling: '' }, { ...BID, bidLike: false, placement: true }).errors).toEqual({})
  })

  it('a placement modifier is 0–900%, and an empty Max means 900', () => {
    const shape = { ...BID, bidLike: false, placement: true }
    expect(nums({ placeCeiling: '950' }, shape).errors.placeCeiling).toBe('Max placement modifier must be at most 900 (it is 950).')
    expect(nums({ placeCeiling: '' }, shape).values.placeCeiling).toBe(900)
  })
})

describe('readRuleNumbers — 5.8 one bid floor', () => {
  it('is the bid action’s own floor (BID_FLOOR_CENTS = 5)', () => {
    const handlers = read('../../../../../../../api/src/services/advertising/automation-action-handlers.ts')
    const cents = Number(handlers.match(/const BID_FLOOR_CENTS = (\d+)/)?.[1])
    expect(BID_FLOOR_EUR * 100).toBe(cents)
  })

  it('an empty Min bid means €0.05, and a lower one holds Save instead of being promised', () => {
    expect(nums({ bidFloor: '' }).values.bidFloor).toBe(0.05)
    expect(nums({ bidFloor: '0,05' }).errors).toEqual({})
    expect(nums({ bidFloor: '0,02' }).errors.bidFloor).toBe('Min bid must be at least 0.05 (it is 0.02).')
  })

  it('the builder states the same floor it enforces', () => {
    const builder = read('./RuleBuilder.tsx')
    expect(builder).not.toContain('Math.max(0.02')
    expect(builder).not.toContain('Amazon’s minimum is €0.02')
    expect(builder).toContain('A rule never sets a bid below €0.05')
  })
})

describe('readRuleNumbers — only what this rule sends holds Save', () => {
  it('a bid rule is not held by a budget field, nor a locked rule by its guardrails', () => {
    expect(nums({ budgetCeiling: 'abc' }).errors).toEqual({})
    expect(nums({ bidCeiling: 'abc' }, { ...BID, locked: true }).errors).toEqual({})
    expect(Object.keys(nums({ maxWrites: 'abc' }, { ...BID, locked: true }).errors)).toEqual(['maxWrites'])
  })

  it('the protection window is 1–365 whole days, and empty means 30', () => {
    const shape = { ...BID, bidLike: false, negative: true }
    expect(nums({ protectDays: '' }, shape).values.protectDays).toBe(30)
    expect(nums({ protectDays: '0' }, shape).errors.protectDays).toBe('Protection window (days) must be at least 1 (it is 0).')
    expect(nums({ protectDays: '45' }, shape).values.protectDays).toBe(45)
  })

  it('"Every N" is read only on a Custom frequency, and empty means 1', () => {
    expect(nums({ everyN: '2,5' }).errors).toEqual({})
    expect(nums({ everyN: '2,5' }, { ...BID, customFrequency: true }).errors.everyN).toMatch(/whole number/)
    expect(nums({ everyN: '' }, { ...BID, customFrequency: true }).values.everyN).toBe(1)
  })

  it('a custom harvest bid needs a value; an empty "CPC + %" is CPC + 0%', () => {
    const fixed = { ...BID, bidLike: false, harvest: true, harvestBidMode: 'fixed' }
    expect(nums({ harvestBid: '' }, fixed).errors.harvestBid).toBe('Custom bid is empty: type a number.')
    expect(nums({ harvestBid: '0,75' }, fixed).values.harvestBid).toBe(0.75)
    expect(nums({ harvestBid: '' }, { ...fixed, harvestBidMode: 'cpcPlus' }).values.harvestBid).toBe(0)
    expect(nums({ harvestBid: 'abc' }, { ...fixed, harvestBidMode: 'cpc' }).errors).toEqual({})
  })
})

describe('criteriaProblems', () => {
  it('reads a decimal comma, names what it cannot read, and leaves blanks to the filled-in check', () => {
    const p = criteriaProblems([{ metric: 'Spend', value: '2,5' }, { metric: 'ACoS', value: '30%x' }, { metric: 'Clicks', value: '' }], null)
    expect(p.conditions[0]).toBeNull()
    expect(p.conditions[1]).toMatch(/^ACoS: "30%x" is not a number/)
    expect(p.conditions[2]).toBeNull()
    expect(p.all).toHaveLength(1)
  })

  it('holds the THEN value to its action’s range', () => {
    expect(criteriaProblems([], { kind: 'budget', op: 'decPct', value: '120' }).then).toBe('The “Decrease by %” value must be at most 100 (it is 120).')
    expect(criteriaProblems([], { kind: 'placement', op: 'set', value: '950' }).then).toBe('The “Set to %” value must be at most 900 (it is 950).')
    expect(criteriaProblems([], { kind: 'bid', op: 'set', value: '0,45' }).all).toEqual([])
  })
})

describe('normalizeDecimalText', () => {
  it('sends one spelling and leaves blank or unreadable text as typed', () => {
    expect(normalizeDecimalText('12,5')).toBe('12.5')
    expect(normalizeDecimalText('1.234,5')).toBe('1234.5')
    expect(normalizeDecimalText('')).toBe('')
    expect(normalizeDecimalText('abc')).toBe('abc')
  })
})

describe('scheduleWindowValue', () => {
  const w = { day: 'Monday', start: '09:00', end: '12:00', adj: 'decPct', value: '12,5' }
  it('"Decrease by 12,5" is 12.5%, not 0', () => {
    expect(scheduleWindowValue('budget-schedule', w)).toEqual({ value: 12.5, error: null })
  })

  it('names the window and the range it broke', () => {
    expect(scheduleWindowValue('budget-schedule', { ...w, value: '120' }).error).toBe('Monday 09:00–12:00: Decrease budget by (%) must be at most 100 (it is 120).')
    expect(scheduleWindowValue('budget-schedule', { ...w, adj: 'set', value: '0,50' }).error).toBe('Monday 09:00–12:00: Set budget to (€) must be at least 1 (it is 0.5).')
    expect(scheduleWindowValue('budget-multiplier', { ...w, start: '', end: '', adj: 'mult', value: '0' }).error).toBe('Monday (all day): Multiplier (×) must be above 0 (it is 0).')
  })

  it('a value that cannot be read is never 0, and an empty one is an incomplete row, not an error', () => {
    expect(scheduleWindowValue('budget-schedule', { ...w, value: '12,5%' })).toMatchObject({ value: '12,5%' })
    expect(scheduleWindowValue('budget-schedule', { ...w, value: '' })).toEqual({ value: null, error: null })
  })
})
