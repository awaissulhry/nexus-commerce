/**
 * 4b (review 4.1) — the one reader of a typed ads number. Rules, their save checks and budget schedules all read
 * through these, so a decimal comma is read here or nowhere, and nothing unreadable becomes 0.
 */
import { describe, it, expect } from 'vitest'
import { checkDecimal, DECIMAL_RANGE, floorAboveCeiling, parseDecimalInput } from './ads-number.js'

const value = (raw: unknown) => {
  const r = parseDecimalInput(raw)
  return r.ok ? r.value : 'refused'
}

describe('parseDecimalInput', () => {
  it('🔴 reads a decimal comma like a decimal point ("2,5" used to become 0)', () => {
    expect(value('2,5')).toBe(2.5)
    expect(value('2.5')).toBe(2.5)
    expect(value(' 2,50 ')).toBe(2.5)
    expect(value('12,50')).toBe(12.5)
    expect(value(',5')).toBe(0.5)
    expect(value('-3')).toBe(-3)
    expect(value('7')).toBe(7)
  })

  it('takes a number as it is, and refuses one that is not finite', () => {
    expect(value(2.5)).toBe(2.5)
    expect(value(0)).toBe(0)
    expect(value(Number.NaN)).toBe('refused')
    expect(value(Number.POSITIVE_INFINITY)).toBe('refused')
  })

  it('blank is null, never 0', () => {
    expect(value('')).toBeNull()
    expect(value('   ')).toBeNull()
    expect(value(null)).toBeNull()
    expect(value(undefined)).toBeNull()
  })

  it('reads thousands only in the unambiguous grouped form', () => {
    expect(value('1.234,5')).toBe(1234.5)
    expect(value('12.345.678,90')).toBe(12345678.9)
    expect(value('1,234.5')).toBe(1234.5)
  })

  it('🔴 refuses junk with a reason instead of reading it as 0', () => {
    for (const junk of ['abc', '2,5,1', '1.234.567', '1,2.3', '12,50 €', '5%', '1e3', '--2', '1 234', true, {}, []]) {
      const r = parseDecimalInput(junk)
      expect(r.ok, `${JSON.stringify(junk)} was read`).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/is not a number/)
    }
    const r = parseDecimalInput('abc')
    expect(r).toEqual({ ok: false, reason: '"abc" is not a number — type digits with at most one decimal comma or point, for example 2,5' })
  })
})

describe('checkDecimal — the ranges the ads screens promise', () => {
  it('reads the comma and passes a value inside its range', () => {
    expect(checkDecimal('2,5', 'Decrease', DECIMAL_RANGE.decreasePct)).toEqual({ ok: true, value: 2.5 })
    expect(checkDecimal('900', 'Placement', DECIMAL_RANGE.placementPct)).toEqual({ ok: true, value: 900 })
    expect(checkDecimal('0,5', 'Multiplier', DECIMAL_RANGE.multiplier)).toEqual({ ok: true, value: 0.5 })
  })

  it('a decrease is at most 100%, a placement 0–900%, a multiplier above 0, money never negative', () => {
    expect(checkDecimal('150', 'Decrease by', DECIMAL_RANGE.decreasePct)).toEqual({ ok: false, error: 'Decrease by must be at most 100 (it is 150).' })
    expect(checkDecimal('901', 'Placement', DECIMAL_RANGE.placementPct)).toEqual({ ok: false, error: 'Placement must be at most 900 (it is 901).' })
    expect(checkDecimal('-1', 'Placement', DECIMAL_RANGE.placementPct)).toEqual({ ok: false, error: 'Placement must be at least 0 (it is -1).' })
    expect(checkDecimal('0', 'Multiplier', DECIMAL_RANGE.multiplier)).toEqual({ ok: false, error: 'Multiplier must be above 0 (it is 0).' })
    expect(checkDecimal('-0,5', 'Budget ceiling', DECIMAL_RANGE.money)).toEqual({ ok: false, error: 'Budget ceiling must be at least 0 (it is -0.5).' })
    expect(checkDecimal(12.5, 'Spend cap (cents)', DECIMAL_RANGE.count)).toEqual({ ok: false, error: 'Spend cap (cents) must be a whole number (it is 12.5).' })
  })

  it('blank is fine unless the field is required; junk is a sentence that names the field', () => {
    expect(checkDecimal('', 'Budget ceiling', DECIMAL_RANGE.money)).toEqual({ ok: true, value: null })
    expect(checkDecimal('', 'Set to', DECIMAL_RANGE.money, true)).toEqual({ ok: false, error: 'Set to is empty: type a number.' })
    const junk = checkDecimal('12,5x', 'Budget ceiling', DECIMAL_RANGE.money)
    expect(junk.ok).toBe(false)
    if (!junk.ok) expect(junk.error).toMatch(/^Budget ceiling: "12,5x" is not a number/)
  })
})

describe('floorAboveCeiling', () => {
  it('only when both are set and the floor is higher', () => {
    expect(floorAboveCeiling(20, 10)).toBe(true)
    expect(floorAboveCeiling(10, 10)).toBe(false)
    expect(floorAboveCeiling(5, null)).toBe(false)
    expect(floorAboveCeiling(null, 5)).toBe(false)
  })
})
