/**
 * ADS PLAYBOOK PB-6c — a winner's own campaign (a hero), planned, pure (hero.ts heroPlan). The fixture template (Auto,
 * Broad and Exact category, Exact brand, PAT). Values are made up (public repo).
 *
 *   one        ONE campaign, ONE exact keyword (the term), the product's own ASINs and negatives, its role the link key
 *   model      the Exact slot of the term's intent (the router: brand words → Exact | Brand, else Exact | Category); a
 *              missing intent slot falls back to the Category one, said
 *   lock       a negative that would block the hero's own keyword is left out (L1), said
 *   bid        the term's cost per click where it runs, else the model slot's ladder — inside the strategy's band
 *   budget     the term's daily spend, at least the least per slot, at most the product's daily budget
 *   name       the playbook's naming with "Hero" and the term; a name Amazon refuses is a problem
 *   one each   a term with a hero already, an ASIN, a playbook with no Exact slot: refused by name
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { HERO_KEY, heroKey, heroPlan, modelSlotFor, phaseSlotOf, type HeroInput } from './hero.js'
import type { ProductTerms } from './doc.js'

const terms: ProductTerms = {
  brand: ['testh jacket'], category: [{ text: 'test jacket', exactAtStart: true }], competitor: ['rivalx'], competitorAsins: [],
  negatives: [{ text: 'test kids', match: 'PHRASE' }, { text: 'cheap', match: 'EXACT' }],
}
const input = (over: Partial<HeroInput> = {}): HeroInput => ({
  market: 'IT', doc: templateDoc(), nameToken: 'TESTH', term: 'test coat', terms, asins: ['B0TESTHE01', 'B0TESTHE02'],
  band: { minBidCents: null, maxBidCents: null }, baseBidCents: 40, dailyBudgetCents: 2000, cpcCents: 37, dailySpendCents: 450,
  heroKeys: new Set(), ...over,
})
const keywords = (p: ReturnType<typeof heroPlan>) => p.campaign!.adGroups[0].targets.filter((t) => !t.isNegative)
const negatives = (p: ReturnType<typeof heroPlan>) => p.campaign!.adGroups[0].targets.filter((t) => t.isNegative).map((t) => `${t.expressionType}:${t.expression}`)

describe('one campaign, one exact keyword', () => {
  it('a category term: modelled on Exact | Category, its name, the product ads and negatives, its placements, the link key', () => {
    const p = heroPlan(input())
    expect(p.problems).toEqual([])
    expect(p).toMatchObject({ key: 'hero:test coat', term: 'test coat', intent: 'CATEGORY', modelSlot: 'exact-category', ownIntent: true, bidFrom: 'cpc', budgetFrom: 'spend' })
    expect(p.campaign).toMatchObject({ role: 'hero:test coat', name: 'TESTH | IT | Exact | Category | Hero | test coat', targetingType: 'MANUAL', dailyBudget: 4.5 })
    expect(p.campaign!.adGroups).toHaveLength(1)
    expect(p.campaign!.adGroups[0].asins).toEqual(['B0TESTHE01', 'B0TESTHE02'])
    expect(keywords(p).map((t) => [t.kind, t.expressionType, t.expression, t.bidCents])).toEqual([['KEYWORD', 'EXACT', 'test coat', 37]])
    // The product's own negatives, and the template's brand phrase for a category slot (it blocks nothing here).
    expect(negatives(p).sort()).toEqual(['EXACT:cheap', 'PHRASE:test kids', 'PHRASE:testh jacket'])
    expect(p.negatives).toBe(3)
    expect(p.campaign!.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 25 }])
    expect(p.slot).toMatchObject({ key: 'hero:test coat', keywords: 1, negatives: 3, startBidCents: 37 })
    expect(HERO_KEY.safeParse(p.key).success).toBe(true)
    expect(heroKey('  Test   COAT ')).toBe('hero:test coat')
  })

  it('a brand term: modelled on Exact | Brand, with no brand phrase negative', () => {
    const p = heroPlan(input({ term: 'testh jacket black' }))
    expect(p).toMatchObject({ intent: 'BRAND', modelSlot: 'exact-brand', ownIntent: true })
    expect(p.campaign!.name).toBe('TESTH | IT | Exact | Brand | Hero | testh jacket black')
    expect(negatives(p).sort()).toEqual(['EXACT:cheap', 'PHRASE:test kids'])
  })

  it('no Exact slot of its intent: the Category one, said; a negative that would block its own keyword is left out (L1)', () => {
    const doc = templateDoc()
    doc.structure.slots = doc.structure.slots.filter((s) => s.key !== 'exact-brand')
    expect(modelSlotFor(doc, 'BRAND')).toMatchObject({ slot: { key: 'exact-category' }, own: false })
    const p = heroPlan(input({ doc, term: 'testh jacket black' }))
    expect(p).toMatchObject({ intent: 'BRAND', modelSlot: 'exact-category', ownIntent: false })
    expect(p.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/no Exact slot for brand terms: the hero is modelled on "exact-category"/),
      expect.stringMatching(/The negative phrase "testh jacket" would block the hero's own keyword: left out of it/),
    ]))
    expect(negatives(p)).not.toContain('PHRASE:testh jacket')
    expect(keywords(p).map((t) => t.expression)).toEqual(['testh jacket black'])
  })
})

describe('bid and budget: the term\'s own numbers, inside the playbook and the strategy', () => {
  it('the cost per click, clamped to the band; no clicks → the model slot\'s ladder', () => {
    const clamped = heroPlan(input({ cpcCents: 300, band: { minBidCents: null, maxBidCents: 100 } }))
    expect(keywords(clamped)[0].bidCents).toBe(100)
    expect(clamped.warnings).toContain("The strategy's bid band clamps the hero's planned bid")
    const ladder = heroPlan(input({ cpcCents: null }))
    expect(ladder.bidFrom).toBe('ladder')
    expect(keywords(ladder)[0].bidCents).toBe(52) // 40 × 1.3, the Exact | Category ladder
    // Two strategies, two bids: the band is the strategy's.
    expect(keywords(heroPlan(input({ band: { minBidCents: 45, maxBidCents: null } })))[0].bidCents).toBe(45)
    expect(keywords(heroPlan(input({ band: { minBidCents: null, maxBidCents: 30 } })))[0].bidCents).toBe(30)
  })

  it('the daily spend, at least the least per slot, at most the product\'s daily budget', () => {
    expect(heroPlan(input({ dailySpendCents: 20 }))).toMatchObject({ budgetFrom: 'least', dailyBudgetCents: 100 })
    const doc = templateDoc()
    doc.budget.minPerSlotCents = 300
    expect(heroPlan(input({ doc, dailySpendCents: 20 }))).toMatchObject({ budgetFrom: 'least', dailyBudgetCents: 300 })
    expect(heroPlan(input({ dailySpendCents: 5000 }))).toMatchObject({ budgetFrom: 'productBudget', dailyBudgetCents: 2000 })
    expect(heroPlan(input({ dailySpendCents: 450.2 }))).toMatchObject({ budgetFrom: 'spend', dailyBudgetCents: 451 })
  })

  it('never above the product\'s daily budget, even where it is below the least budget per slot', () => {
    const doc = templateDoc()
    doc.budget.minPerSlotCents = 300
    const p = heroPlan(input({ doc, dailyBudgetCents: 200, dailySpendCents: 20 }))
    expect(p).toMatchObject({ budgetFrom: 'productBudget', dailyBudgetCents: 200 })
    expect(p.warnings).toContain("The product's daily budget is below the playbook's least budget per slot: the hero gets the product's daily budget")
  })

  it('approved (frozen): the bid and budget as approved, whatever the term\'s CPC and spend now; a band that moved refuses it', () => {
    const p = heroPlan(input({ frozen: { bidCents: 44, dailyBudgetCents: 333 }, cpcCents: 99, dailySpendCents: 9999 }))
    expect(p).toMatchObject({ bidFrom: 'approved', budgetFrom: 'approved', dailyBudgetCents: 333, problems: [] })
    expect(keywords(p)[0].bidCents).toBe(44)
    const moved = heroPlan(input({ frozen: { bidCents: 44, dailyBudgetCents: 333 }, band: { minBidCents: null, maxBidCents: 40 } }))
    expect(moved.problems).toEqual(["the bid approved for it is outside the ads strategy's bid band at this product now, so it is not built as approved: ask again"])
    expect(moved.campaign).toBeNull()
  })
})

describe('the phase table (PB-9): a hero plays the Exact slot it is modelled on', () => {
  it('a brand term plays Exact | Brand, a category term Exact | Category; any other link its own key', () => {
    const doc = templateDoc()
    expect(phaseSlotOf('hero:testh jacket black', doc, 'TESTH', terms)).toBe('exact-brand')
    expect(phaseSlotOf('hero:test coat', doc, 'TESTH', terms)).toBe('exact-category')
    expect(phaseSlotOf('broad-category', doc, 'TESTH', terms)).toBe('broad-category')
  })
})

describe('refused by name', () => {
  it('one hero per term, never an ASIN, a playbook with an Exact slot, a name Amazon takes, a bid to plan', () => {
    expect(heroPlan(input({ heroKeys: new Set(['hero:test coat']) })).problems).toEqual(['"test coat" gets no campaign of its own: it has its own campaign already (one hero per term per product per market)'])
    expect(heroPlan(input({ term: 'B0RIVAL001' })).problems[0]).toMatch(/it is an ASIN: a hero holds one exact keyword/)
    const doc = templateDoc()
    doc.structure.slots = doc.structure.slots.filter((s) => s.match !== 'EXACT')
    expect(heroPlan(input({ doc })).problems[0]).toMatch(/the playbook has no Exact keyword slot/)
    expect(heroPlan(input({ doc: null })).problems[0]).toMatch(/the playbook does not compile/)
    expect(heroPlan(input({ term: 'test · coat' })).problems[0]).toMatch(/its campaign name cannot be used: .*Amazon refuses in names/)
    expect(heroPlan(input({ cpcCents: null, baseBidCents: null })).problems[0]).toMatch(/no clicks where it runs and the product row sets no base bid/)
    for (const p of [heroPlan(input({ term: 'B0RIVAL001' })), heroPlan(input({ doc: null }))]) expect(p.campaign).toBeNull()
  })
})
