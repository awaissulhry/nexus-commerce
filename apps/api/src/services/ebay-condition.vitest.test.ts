import { describe, it, expect } from 'vitest'
import { toTradingConditionId, ENUM_TO_CONDITION_ID, CONDITION_ID_TO_ENUM } from './ebay-condition.js'

describe('toTradingConditionId (incident #16)', () => {
  it('translates the operator words both paths accept', () => {
    expect(toTradingConditionId('NEW')).toBe('1000')
    expect(toTradingConditionId('new')).toBe('1000')
    expect(toTradingConditionId('New With Tags')).toBe('1000')
    expect(toTradingConditionId('NEW_OTHER')).toBe('1500')
    expect(toTradingConditionId('USED_EXCELLENT')).toBe('3000')
    expect(toTradingConditionId('used')).toBe('3000')
  })
  it('passes numeric ConditionIDs through', () => {
    expect(toTradingConditionId('1000')).toBe('1000')
    expect(toTradingConditionId(' 3000 ')).toBe('3000')
  })
  it('unknown/empty resolve to "" so pre-flight names them (never eBay code 37)', () => {
    expect(toTradingConditionId('SHINY')).toBe('')
    expect(toTradingConditionId('')).toBe('')
  })
  it('inverse table covers every forward entry (tables cannot drift)', () => {
    for (const [id, en] of Object.entries(CONDITION_ID_TO_ENUM)) {
      expect(ENUM_TO_CONDITION_ID[en]).toBe(id)
    }
  })
})
