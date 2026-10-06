/**
 * ADS PLAYBOOK PB-4 — compiling a product's playbook into the blueprint engine's plan (compile.ts), pure, and that
 * engine's own gate over it (`evaluatePlan`). Values are made up.
 *
 *   names       {product} {market} {parts}; a name Amazon refuses is said
 *   budgets     shares of the product's daily budget, at least the least budget per slot
 *   bids        base bid × ladder, clamped to the strategy's band and never under 2¢; Auto groups × their factor
 *   terms       each slot's feeds; category and competitor keywords gated; competitor ASINs as product targets
 *   negatives   the product's own in keyword and Auto slots (never PAT); isolation as the template says; a negative
 *               phrase over 4 words left out; never a negative of a positive the slot buys
 *   linked      a slot the product holds is not built
 *   problems    no name token, daily budget or base bid: nothing compiles
 *   gate        a gated term another campaign buys blocks until skipped or accepted; a market without writes blocks
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { evaluatePlan } from '../../ads-core/ads-blueprint-apply.js'
import { blueprintOf, compilePlaybook, type CompileInput } from './compile.js'
import { PRODUCT_TERMS } from './doc.js'

const terms = PRODUCT_TERMS.parse({
  brand: ['testtoken jacket'],
  category: [{ text: 'test jacket', exactAtStart: true }, { text: 'test rain jacket' }],
  competitor: ['rival jacket'],
  competitorAsins: ['B0TESTRIV1'],
  negatives: [{ text: 'test kids', match: 'PHRASE' }, { text: 'test very long negative phrase here', match: 'PHRASE' }],
})
const input = (over: Partial<CompileInput> = {}): CompileInput => ({
  market: 'IT',
  doc: templateDoc(),
  product: { nameToken: 'TESTTOKEN', dailyBudgetCents: 10_000, baseBidCents: 40, terms },
  asins: ['B0TESTAAA1', 'B0TESTAAA2'],
  band: { minBidCents: null, maxBidCents: null },
  ...over,
})
const slotOf = (out: ReturnType<typeof compilePlaybook>, key: string) => out.campaigns.find((c) => c.role === key)!
const targetsOf = (out: ReturnType<typeof compilePlaybook>, key: string) => slotOf(out, key).adGroups[0].targets

describe('compilePlaybook', () => {
  const out = compilePlaybook(input())

  it('one campaign per slot with one ad group, named from the pattern, advertising the product\'s ASINs', () => {
    expect(out.problems).toEqual([])
    expect(out.campaigns.map((c) => c.name)).toEqual([
      'TESTTOKEN | IT | Auto', 'TESTTOKEN | IT | Broad | Category', 'TESTTOKEN | IT | Exact | Category', 'TESTTOKEN | IT | Exact | Brand', 'TESTTOKEN | IT | PAT',
    ])
    expect(slotOf(out, 'auto')).toMatchObject({ targetingType: 'AUTO', biddingStrategy: 'LEGACY_FOR_SALES' })
    expect(slotOf(out, 'pat').adGroups[0]).toMatchObject({ name: 'TESTTOKEN | IT | PAT', asins: ['B0TESTAAA1', 'B0TESTAAA2'] })
  })

  it('budgets are shares of the daily budget; start bids the ladder; Auto groups at their factor', () => {
    // Weights 15/20/35/10/20 of 100 → 15.00, 20.00, 35.00, 10.00, 20.00.
    expect(out.campaigns.map((c) => c.dailyBudget)).toEqual([15, 20, 35, 10, 20])
    expect(out.dailyBudgetCents).toBe(10_000)
    expect(out.slots.map((s) => [s.key, s.startBidCents])).toEqual([['auto', 40], ['broad-category', 36], ['exact-category', 52], ['exact-brand', 48], ['pat', 44]])
    expect(targetsOf(out, 'auto').filter((t) => t.kind === 'AUTO').map((t) => [t.autoClause, t.bidCents])).toEqual([['CLOSE_MATCH', 40], ['LOOSE_MATCH', 32]])
    expect(slotOf(out, 'exact-category').placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 25 }])
  })

  it('each slot buys its feeds; category and competitor keywords are gated; competitor ASINs are product targets', () => {
    const positives = (key: string) => targetsOf(out, key).filter((t) => !t.isNegative)
    expect(positives('broad-category').map((t) => [t.expression, t.expressionType, t.gated])).toEqual([['test jacket', 'BROAD', true], ['test rain jacket', 'BROAD', true]])
    expect(positives('exact-category').map((t) => t.expression)).toEqual(['test jacket'])
    expect(positives('exact-brand').map((t) => [t.expression, t.gated])).toEqual([['testtoken jacket', undefined]])
    expect(positives('pat').map((t) => [t.kind, t.expression])).toEqual([['PRODUCT', 'B0TESTRIV1']])
  })

  it('negatives: the product\'s own in keyword and Auto slots, never PAT; exact keywords negated in research; brand phrase in category', () => {
    const negatives = (key: string) => targetsOf(out, key).filter((t) => t.isNegative).map((t) => `${t.expressionType} ${t.expression}`).sort()
    expect(negatives('auto')).toEqual(['EXACT test jacket', 'EXACT testtoken jacket', 'PHRASE test kids'])
    expect(negatives('broad-category')).toEqual(['EXACT test jacket', 'EXACT testtoken jacket', 'PHRASE test kids', 'PHRASE testtoken jacket'])
    // An exact slot keeps what it buys: no negative of its own positive.
    expect(negatives('exact-category')).toEqual(['PHRASE test kids', 'PHRASE testtoken jacket'])
    expect(negatives('exact-brand')).toEqual(['PHRASE test kids'])
    expect(negatives('pat')).toEqual([])
    expect(out.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/over Amazon's 4-word limit/)]))
  })

  it('phrase into Broad and Auto when the template turns it on', () => {
    const doc = templateDoc()
    doc.isolation.phraseIntoBroadAndAuto = true
    doc.structure.slots.push({ ...doc.structure.slots[1], key: 'phrase-category', match: 'PHRASE', nameParts: ['Phrase', 'Category'] })
    doc.bids.ladder['phrase-category'] = 1
    const phrased = compilePlaybook(input({ doc }))
    expect(targetsOf(phrased, 'broad-category').filter((t) => t.isNegative && t.expressionType === 'PHRASE').map((t) => t.expression).sort())
      .toEqual(['test kids', 'testtoken jacket'])
    expect(targetsOf(phrased, 'auto').filter((t) => t.isNegative && t.expressionType === 'PHRASE').map((t) => t.expression).sort())
      .toEqual(['test jacket', 'test kids', 'test rain jacket'])
  })

  it('the strategy\'s band clamps the ladder (and says so); a linked slot is not built; the least budget per slot holds', () => {
    const clamped = compilePlaybook(input({ band: { minBidCents: 38, maxBidCents: 45 }, linkedSlots: new Set(['exact-brand']) }))
    expect(clamped.slots.find((s) => s.key === 'exact-category')).toMatchObject({ startBidCents: 45, ladderBidCents: 52 })
    expect(clamped.slots.find((s) => s.key === 'broad-category')).toMatchObject({ startBidCents: 38, ladderBidCents: 36 })
    expect(clamped.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/bid band clamps the start bid of broad-category, exact-category/)]))
    expect(clamped.campaigns.map((c) => c.role)).not.toContain('exact-brand')
    expect(clamped.slots.find((s) => s.key === 'exact-brand')).toMatchObject({ linked: true, campaignId: null })
    const tiny = compilePlaybook(input({ product: { nameToken: 'TESTTOKEN', dailyBudgetCents: 200, baseBidCents: 40, terms } }))
    expect(tiny.campaigns.every((c) => c.dailyBudget === 1)).toBe(true)
  })

  it('without a name token, a daily budget or a base bid nothing compiles, and it says why', () => {
    const none = compilePlaybook(input({ product: { nameToken: null, dailyBudgetCents: null, baseBidCents: null, terms } }))
    expect(none.campaigns).toEqual([])
    expect(none.problems).toHaveLength(3)
  })
})

describe('the blueprint gate over a compiled playbook', () => {
  const out = compilePlaybook(input())
  const target = { productToken: 'TESTTOKEN', asins: ['B0TESTAAA1'] }
  const excluded = { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }
  const market = { marketplace: 'IT', writable: true, everWritten: true }
  const clone = () => JSON.parse(JSON.stringify(out.campaigns))

  it('nothing else buys its terms and the market takes writes: allowed', () => {
    const plan = evaluatePlan(clone(), excluded, blueprintOf(out.campaigns, 'TESTTOKEN', templateDoc()), target, [], { market })
    expect(plan).toMatchObject({ allowed: true, blockers: [] })
    expect(plan.totals).toMatchObject({ campaigns: 5, adGroups: 5 })
  })

  it('a gated term another campaign buys blocks until accepted; a brand term never does; a market without writes blocks', () => {
    const existing = [
      { expression: 'test jacket', campaignName: 'Other product', campaignId: 'c-other' },
      { expression: 'testtoken jacket', campaignName: 'Other product', campaignId: 'c-other' },
    ]
    const doc = blueprintOf(out.campaigns, 'TESTTOKEN', templateDoc())
    const blocked = evaluatePlan(clone(), excluded, doc, target, existing, { market })
    expect(blocked.allowed).toBe(false)
    expect(blocked.conflicts.map((c) => c.expression)).toEqual(['test jacket'])
    expect(evaluatePlan(clone(), excluded, doc, target, existing, { market, acceptSharedTargets: ['test jacket'] }).allowed).toBe(true)
    const closed = evaluatePlan(clone(), excluded, doc, target, [], { market: { ...market, writable: false } })
    expect(closed.blockers.join('\n')).toMatch(/no writable production Amazon Ads connection, so all 5 campaigns/)
  })
})
