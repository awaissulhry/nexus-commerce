/**
 * Ads fix 7d (review I.1) — the rules grid reads the header's market picker, and never hides a rule without a word.
 */
import { describe, expect, it } from 'vitest'
import { ANY_MARKET_WHY, hiddenRulesLine, rulesForMarket } from './ruleMarket'

const rules = [
  { id: 'de', market: 'DE' },
  { id: 'it', market: 'IT' },
  { id: 'any', market: null },
  { id: 'empty', market: '' },
]

describe('rulesForMarket', () => {
  it('lists every rule when no market is picked', () => {
    for (const m of ['all', '', null, undefined]) {
      expect(rulesForMarket(rules, m)).toEqual({ shown: rules, hidden: 0 })
    }
  })

  it('lists the market’s own rules and the rules with no market, and counts the rest', () => {
    const r = rulesForMarket(rules, 'DE')
    expect(r.shown.map((x) => x.id)).toEqual(['de', 'any', 'empty'])
    expect(r.hidden).toBe(1)
  })

  it('🔴 never loses a rule: listed + counted = all, in every market', () => {
    for (const m of ['IT', 'DE', 'FR', 'ES', 'UK']) {
      const r = rulesForMarket(rules, m)
      expect(r.shown.length + r.hidden).toBe(rules.length)
      // A rule with no market is in every market's list.
      expect(r.shown.map((x) => x.id)).toEqual(expect.arrayContaining(['any', 'empty']))
    }
  })

  it('a market with no rules of its own still lists the rules with no market', () => {
    expect(rulesForMarket(rules, 'FR')).toMatchObject({ hidden: 2 })
    expect(rulesForMarket(rules, 'FR').shown.map((x) => x.id)).toEqual(['any', 'empty'])
  })
})

describe('the words', () => {
  it('names the count, the market and the noun', () => {
    expect(hiddenRulesLine(1, 'DE', 'bid rule')).toBe('1 bid rule is set to another market, so it is not listed under DE.')
    expect(hiddenRulesLine(3, 'IT', 'budget rule')).toBe('3 budget rules are set to another market, so they are not listed under IT.')
  })

  it('the chip says why a rule with no market is listed', () => {
    expect(ANY_MARKET_WHY).toContain('every market')
  })
})
