/**
 * ADS PLAYBOOK PB-2 — capture a template from live campaigns (capture.ts), pure. A made-up eleven-campaign set
 * ("TESTPROD | IT | <match> | <intent>", Auto and PAT) with two hourly plans; values are made up (public repo).
 *
 *   slots       each campaign becomes one slot with its match type and intent from its name (else from its keywords),
 *               its name words, bidding strategy, budget share, start-bid factor, placements and Auto groups
 *   naming      the names with the token, the market and the slot words taken out; the portfolio name likewise
 *   product     its token, daily budget (the sum), base bid (the middle start bid), and its terms: brand, category
 *               (exact at start where an Exact slot holds it), competitor, competitor ASINs, the negatives every slot has
 *   rank        the plan that pushes the most hours is performance, the other research; a third plan is named, not kept
 *   isolation   the cross-negatives the live set carries are detected; the doc passes the template checks
 *   honesty     floor bids name no start bid; a campaign whose name says nothing is read from its keywords, with warnings
 *   floors      under an engine's floor (the campaign's or an ad group's own) the bid held before the floor is read, and
 *               each slot says so; a floor with nothing remembered keeps the warning; budget shares add up to 100
 */
import { describe, expect, it } from 'vitest'
import { fixtureTargets as t, liveCampaign } from '../../../test-support/ads-playbook-fixtures.js'
import { budgetShares, captureTemplate, type CaptureInput } from './capture.js'

const NAME = (parts: string) => `TESTPROD | IT | ${parts}`
const NEG = [t.negative('test kids', 'PHRASE'), t.negative('test toy', 'EXACT')]
const brandTerms = ['testprod jacket', 'testprod coat']
const categoryTerms = ['test jacket', 'test coat', 'test rain jacket']
const competitorTerms = ['rivalco jacket']

function elevenCampaigns(): CaptureInput['campaigns'] {
  const kw = (terms: string[], match: string, bid: number) => terms.map((x) => t.keyword(x, match, bid))
  const set: Array<[string, ReturnType<typeof liveCampaign>]> = [
    ['c-auto', liveCampaign(NAME('Auto'), [t.auto('QUERY_HIGH_REL_MATCHES', 25), t.auto('QUERY_BROAD_REL_MATCHES', 20), t.auto('ASIN_SUBSTITUTE_RELATED', 25), ...NEG,
      // Isolation: an exact keyword of the product, negated in Auto.
      t.negative('test jacket', 'EXACT')], { targetingType: 'AUTO', dailyBudget: 12 })],
    ['c-bb', liveCampaign(NAME('Broad | Brand'), [...kw(brandTerms, 'BROAD', 22), ...NEG], { dailyBudget: 4 })],
    ['c-bc', liveCampaign(NAME('Broad | Competitor'), [...kw(competitorTerms, 'BROAD', 26), ...NEG], { dailyBudget: 8 })],
    ['c-bk', liveCampaign(NAME('Broad | Category'), [...kw(categoryTerms, 'BROAD', 30), ...NEG], { dailyBudget: 18 })],
    ['c-pb', liveCampaign(NAME('Phrase | Brand'), [...kw(brandTerms, 'PHRASE', 24), ...NEG], { dailyBudget: 4 })],
    ['c-pc', liveCampaign(NAME('Phrase | Competitor'), [...kw(competitorTerms, 'PHRASE', 28), ...NEG], { dailyBudget: 10 })],
    ['c-pk', liveCampaign(NAME('Phrase | Category'), [...kw(categoryTerms, 'PHRASE', 35), ...NEG,
      // Isolation: a brand term, negated (phrase) in a category slot.
      t.negative('testprod jacket', 'PHRASE')], { dailyBudget: 20, placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 10 }] })],
    ['c-eb', liveCampaign(NAME('Exact | Brand'), [...kw(brandTerms, 'EXACT', 28), ...NEG], { dailyBudget: 6 })],
    ['c-ec', liveCampaign(NAME('Exact | Competitor'), [...kw(competitorTerms, 'EXACT', 34), ...NEG], { dailyBudget: 14 })],
    ['c-ek', liveCampaign(NAME('Exact | Category'), [...kw(categoryTerms.slice(0, 2), 'EXACT', 42), ...NEG],
      { dailyBudget: 34, placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 25 }] })],
    ['c-pat', liveCampaign(NAME('PAT'), [t.asin('B0TESTRIV1', 38), t.asin('B0TESTRIV2', 38)], { dailyBudget: 20,
      placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 10 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }] })],
  ]
  return set.map(([id, source]) => ({ id, source }))
}

const performance = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 21, targetKey: 'test-own-top' }, { days: [0, 6], startHour: 10, endHour: 20, targetKey: 'test-defend' }], defaultTargetKey: 'test-rest', timezone: 'Europe/Rome' }
const research = { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 7, targetKey: 'test-min-bid' }], defaultTargetKey: 'test-rest', timezone: 'Europe/Rome' }
const schedules = (): CaptureInput['schedules'] => [
  ...['c-eb', 'c-ec', 'c-ek', 'c-pat'].map((campaignId) => ({ campaignId, ...performance, targetOverrides: campaignId === 'c-ek' ? { 'test-own-top': { maxCpcCents: 90 } } : {} })),
  ...['c-auto', 'c-bb', 'c-bc', 'c-bk', 'c-pb', 'c-pc', 'c-pk'].map((campaignId) => ({ campaignId, ...research, targetOverrides: {} })),
]
const input = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  market: 'IT', productToken: 'TESTPROD', competitorTokens: [], campaigns: elevenCampaigns(), schedules: schedules(),
  floorTargets: new Set(['test-min-bid']), portfolioName: 'Test TESTPROD IT', ...over,
})

describe('capture — eleven live campaigns become a template', () => {
  const out = captureTemplate(input())
  const slot = (key: string) => out.doc!.structure.slots.find((s) => s.key === key)!

  it('passes the template checks; each campaign plays one slot, its key from its match type and intent', () => {
    expect(out.problems).toEqual([])
    expect(out.slots.map((s) => [s.campaignId, s.slotKey])).toEqual([
      ['c-auto', 'auto'], ['c-bb', 'broad-brand'], ['c-bc', 'broad-competitor'], ['c-bk', 'broad-category'],
      ['c-pb', 'phrase-brand'], ['c-pc', 'phrase-competitor'], ['c-pk', 'phrase-category'],
      ['c-eb', 'exact-brand'], ['c-ec', 'exact-competitor'], ['c-ek', 'exact-category'], ['c-pat', 'pat'],
    ])
    expect(slot('auto')).toMatchObject({ targeting: 'AUTO', intent: 'ANY', nameParts: ['Auto'], feeds: [] })
    expect(slot('exact-category')).toMatchObject({ targeting: 'KEYWORD', match: 'EXACT', intent: 'CATEGORY', nameParts: ['Exact', 'Category'], feeds: ['categoryExactAtStart'], optional: false })
    expect(slot('broad-brand')).toMatchObject({ feeds: ['brand'], optional: true })
    expect(slot('pat')).toMatchObject({ targeting: 'PRODUCT', intent: 'ANY', feeds: ['competitorAsins'] })
  })

  it('the names: the token, the market and the slot words taken out; the portfolio name likewise', () => {
    expect(out.doc!.structure.naming).toEqual({ pattern: '{product} | {market} | {parts}', partSeparator: ' | ' })
    expect(out.doc!.structure.portfolio).toEqual({ pattern: 'Test {product} {market}', mode: 'reuse-or-create' })
  })

  it('budget shares from the daily budgets; the product\'s daily budget is their sum; start bids as factors of the middle one', () => {
    expect(out.product.dailyBudgetCents).toBe(15000)
    expect(out.doc!.budget.weights).toMatchObject({ auto: 8, 'exact-category': 22.7, pat: 13.3 })
    expect(out.product.baseBidCents).toBe(28)
    expect(out.doc!.bids.ladder).toMatchObject({ 'exact-category': 1.5, 'broad-brand': 0.79, pat: 1.36 })
    expect(out.doc!.placements['exact-category']).toEqual({ top: 25, productPage: 0, restOfSearch: 0 })
    expect(out.doc!.placements.pat).toEqual({ top: 10, productPage: 15, restOfSearch: 0 })
  })

  it('Auto groups: the ones it runs are on, each bid as a factor of its start bid', () => {
    expect(slot('auto').autoGroups).toEqual({
      CLOSE_MATCH: { on: true, factor: 1 }, LOOSE_MATCH: { on: true, factor: 0.8 }, SUBSTITUTES: { on: true, factor: 1 }, COMPLEMENTS: { on: false, factor: 1 },
    })
  })

  it('the product\'s terms: brand, category with exact-at-start, competitor, competitor ASINs, and the negatives every slot has', () => {
    expect(out.product.terms.brand.sort()).toEqual([...brandTerms].sort())
    expect(out.product.terms.category).toEqual([
      { text: 'test jacket', exactAtStart: true }, { text: 'test coat', exactAtStart: true }, { text: 'test rain jacket', exactAtStart: false },
    ])
    expect(out.product.terms.competitor).toEqual(competitorTerms)
    expect(out.product.terms.competitorAsins).toEqual(['B0TESTRIV1', 'B0TESTRIV2'])
    expect(out.product.terms.negatives).toEqual([{ text: 'test kids', match: 'PHRASE' }, { text: 'test toy', match: 'EXACT' }])
  })

  it('rank: the plan that pushes the most hours is performance, the other research; a campaign keeps its own overrides', () => {
    expect(out.doc!.structure.slots.filter((s) => s.rankRole === 'performance').map((s) => s.key)).toEqual(['exact-brand', 'exact-competitor', 'exact-category', 'pat'])
    expect(out.doc!.structure.slots.filter((s) => s.rankRole === 'research')).toHaveLength(7)
    expect(out.doc!.rank.roles.performance).toMatchObject({ baseline: 'test-rest', timezone: 'Europe/Rome', windows: performance.windows, slotOverrides: { 'exact-category': { 'test-own-top': { maxCpcCents: 90 } } } })
    expect(out.doc!.rank.roles.research).toMatchObject({ baseline: 'test-rest', windows: research.windows })
  })

  it('isolation the live set carries is detected; harvest edges and phases are the defaults for these slots', () => {
    expect(out.doc!.isolation).toEqual({ exactIntoResearch: true, brandPhraseIntoCategoryAndCompetitor: true, phraseIntoBroadAndAuto: false })
    expect(out.doc!.harvest.edges.map((e) => [e.from, e.to])).toEqual([
      [['broad-brand', 'phrase-brand'], 'exact-brand'],
      [['broad-competitor', 'phrase-competitor'], 'exact-competitor'],
      [['broad-category', 'phrase-category'], 'exact-category'],
      [['auto'], { router: 'intent', brand: 'exact-brand', competitor: 'exact-competitor', category: 'exact-category' }],
      [['auto', 'broad-brand', 'broad-competitor', 'broad-category', 'phrase-brand', 'phrase-competitor', 'phrase-category'], 'pat'],
    ])
    expect(Object.keys(out.doc!.phases)).toEqual(['LAUNCH', 'GROW', 'PROFIT', 'CLEAR_STOCK', 'DEFEND'])
    expect(out.warnings.join('\n')).toMatch(/defaults for these slots: nothing live says them/)
  })
})

describe('capture — what it cannot know, it says', () => {
  it('a campaign at the floor names no start bid; a name that says nothing is read from its keywords', () => {
    const campaigns = [
      { id: 'c1', source: liveCampaign(NAME('Exact | Category'), [t.keyword('test jacket', 'EXACT', 2)], { dailyBudget: 5 }) },
      { id: 'c2', source: liveCampaign('TESTPROD misc', [t.keyword('test coat', 'PHRASE', 40), t.keyword('test cape', 'PHRASE', 40)], { dailyBudget: 5 }) },
    ]
    campaigns[0].source.adGroups[0].defaultBidCents = 2
    const out = captureTemplate(input({ campaigns, schedules: [] }))
    expect(out.slots.map((s) => s.slotKey)).toEqual(['exact-category', 'phrase-category'])
    expect(out.warnings.join('\n')).toMatch(/"TESTPROD \| IT \| Exact \| Category": every bid is at the floor/)
    expect(out.warnings.join('\n')).toMatch(/"TESTPROD misc": its name does not say brand, competitor or category; taken as category/)
    expect(out.warnings.join('\n')).toMatch(/None of these campaigns has an hourly plan/)
    expect(out.doc!.bids.ladder['exact-category']).toBe(1)
    expect(out.product.baseBidCents).toBe(40)
  })

  it('a third hourly plan is named, never merged into a role', () => {
    const third = { campaignId: 'c-pk', windows: [{ days: [3], startHour: 12, endHour: 13, targetKey: 'test-own-top' }], defaultTargetKey: null, timezone: 'Europe/Rome', targetOverrides: {} }
    const out = captureTemplate(input({ schedules: [...schedules().filter((s) => s.campaignId !== 'c-pk'), third] }))
    expect(out.warnings.join('\n')).toMatch(/3 different hourly plans; a playbook holds two .* "TESTPROD \| IT \| Phrase \| Category"/)
    expect(out.doc!.structure.slots.find((s) => s.key === 'phrase-category')!.rankRole).toBe('none')
  })

  it('no shared portfolio: the template builds none', () => {
    expect(captureTemplate(input({ portfolioName: null })).doc!.structure.portfolio).toEqual({ pattern: '{product} {market}', mode: 'none' })
  })
})

/** The set as an engine's floor holds it (an hourly plan's Min-bid window): every bid above 2¢ at 2¢, its bid remembered. */
function floored(campaigns: CaptureInput['campaigns'], by: string | null): CaptureInput['campaigns'] {
  return campaigns.map(({ id, source }) => ({
    id,
    source: {
      ...source,
      floor: { by },
      adGroups: source.adGroups.map((g) => ({
        ...g,
        defaultBidCents: 2,
        suppressedFromBidCents: g.defaultBidCents,
        targets: g.targets.map((x) => (x.isNegative || x.bidCents == null || x.bidCents <= 2 ? x : { ...x, bidCents: 2, suppressedFromBidCents: x.bidCents })),
      })),
    },
  }))
}

describe('capture — bids an engine holds at the floor', () => {
  it('a set the hourly plan holds at the floor captures the template it runs by day; each slot says it read the bid held before the floor', () => {
    const day = captureTemplate(input())
    const night = captureTemplate(input({ campaigns: floored(elevenCampaigns(), 'automation:test-rank') }))
    expect(night.problems).toEqual([])
    expect(night.doc).toEqual(day.doc)
    expect(night.product.baseBidCents).toBe(28)
    expect(night.doc!.bids.ladder).toMatchObject({ 'exact-category': 1.5, 'broad-brand': 0.79, pat: 1.36 })
    const held = night.warnings.filter((w) => /read the bid held before the floor/.test(w))
    expect(held).toHaveLength(11)
    expect(held).toContain('"TESTPROD | IT | Exact | Category": 3 bid(s) held at the floor; read the bid held before the floor (by automation:test-rank)')
    expect(night.warnings.join('\n')).not.toMatch(/every bid is at the floor/)
  })

  it('an ad group floored on its own is read the same way; its default bid too; a floor whose owner is not recorded says so', () => {
    const [own] = floored([{ id: 'c1', source: liveCampaign(NAME('Exact | Category'), [t.keyword('test jacket', 'EXACT', 40), t.keyword('test coat', 'EXACT', 50)], { dailyBudget: 5 }) }], null)
    const onItsOwn = { ...own.source, floor: null, adGroups: own.source.adGroups.map((g) => ({ ...g, floor: { by: 'automation:test-cap' } })) }
    // A product-targeting campaign whose targets carry no bid of their own: the ad group's default bid is its start bid.
    const [pat] = floored([{ id: 'c2', source: liveCampaign(NAME('PAT'), [t.asin('B0TESTRIV1', null)], { dailyBudget: 5 }) }], null)
    pat.source.adGroups[0].suppressedFromBidCents = 60
    const out = captureTemplate(input({ campaigns: [{ id: 'c1', source: onItsOwn }, pat], schedules: [] }))
    expect(out.problems).toEqual([])
    expect(out.product.baseBidCents).toBe(53)
    expect(out.doc!.bids.ladder).toEqual({ 'exact-category': 0.85, pat: 1.13 })
    expect(out.warnings).toContain('"TESTPROD | IT | Exact | Category": 3 bid(s) held at the floor; read the bid held before the floor (by automation:test-cap)')
    expect(out.warnings).toContain('"TESTPROD | IT | PAT": 1 bid(s) held at the floor; read the bid held before the floor (by an unrecorded owner)')
  })

  it('a floor with nothing remembered keeps the warning; a remembered bid without a floor is not read', () => {
    const atFloor = liveCampaign(NAME('Exact | Category'), [t.keyword('test jacket', 'EXACT', 2)], { dailyBudget: 5, floor: { by: 'automation:test-rank' } })
    atFloor.adGroups[0].defaultBidCents = 2
    const notFloored = liveCampaign(NAME('Phrase | Category'), [{ ...t.keyword('test coat', 'PHRASE', 40), suppressedFromBidCents: 90 }], { dailyBudget: 5 })
    const out = captureTemplate(input({ campaigns: [{ id: 'c1', source: atFloor }, { id: 'c2', source: notFloored }], schedules: [] }))
    expect(out.warnings.join('\n')).toMatch(/"TESTPROD \| IT \| Exact \| Category": every bid is at the floor/)
    expect(out.warnings.join('\n')).not.toMatch(/held before the floor/)
    expect(out.doc!.bids.ladder['exact-category']).toBe(1)
    expect(out.product.baseBidCents).toBe(40)
  })
})

describe('capture — budget shares add up to 100', () => {
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

  it('each share rounded down to a tenth, the tenths left over to the largest remainders (the earlier slot on a tie)', () => {
    expect(budgetShares([100, 200])).toEqual([33.3, 66.7])
    expect(budgetShares([100, 100, 100])).toEqual([33.4, 33.3, 33.3])
    expect(budgetShares([500, 500, 500, 500, 500, 500])).toEqual([16.7, 16.7, 16.7, 16.7, 16.6, 16.6])
    expect(budgetShares([100, null, 0, 300])).toEqual([25, 0, 0, 75])
    expect(budgetShares([null, 0])).toEqual([0, 0])
  })

  it('a captured set whose shares rounded one by one came to 100.3 now adds up to exactly 100', () => {
    const budgets = [3.35, 3.35, 3.35, 3.35, 3.35, 3.35, 3.35, 3.35, 3.2]
    expect(sum(budgets.map((b) => Math.round((b / 30) * 1000) / 10))).toBeCloseTo(100.3, 9)
    const campaigns = elevenCampaigns().slice(0, budgets.length).map((c, i) => ({ ...c, source: { ...c.source, dailyBudget: budgets[i] } }))
    const out = captureTemplate(input({ campaigns, schedules: [] }))
    expect(out.problems).toEqual([])
    expect(sum(Object.values(out.doc!.budget.weights))).toBeCloseTo(100, 9)
    expect(out.doc!.budget.weights).toMatchObject({ auto: 11.2, 'exact-competitor': 10.6 })
  })
})
