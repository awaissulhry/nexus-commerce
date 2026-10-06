/**
 * ADS PLAYBOOK PB-2 — the playbook's shapes (doc.ts) and its default sections (defaults.ts), pure. Values are made up.
 *
 *   template   a whole doc reads, with its defaults; every section reads alone; a doc that names a slot it does not
 *              have (a weight, a ladder entry, a placement, a harvest edge, a phase, a light rank plan), names a slot
 *              twice, gives a keyword slot no match type or forgets {parts} in the names is refused, each problem named
 *   overrides  any whole section and skipSlots; an unknown section is refused
 *   product    terms and phase recipes read in their own units; an ASIN must look like one
 *   defaults   the harvest edges follow the slots (an intent's Broad/Phrase → its Exact; Auto → the intent router; the
 *              research slots → PAT); the phase table keys are the strategy's goals; CLEAR_STOCK doubles the Auto share
 *   money      the playbook's money keys are the strategy's and the product row's budget and bids
 */
import { describe, expect, it } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { STRATEGY_GOALS, STRATEGY_MONEY } from '../ads-strategy/fields.js'
import { defaultHarvest, defaultPhases } from './defaults.js'
import {
  checkTemplateDoc,
  OVERRIDES,
  PHASE_RECIPES,
  PLAYBOOK_MONEY,
  PRODUCT_TERMS,
  readSection,
  SECTIONS,
  SLOT,
  TEMPLATE_DOC,
} from './doc.js'

const problemsOf = (value: unknown) => {
  const out = checkTemplateDoc(value)
  return 'problems' in out ? out.problems : []
}

describe('the template doc', () => {
  it('a whole doc reads, and every section reads alone', () => {
    const doc = templateDoc()
    const out = checkTemplateDoc(doc)
    expect(out).toHaveProperty('doc')
    expect(Object.keys(TEMPLATE_DOC.shape)).toEqual([...SECTIONS])
    for (const key of SECTIONS) expect(readSection(key, doc[key]), key).toHaveProperty('value')
  })

  it('shared terms default to skip: a term the product already buys elsewhere stays there (Owner rule 2)', () => {
    const doc = templateDoc() as unknown as { structure: Record<string, unknown> }
    delete doc.structure.sharedTerms
    const out = checkTemplateDoc(doc)
    expect('doc' in out && out.doc.structure.sharedTerms).toBe('skip')
  })

  it('a slot gets its defaults: no rank role, no feeds, down-only bidding, not optional', () => {
    expect(SLOT.parse({ key: 'phrase-category', targeting: 'KEYWORD', match: 'PHRASE', intent: 'CATEGORY', nameParts: ['Phrase', 'Category'] }))
      .toMatchObject({ rankRole: 'none', feeds: [], biddingStrategy: 'LEGACY_FOR_SALES', optional: false })
    expect(SLOT.safeParse({ key: 'Exact Brand', targeting: 'KEYWORD', intent: 'BRAND', nameParts: ['x'] }).success).toBe(false)
  })

  it('a doc naming a slot it does not have is refused, each reference named', () => {
    const doc = templateDoc()
    doc.budget.weights.ghost = 5
    doc.bids.ladder.ghost = 1
    doc.placements.ghost = { top: 0, productPage: 0, restOfSearch: 0 }
    doc.harvest.edges.push({ from: ['ghost'], to: 'exact-category', what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true })
    doc.phases.DEFEND!.slots.ghost = 'floor'
    expect(problemsOf(doc)).toEqual(expect.arrayContaining([
      'budget.weights: no slot "ghost"', 'bids.ladder: no slot "ghost"', 'placements: no slot "ghost"',
      'harvest.edges.3.from: no slot "ghost"', 'phases.DEFEND.slots: no slot "ghost"',
    ]))
  })

  it('a slot twice, a keyword slot without a match type, a slot with no start-bid factor, names without {parts}: refused', () => {
    const doc = templateDoc()
    doc.structure.slots.push({ ...doc.structure.slots[1] })
    doc.structure.slots[2] = { ...doc.structure.slots[2], match: undefined }
    delete doc.bids.ladder.pat
    doc.structure.naming.pattern = '{product} | {market}'
    expect(problemsOf(doc)).toEqual(expect.arrayContaining([
      'structure.slots: the slot key "broad-category" is used twice',
      'structure.slots.exact-category: a keyword slot needs a match type',
      'bids.ladder: the slot "pat" has no start bid factor',
      'structure.naming.pattern: it needs {parts}, or every slot would get the same name',
    ]))
  })

  it('a rank role a slot plays must have a plan; a "light" phase needs the role\'s light plan', () => {
    const doc = templateDoc()
    delete doc.rank.roles.research
    doc.phases.PROFIT!.rank.performance = 'light'
    expect(problemsOf(doc)).toEqual(expect.arrayContaining([
      'structure.slots.auto: the rank role "research" has no plan in the rank section',
      'phases.PROFIT.rank.performance: "light" needs the role\'s light plan',
    ]))
  })

  it('a section that does not read is refused under its own name', () => {
    const doc = templateDoc() as unknown as Record<string, any>
    doc.placements.pat.top = 901
    doc.isolation = { exactIntoResearch: true }
    expect(problemsOf(doc).join('\n')).toMatch(/placements\.pat\.top/)
    expect(problemsOf(doc).join('\n')).toMatch(/isolation\.brandPhraseIntoCategoryAndCompetitor/)
  })
})

describe('overrides, terms and recipes', () => {
  it('overrides hold whole sections and skipSlots; an unknown section is refused', () => {
    const doc = templateDoc()
    expect(OVERRIDES.safeParse({ budget: doc.budget, skipSlots: ['exact-brand'] }).success).toBe(true)
    expect(OVERRIDES.safeParse({ budgets: doc.budget }).success).toBe(false)
  })

  it('terms read with their defaults; an ASIN must look like one', () => {
    expect(PRODUCT_TERMS.parse({ brand: ['test brand'], category: [{ text: 'test jacket' }] })).toEqual({
      brand: ['test brand'], category: [{ text: 'test jacket', exactAtStart: false }], competitor: [], competitorAsins: [], negatives: [],
    })
    expect(PRODUCT_TERMS.safeParse({ competitorAsins: ['NOT-AN-ASIN'] }).success).toBe(false)
  })

  it('phase recipes use the strategy\'s field names, whole percents and minor units', () => {
    expect(PHASE_RECIPES.safeParse({ LAUNCH: { targetAcosPct: 30, maxBidCents: 90, harvestMinOrders: 1 } }).success).toBe(true)
    expect(PHASE_RECIPES.safeParse({ LAUNCH: { targetAcosPct: 0.3 } }).success).toBe(false)
    expect(PHASE_RECIPES.safeParse({ SOMETIME: {} }).success).toBe(false)
  })
})

describe('the default sections', () => {
  const slots = templateDoc().structure.slots

  it('harvest edges follow the slots: Broad → Exact of the intent, Auto → the intent router, research → PAT', () => {
    expect(defaultHarvest(slots).edges).toEqual([
      { from: ['broad-category'], to: 'exact-category', what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true },
      { from: ['auto'], to: { router: 'intent', brand: 'exact-brand', competitor: 'exact-category', category: 'exact-category' }, what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true },
      { from: ['auto', 'broad-category'], to: 'pat', what: 'ASIN_PRODUCT', startBid: { mode: 'cpc' }, negateSource: true },
    ])
  })

  it('the phase table is keyed by the strategy\'s goals; DEFEND floors the research slots; CLEAR_STOCK doubles the Auto share', () => {
    const phases = defaultPhases(slots, { auto: 15, 'broad-category': 20, 'exact-category': 35, 'exact-brand': 10, pat: 20 })
    expect(Object.keys(phases).sort()).toEqual([...STRATEGY_GOALS].sort())
    expect(phases.DEFEND!.slots).toEqual({ auto: 'floor', 'broad-category': 'floor' })
    expect(phases.CLEAR_STOCK!.weights).toMatchObject({ auto: 30, 'exact-category': 35 })
    expect(phases.LAUNCH!.exit[0]).toMatchObject({ to: 'GROW' })
  })
})

describe('money', () => {
  it('the playbook\'s money keys are the strategy\'s, the product row\'s budget and bids, and the least budget per slot', () => {
    for (const key of Object.keys(STRATEGY_MONEY)) expect(PLAYBOOK_MONEY[key], key).toBe(FIELDS.financialsAdspendView)
    for (const key of ['dailyBudgetCents', 'baseBidCents', 'minPerSlotCents', 'startBidCents']) expect(PLAYBOOK_MONEY[key], key).toBe(FIELDS.financialsAdspendView)
    // A share and a factor are not money.
    for (const key of ['weights', 'ladder', 'budgetSharePct', 'startBidFactor']) expect(PLAYBOOK_MONEY[key]).toBeUndefined()
  })
})
