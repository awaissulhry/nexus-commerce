/**
 * ADS PLAYBOOK PB-3 — the raise / lower judgement (judge.ts) and the phase recipes made absolute (recipes.ts), pure.
 * Values are made up.
 *
 *   doc       a slot added, an Auto group on, a start-bid factor up, a placement up, a higher least budget per slot, an
 *             isolation switch off: raise; the opposite: lower; weights, names, flows, hourly plans, phases: same
 *   product   enrolling, a first or higher budget or base bid, a positive term added (or newly exact at start), a product
 *             negative removed: raise; the opposite: lower
 *   recipes   break-even × factor, else the fallback × the market's target (named); the bid band and the negate spend
 *             from the base bid (left out without one, named); the harvest ceiling a share of the phase's target
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { judgeDoc, judgeEnrolled, judgeMoney, judgeTerms } from './judge.js'
import { absoluteRecipes } from './recipes.js'
import { PRODUCT_TERMS } from './doc.js'

const doc = templateDoc()
const changed = (edit: (d: ReturnType<typeof templateDoc>) => void) => { const d = templateDoc(); edit(d); return d }

describe('judgeDoc', () => {
  it('nothing changed: nothing judged', () => {
    expect([...judgeDoc(doc, templateDoc())]).toEqual([])
  })

  it('a slot added, an Auto group switched on, a factor up, a placement up, a higher least budget, isolation off: raise', () => {
    expect(judgeDoc(doc, changed((d) => d.structure.slots.push({ ...d.structure.slots[1], key: 'phrase-category', match: 'PHRASE' }))).get('structure')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.structure.slots[0].autoGroups!.SUBSTITUTES = { on: true, factor: 1 } })).get('structure')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.bids.ladder.auto = 1.5 })).get('bids')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.placements.pat.productPage = 40 })).get('placements')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.placements.auto = { top: 5, productPage: 0, restOfSearch: 0 } })).get('placements')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.budget.minPerSlotCents = 500 })).get('budget')).toBe('raise')
    expect(judgeDoc(doc, changed((d) => { d.isolation.exactIntoResearch = false })).get('isolation')).toBe('raise')
  })

  it('the opposite of each: lower', () => {
    expect(judgeDoc(doc, changed((d) => { d.structure.slots = d.structure.slots.filter((s) => s.key !== 'pat') })).get('structure')).toBe('lower')
    expect(judgeDoc(doc, changed((d) => { d.bids.ladder.auto = 0.5 })).get('bids')).toBe('lower')
    expect(judgeDoc(doc, changed((d) => { d.placements['exact-category'].top = 0 })).get('placements')).toBe('lower')
    expect(judgeDoc(doc, changed((d) => { d.isolation.phraseIntoBroadAndAuto = true })).get('isolation')).toBe('lower')
  })

  it('weights, names, flows and hourly plans add no spend by themselves: same; PB-9 — the phase table by what a switch would write', () => {
    const d = changed((x) => {
      x.budget.weights.auto = 40
      x.structure.naming.pattern = '{product} - {market} - {parts}'
      x.harvest.edges = []
      x.rank.roles.performance!.windows[0].endHour = 23
      x.phases.LAUNCH!.recipe.targetAcos = { from: 'breakEven', factor: 3 }
    })
    // A higher target factor would write a higher target at the next switch to LAUNCH: a raise now.
    expect(Object.fromEntries(judgeDoc(doc, d))).toEqual({ structure: 'same', budget: 'same', harvest: 'same', rank: 'same', phases: 'raise' })
    const lower = changed((x) => { x.phases.LAUNCH!.recipe.targetAcos = { from: 'breakEven', factor: 1, fallbackFactor: 1.5 } })
    expect(judgeDoc(doc, lower).get('phases')).toBe('lower')
  })

  it('a product that could not be built and now can: raise; one that now cannot: lower', () => {
    expect(judgeDoc(null, doc).get('structure')).toBe('raise')
    expect(judgeDoc(doc, null).get('structure')).toBe('lower')
  })
})

describe('the product\'s own numbers', () => {
  const terms = (over: Record<string, unknown>) => PRODUCT_TERMS.parse({ brand: ['test brand'], category: [{ text: 'test jacket' }], negatives: [{ text: 'test kids', match: 'PHRASE' }], ...over })

  it('money: a first or a higher one raises; a lower one, or none, lowers', () => {
    expect([judgeMoney(null, 100), judgeMoney(100, 120), judgeMoney(120, 100), judgeMoney(100, null), judgeMoney(100, 100)]).toEqual(['raise', 'raise', 'lower', 'lower', 'same'])
  })

  it('enrolling raises; leaving lowers', () => {
    expect([judgeEnrolled(false, true), judgeEnrolled(true, false), judgeEnrolled(true, true)]).toEqual(['raise', 'lower', 'same'])
  })

  it('terms: more positive terms or a term newly exact at start raise; a product negative removed raises; the opposite lowers', () => {
    const base = terms({})
    expect(judgeTerms(base, terms({ competitor: ['rival jacket'] }))).toBe('raise')
    expect(judgeTerms(base, terms({ category: [{ text: 'test jacket', exactAtStart: true }] }))).toBe('raise')
    expect(judgeTerms(base, terms({ negatives: [] }))).toBe('raise')
    expect(judgeTerms(base, terms({ brand: [] }))).toBe('lower')
    expect(judgeTerms(base, terms({ negatives: [{ text: 'test kids', match: 'PHRASE' }, { text: 'test toy', match: 'EXACT' }] }))).toBe('lower')
    expect(judgeTerms(base, terms({}))).toBe('same')
  })
})

describe('absoluteRecipes', () => {
  it('with a break-even and a base bid: every number made absolute in the strategy\'s units', () => {
    const phases = changed((d) => { d.phases.GROW!.recipe = { ...d.phases.GROW!.recipe, bidBand: { minFactor: 0.5, maxFactor: 2 }, maxChangePct: 20, negate: { minClicks: 15, maxOrders: 0, windowDays: 30, minSpendFactor: 10 } } }).phases
    const { recipes, notes } = absoluteRecipes(phases, { breakEvenPct: 40, marketTargetPct: 30, baseBidCents: 35 })
    expect(recipes.LAUNCH).toMatchObject({ targetAcosPct: 52, harvestMinOrders: 1, harvestWindowDays: 30, negateMinClicks: 25 })
    expect(recipes.GROW).toEqual({
      targetAcosPct: 30, minBidCents: 18, maxBidCents: 70, maxChangePct: 20, harvestMinOrders: 2, harvestMinClicks: 0, harvestWindowDays: 30,
      negateMinClicks: 15, negateMaxOrders: 0, negateWindowDays: 30, negateMinSpendCents: 350,
    })
    // PROFIT's harvest ceiling: a share of its own target (0.8 × 40 = 32).
    expect(recipes.PROFIT).toMatchObject({ targetAcosPct: 32, harvestMaxAcosPct: 32 })
    expect(notes).toEqual([])
  })

  it('without costs: the fallback × the market\'s target, said; without a base bid: the band and the spend left out, said', () => {
    const phases = changed((d) => { d.phases.GROW!.recipe.bidBand = { maxFactor: 2 } }).phases
    const { recipes, notes } = absoluteRecipes(phases, { breakEvenPct: null, marketTargetPct: 30, baseBidCents: null })
    expect(recipes.LAUNCH!.targetAcosPct).toBe(45)
    expect(recipes.PROFIT!.targetAcosPct).toBe(30)
    expect(recipes.GROW).not.toHaveProperty('maxBidCents')
    expect(notes).toEqual(expect.arrayContaining([
      "LAUNCH: no cost data for a break-even ACoS, so its target is 1.5 × the market's target",
      "GROW: no base bid, so its bid band is left to the strategy",
    ]))
  })
})
