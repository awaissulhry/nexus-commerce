import { describe, expect, it } from 'vitest'
import {
  ruleRateWords,
  abMark,
  channelWords,
  duplicateHeld,
  firstTryWords,
  marketsWords,
  noMatchWarnings,
  rulesBulkHeld,
  rulesBulkLabel,
  rulesBulkPlan,
  rulesBulkResultWords,
  rulesTiles,
  skipsWords,
  turnOnHeld,
  windowWords,
  type RuleItem,
} from './rulesModel'

const rule = (id: string, over: Partial<RuleItem> = {}): RuleItem => ({
  id, name: `Rule ${id}`, scope: 'AMAZON_GLOBAL', marketplace: null, isActive: true, minDaysSinceDelivery: 4, maxDaysSinceDelivery: 30,
  exclusions: ['has_refund', 'has_active_return'], minOrderTotalCents: null, notes: null, sendDelayDays: null, anchor: 'DELIVERY',
  sent30: 10, rate30: 0.1, matched30: 12,
  ...over,
})

describe('rules grid words', () => {
  it('names the channel, the markets, the first try, the window and the skips', () => {
    expect(channelWords(rule('a'))).toBe('Amazon')
    expect(marketsWords(rule('a'))).toBe('All markets')
    expect(marketsWords(rule('b', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE' }))).toBe('Germany')
    expect(marketsWords(rule('c', { scope: 'AMAZON_PER_MARKETPLACE' }))).toBe('No market set')
    expect(firstTryWords(rule('a', { sendDelayDays: 7, anchor: 'SHIP' }))).toEqual({ value: 'Day 7', sub: 'after delivery' })
    expect(firstTryWords(rule('e', { scope: 'EBAY', anchor: 'SHIP' }))).toEqual({ value: 'By product type', sub: 'the Timing table, after shipping' })
    expect(windowWords(rule('a'))).toBe('Day 4–30')
    expect(skipsWords(rule('a', { exclusions: ['has_refund', 'fba_only', 'asked_buyer_90d'] }))).toBe('Refunded, Amazon ships (FBA) only, Asked in the last 90 days')
    expect(skipsWords(rule('a', { exclusions: [] }))).toBe('Nothing skipped')
  })

  it('marks the A and B sides of a test and holds a second duplicate', () => {
    const rules = [rule('a', { name: 'Germany jackets' }), rule('b', { name: 'Germany jackets (variant 1)' }), rule('c', { name: 'Italy' })]
    expect(abMark(rules[0], rules)).toBe('A')
    expect(abMark(rules[1], rules)).toBe('B')
    expect(abMark(rules[2], rules)).toBeNull()
    expect(duplicateHeld(rules[0], rules)).toBe('This rule is already side A of a test (“Germany jackets (variant 1)”). Delete or rename that copy to start another.')
    expect(duplicateHeld(rules[1], rules)).toBe('This rule is already side B of a test. Duplicate side A instead.')
    expect(duplicateHeld(rules[2], rules)).toBeNull()
  })
})

describe('rules that match no orders', () => {
  it('warns about a rule with no market, a channel Nexus does not ask, and none matched in 30 days', () => {
    const rules = [
      rule('a', { name: 'Amazon Netherlands', scope: 'AMAZON_PER_MARKETPLACE', marketplace: null }),
      rule('b', { name: 'Etsy', scope: 'ETSY' }),
      rule('c', { name: 'Quiet', matched30: 0 }),
      rule('d', { name: 'Quiet but off', matched30: 0, isActive: false }),
      rule('e'),
    ]
    expect(noMatchWarnings(rules, true).map((w) => w.title)).toEqual([
      '“Amazon Netherlands” has no market set — it matches no orders',
      '“Etsy” is for Etsy — it matches no orders',
      '“Quiet” matched no orders in the last 30 days',
    ])
    expect(noMatchWarnings(rules, false)).toHaveLength(2)
  })

  it('every eBay rule says eBay buyers are not e-mailed, on or off (Owner, 2026-10-27)', () => {
    const warnings = noMatchWarnings([rule('on', { name: 'eBay on', scope: 'EBAY' }), rule('off', { name: 'eBay off', scope: 'EBAY', isActive: false })], true)
    expect(warnings.map((w) => w.title)).toEqual(['“eBay on” is for eBay — eBay buyers are not e-mailed', '“eBay off” is for eBay — eBay buyers are not e-mailed'])
    expect(warnings[0].detail).toBe('eBay buyers are not e-mailed — eBay asks its buyers for feedback itself, so no rule can e-mail them. Turn it off or delete it.')
    expect(warnings[1].detail).toMatch(/Delete it, or keep it off\.$/)
    expect(turnOnHeld(rule('x', { isActive: false, scope: 'EBAY', name: 'eBay' }))).toBe('“eBay” asks nobody: eBay buyers are not e-mailed — eBay asks its buyers for feedback itself, so no rule can e-mail them.')
  })
})

describe('rules tiles', () => {
  it('counts the rules on and weights the rate by requests sent', () => {
    const rules = [rule('a', { sent30: 100, rate30: 0.1 }), rule('b', { sent30: 300, rate30: 0.05, isActive: false }), rule('c', { sent30: 0, rate30: null })]
    // The rate is the API's one rate for every request a rule sent, never an average of the rules' rates (audit C2).
    expect(rulesTiles(rules, true, { sent30: 400, rate30: 0.07, rateWords: null })).toEqual({ on: 2, total: 3, sent30: 400, matched30: 36, rate30: 0.07, rateWords: null })
    expect(rulesTiles(rules, true, { sent30: 400, rate30: null, rateWords: 'Not measurable: x' })).toMatchObject({ rate30: null, rateWords: 'Not measurable: x' })
    expect(rulesTiles([rule('a')], false)).toEqual({ on: 1, total: 1, sent30: null, matched30: null, rate30: null, rateWords: null })
    // A rule's Rate: "Not measurable" where its requests went out but no review can follow them (live audit A02).
    expect(ruleRateWords({ rate30: null, rateWords: 'Not measurable: Amazon gives no review count — import this market’s reviews to estimate it.' })).toBe('Not measurable')
    expect(ruleRateWords({ rate30: null, rateWords: null })).toBe('—')
    expect(ruleRateWords({ rate30: 0.074, rateWords: null })).toBe('7.4%')
  })
})

describe('rules bulk bar', () => {
  it('turns on only the rules that can be on, naming the ones it leaves out', () => {
    const rules = [rule('a', { isActive: false }), rule('b', { isActive: false, scope: 'AMAZON_PER_MARKETPLACE', name: 'Amazon Netherlands' }), rule('c')]
    const plan = rulesBulkPlan(rules, 'on')
    expect(plan.apply).toEqual(['a'])
    expect(plan.held.map((h) => h.words)).toEqual(['“Amazon Netherlands” matches no orders: it has no market. Open it and pick one.', '“Rule c” is already on'])
    expect(rulesBulkHeld(plan, 'on')).toBeNull()
    expect(rulesBulkLabel('Turn on', plan)).toBe('Turn on (1 of 3)')
  })

  it('is held and names the blocking rule when none can change', () => {
    const plan = rulesBulkPlan([rule('b', { isActive: false, scope: 'AMAZON_PER_MARKETPLACE', name: 'Amazon Netherlands' })], 'on')
    expect(rulesBulkHeld(plan, 'on')).toBe('Nothing to be turned on: “Amazon Netherlands” matches no orders: it has no market. Open it and pick one.')
    const off = rulesBulkPlan([rule('a', { isActive: false }), rule('b', { isActive: false })], 'off')
    expect(rulesBulkHeld(off, 'off')).toBe('Nothing to be turned off: “Rule a” is already off (and 1 more)')
    expect(rulesBulkPlan([rule('a'), rule('b')], 'delete').apply).toEqual(['a', 'b'])
    expect(turnOnHeld(rule('x', { isActive: false, scope: 'ETSY', name: 'Etsy' }))).toBe('“Etsy” matches no orders: Nexus asks only Amazon and Shopify buyers.')
  })

  it('says what the server changed', () => {
    expect(rulesBulkResultWords('off', 2, [])).toBe('2 rules turned off')
    expect(rulesBulkResultWords('on', 1, [{ words: '“X” is already on' }])).toBe('1 rule turned on · 1 left out: “X” is already on')
  })
})
