/**
 * Negative Targeting page — the stop-waste rules' pure half: one test with the page (the rule's numbers on the page's
 * formula), the two starters as engine rules, the body checks and the rule in one line. Pure; every value made up.
 */
import { describe, expect, it } from 'vitest'
import { bodyOfRule, bodyProblems, ruleOfBody, STARTERS, wasteKindOf, wasteSentence } from './pure.js'
import { stopWasteKindOf, stopWasteParamsOf, stopWasteShapeOf } from '../ads-graduation-stopwaste.js'
import { barFor, productFactsOf, targetFrom, wasteTest } from '../waste/test.js'
import { FIXED_KEYWORD_SPEND_BAR_CENTS, FIXED_TERM_SPEND_BAR_CENTS, KEYWORD_CPA_BAR, MIN_CLICKS_FLOOR, TERM_CPA_BAR, WASTE_WINDOW_DAYS } from '../waste/pure.js'

const NOW = new Date('2026-10-11T09:30:00Z')
const fallback = () => 'fallback sentence'

describe('one test with the page (review S2)', () => {
  const facts = productFactsOf({
    product: { clicks: 400, orders: 20, salesCents: 160_000, costCents: 30_000 }, market: { clicks: 2000, orders: 80, salesCents: 640_000, costCents: 150_000 },
    listPriceCents: 8000, target: targetFrom(25, 'the ads strategy', null),
  })
  const tuneOf = (kind: 'PAUSE_KEYWORD' | 'NEGATE_TERM') => {
    const p = stopWasteParamsOf(ruleOfBody({ kind, scope: { marketplace: 'IT' } }).actions)!
    return { by: { id: 'r', name: 'Stop waste' }, windowDays: p.windowDays, minClicks: p.minClicks, cpaMultiple: p.cpaMultiple, fixedSpendCents: p.spendFloorCents }
  }

  it('the facts: pooled conversion and order value (product → market) × the target ACoS; the account default without a strategy', () => {
    expect(facts.cr).toBeGreaterThan(0.03)
    expect(facts.cr).toBeLessThan(0.06)
    expect(facts.targetCpaCents).toBeGreaterThan(1500)
    expect(facts.targetSource).toBe('the ads strategy')
    expect(targetFrom(null, 'x', 20)).toEqual({ value: 0.2, source: 'the account\'s default target ACoS' })
    expect(targetFrom(null, 'x', null)).toBeNull()
    expect(productFactsOf({ product: null, market: { clicks: 0, orders: 0, salesCents: 0, costCents: 0 }, listPriceCents: null, target: null })).toEqual({ cr: null, targetCpaCents: null, targetSource: null })
  })

  it('a starter\'s bar IS the page\'s default bar: same clicks, same spend, only its name differs', () => {
    for (const [kind, row] of [['PAUSE_KEYWORD', 'KEYWORD'], ['NEGATE_TERM', 'TERM']] as const) {
      const page = barFor(row, facts, WASTE_WINDOW_DAYS)
      const rule = barFor(row, facts, WASTE_WINDOW_DAYS, null, tuneOf(kind))
      expect({ ...rule, source: page.source, by: page.by, basis: page.basis }).toEqual(page)
      expect(rule).toMatchObject({ source: 'rule', by: { name: 'Stop waste' }, basis: expect.stringMatching(/^the rule "Stop waste": 0 orders/) })
    }
    // Without a target: the page's fixed bars.
    const none = { cr: null, targetCpaCents: null, targetSource: null }
    expect(barFor('KEYWORD', none, 60, null, tuneOf('PAUSE_KEYWORD')).spendBarCents).toBe(FIXED_KEYWORD_SPEND_BAR_CENTS)
    expect(barFor('TERM', none, 60, null, tuneOf('NEGATE_TERM')).spendBarCents).toBe(FIXED_TERM_SPEND_BAR_CENTS)
  })

  it('a rule\'s own numbers ride the same formula; the ads strategy\'s negate group still wins a search term whole', () => {
    const own = barFor('KEYWORD', facts, 60, null, { by: { id: 'r', name: 'Mine' }, windowDays: 30, minClicks: 500, cpaMultiple: 3, fixedSpendCents: 900 })
    expect(own).toMatchObject({ windowDays: 30, clicksNeeded: 500, xCpaBar: 3, spendBarCents: Math.round(3 * facts.targetCpaCents!) })
    const strategy = { source: 'strategy' as const, by: { id: 'strategy', name: 'the ads strategy' }, minClicks: 15, minSpendCents: 1000, maxOrders: 0, windowDays: 45 }
    expect(barFor('TERM', facts, 60, strategy, tuneOf('NEGATE_TERM'))).toMatchObject({ source: 'strategy', clicksNeeded: 15, spendBarCents: 1000, windowDays: 45 })
    expect(wasteTest('KEYWORD', { clicks: 600, orders: 0, spendCents: 99_999 }, own).met).toBe(true)
    expect(wasteTest('KEYWORD', { clicks: 600, orders: 0, spendCents: 99_999 }, own, { termsSold: 1 }).met).toBe(false)
  })
})

describe('the two starters (born at Watch) as the engine rules they save', () => {
  it('keywords: TARGET_PERFORMANCE → pause_target, kept paused, daily, with its test; a stop-waste kind', () => {
    const r = ruleOfBody({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' } })
    expect(r.trigger).toBe('TARGET_PERFORMANCE')
    expect(r.name).toBe('Stop waste — keywords')
    expect(r.conditions).toEqual([{ field: 'adTarget.orders', op: 'eq', value: 0 }, { field: 'adTarget.clicks', op: 'gte', value: 20 }])
    expect(r.actions[0]).toMatchObject({ type: 'pause_target', keepPaused: true, schedule: { frequency: 'Daily', time: '06:00', timezone: 'cet' } })
    expect(stopWasteParamsOf(r.actions)).toEqual({ kind: 'PAUSE_KEYWORD', windowDays: WASTE_WINDOW_DAYS, minClicks: MIN_CLICKS_FLOOR, cpaMultiple: KEYWORD_CPA_BAR, spendFloorCents: FIXED_KEYWORD_SPEND_BAR_CENTS })
    expect(stopWasteKindOf(r.actions.map((a) => String(a.type)))).toBe('PAUSE_KEYWORD')
    expect(stopWasteShapeOf(r.actions)).toBe('PAUSE_KEYWORD')
  })

  it('search terms: SEARCH_TERM_WASTING → a negative exact on the source wire (row, audit row); a phrase asks; the campaign level', () => {
    const exact = ruleOfBody({ kind: 'NEGATE_TERM', scope: { marketplace: 'IT' } })
    expect(exact.trigger).toBe('SEARCH_TERM_WASTING')
    expect(exact.actions[0]).toMatchObject({ type: 'add_negative_exact', scope: 'AD_GROUP', levels: ['AD_GROUP'], negative: { blocks: null, dedupe: true } })
    expect(stopWasteParamsOf(exact.actions)).toMatchObject({ kind: 'NEGATE_TERM', cpaMultiple: TERM_CPA_BAR, spendFloorCents: FIXED_TERM_SPEND_BAR_CENTS })
    expect(stopWasteShapeOf(exact.actions)).toBe('NEGATE_TERM')
    const phrase = ruleOfBody({ kind: 'NEGATE_TERM', match: 'PHRASE', level: 'CAMPAIGN', scope: { marketplace: 'IT' }, runAt: '7:15' })
    expect(phrase.actions[0]).toMatchObject({ type: 'add_negative_phrase', scope: 'CAMPAIGN', schedule: { time: '07:15' } })
    expect(phrase.actions[0].negative).toBeUndefined()
    // A phrase, or a negative exact for the whole campaign, is saved but never the page's Auto shape (S1): it asks.
    expect(stopWasteShapeOf(phrase.actions)).toBeNull()
    expect(stopWasteShapeOf(ruleOfBody({ kind: 'NEGATE_TERM', level: 'CAMPAIGN', scope: { marketplace: 'IT' } }).actions)).toBeNull()
  })

  it('the starters say the Owner\'s defaults', () => {
    expect(STARTERS.map((s) => [s.kind, s.windowDays, s.minClicks, s.cpaMultiple, s.spendFloorCents])).toEqual([
      ['PAUSE_KEYWORD', WASTE_WINDOW_DAYS, MIN_CLICKS_FLOOR, KEYWORD_CPA_BAR, FIXED_KEYWORD_SPEND_BAR_CENTS],
      ['NEGATE_TERM', WASTE_WINDOW_DAYS, MIN_CLICKS_FLOOR, TERM_CPA_BAR, FIXED_TERM_SPEND_BAR_CENTS],
    ])
  })

  it('a saved rule reads back as the body it was saved from', () => {
    const body = { kind: 'NEGATE_TERM' as const, name: 'Mine', scope: { adGroupId: 'ag-1', campaignId: 'c-1' }, windowDays: 30, minClicks: 25, cpaMultiple: 2, spendFloorCents: 900, match: 'EXACT' as const, level: 'CAMPAIGN' as const, runAt: '05:00' }
    const r = ruleOfBody(body)
    expect(bodyOfRule({ name: r.name, actions: r.actions, scope: body.scope })).toEqual(body)
    expect(bodyOfRule({ name: 'x', actions: [{ type: 'pause_target' }], scope: {} })).toBeNull()
  })
})

describe('the body checks', () => {
  it('a scope is said out loud; one grain per branch; numbers in range', () => {
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' } })).toEqual([])
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { adGroupId: 'ag' } })).toEqual([])
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD' }).join(' ')).toMatch(/scope: name the market/)
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { wholeAccount: true, marketplace: 'IT' } }).join(' ')).toMatch(/at once/)
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { portfolioId: 'p', adGroupId: 'ag' } }).join(' ')).toMatch(/a portfolio and a campaign or ad group/)
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' }, windowDays: 7 }).join(' ')).toMatch(/windowDays/)
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' }, windowDays: 88 }).join(' ')).toMatch(/windowDays: a number from 14 to 87/)
    expect(bodyProblems({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' }, match: 'EXACT' }).join(' ')).toMatch(/for a search-term rule/)
    expect(bodyProblems({ kind: 'NEGATE_TERM', scope: { marketplace: 'IT' }, runAt: '25:00' }).join(' ')).toMatch(/runAt/)
  })
})

describe('the Rules view: kinds and words', () => {
  it('a rule that pauses or unpauses a keyword, or adds negatives, is a waste rule of its family', () => {
    expect(wasteKindOf(['pause_target'])).toBe('PAUSE_KEYWORD')
    expect(wasteKindOf(['bid_apply', 'enable_target'])).toBe('PAUSE_KEYWORD')
    expect(wasteKindOf(['add_negative_phrase'])).toBe('NEGATE_TERM')
    expect(wasteKindOf(['sync_negatives_across_campaigns'])).toBe('NEGATE_TERM')
    expect(wasteKindOf(['bid_apply'])).toBeNull()
    expect(wasteKindOf(['promote_to_exact'])).toBeNull()
  })

  it('a stop-waste rule in one line, without an amount; any other rule through the fallback', () => {
    const p = ruleOfBody({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' } })
    expect(wasteSentence(p, fallback)).toBe('Keywords: 0 orders, clicks ≥ 20, spend ≥ 2 × target cost per order (else a fixed bar), 60 d → pause, keep paused')
    const n = ruleOfBody({ kind: 'NEGATE_TERM', level: 'CAMPAIGN', scope: { marketplace: 'IT' } })
    expect(wasteSentence(n, fallback)).toBe('Search terms: 0 orders, clicks ≥ 20, spend ≥ 1.5 × target cost per order (else a fixed bar), 60 d → negative exact in the campaign')
    expect(wasteSentence({ actions: [{ type: 'negative-targeting' }], trigger: 'SEARCH_TERM_WASTING' }, fallback)).toBe('Search terms: spend, no sales → negative')
    expect(wasteSentence({ actions: [{ type: 'pause_target' }], trigger: 'KEYWORD_WASTED_SPEND' }, fallback)).toBe('fallback sentence')
  })
})
