/**
 * ONE BRAIN AB-9 — the term ledger's decisions (brain/terms.ts), pure: the pooled tests, the thresholds, the guards, and
 * one decision per term — a term is never harvested and negated at once, a protected term is never negated. Values are
 * made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

import { crLowerBound80 } from '../bid-brain/estimator.js'
import {
  applyCaps, brandWordIn, crUpperBound80, decideTerm, harvestOrdersNeeded, matchOf, negateClicksNeeded, negativeBlocks, productEstimate, selfBlockingPairs,
  stateCounts, termEstimate, termTests, TERM_STATES, type LeadVerdict, type ProductContext, type TermEvidence, type TermFacts, type TermPlace,
} from './terms.js'

const ev = (clicks: number, orders: number, spendCents: number, salesCents = orders * 8000): TermEvidence => ({ impressions: clicks * 20, clicks, orders, spendCents, salesCents })

/** A jacket at €80, 1 % conversion over 1,000 clicks, a category and a market behind it; target ACoS 25 %. */
function ctx(over: Partial<ProductContext> = {}): ProductContext {
  return {
    productId: 'p-jacket',
    pool: {
      nodes: [
        { level: 'product', evidence: { clicks: 1000, orders: 10, salesCents: 80_000, costCents: 40_000 } },
        { level: 'category', evidence: { clicks: 5000, orders: 50, salesCents: 400_000, costCents: 200_000 } },
        { level: 'market', evidence: { clicks: 20_000, orders: 200, salesCents: 1_600_000, costCents: 800_000 } },
      ],
      listPriceCents: 8000,
    },
    targetAcos: { value: 0.25, source: 'the ads strategy: Jackets (IT), version 1' },
    bandTop: { value: 0.3, source: 'the band top of the ads strategy' },
    harvestGroup: null,
    negateGroup: null,
    protections: [{ term: 'acme', matchType: 'CONTAINS', reason: 'brand' }],
    brand: ['storm'],
    margin: { value: 0.4, source: 'profit' },
    levers: { negatives: 'OBSERVE', harvest: 'OBSERVE' },
    lockedTerms: { negatives: new Set(), harvest: new Set() },
    caps: { negativesPerDay: 20, harvestPerDay: 10 },
    ...over,
  }
}

const place = (over: Partial<TermPlace> & Pick<TermPlace, 'match'>): TermPlace => ({ campaignId: 'c-1', adGroupId: 'g-1', targetId: `t-${over.match}-${over.adGroupId ?? 'g-1'}`, ...over })
function facts(term: string, evidence: TermEvidence, over: Partial<TermFacts> = {}): TermFacts {
  return { term, evidence, targets: [], negatives: [], destination: { source: 'own', adGroupId: 'g-exact', keywords: 40 }, ...over }
}
const decide = (f: TermFacts, c = ctx(), verdict: LeadVerdict | null = null) => decideTerm(f, c, termTests(f, c), verdict)

describe('AB-9 — the pooled tests and their thresholds', () => {
  it('0 orders after n clicks is a 95 % call at n = ⌈ln 0.05 / ln(1 − CR̂)⌉ ≈ 3 / CR̂', () => {
    expect(negateClicksNeeded(0.01)).toBe(299)
    expect(negateClicksNeeded(0.009)).toBe(332)
    expect(Math.abs(negateClicksNeeded(0.02) - 3 / 0.02) / (3 / 0.02)).toBeLessThan(0.02)
    expect(negateClicksNeeded(0)).toBe(5000)
    expect(negateClicksNeeded(1)).toBe(1)
  })

  it('a harvest needs more orders as the destination grows (1 below 15 keywords, 2 below 900, then more); unknown: 2', () => {
    expect([null, 0, 14, 15, 899, 900, 1899, 1900].map(harvestOrdersNeeded)).toEqual([2, 1, 1, 2, 2, 3, 3, 4])
  })

  it('pooling: a product with no clicks borrows the category\'s and the market\'s rate; one with many keeps its own', () => {
    const empty = ctx({ pool: { ...ctx().pool, nodes: [{ level: 'product', evidence: { clicks: 0, orders: 0, salesCents: 0, costCents: 0 } }, ...ctx().pool.nodes.slice(1)] } })
    expect(productEstimate(empty.pool).cr).toBeCloseTo(0.01, 3)
    const rich = ctx({ pool: { ...ctx().pool, nodes: [{ level: 'product', evidence: { clicks: 50_000, orders: 1500, salesCents: 12_000_000, costCents: 1 } }, ...ctx().pool.nodes.slice(1)] } })
    expect(productEstimate(rich.pool).cr).toBeGreaterThan(0.028)
    // A term with a few clicks leans on the product, not on its own 1-in-3.
    expect(termEstimate(ev(3, 1, 300), ctx().pool).node.cr).toBeLessThan(0.05)
  })

  it('the 80 % upper bound mirrors the bid estimator\'s lower bound', () => {
    const n = { cr: 0.02, k: 150, clicks: 400 }
    expect(crUpperBound80(n) - n.cr).toBeCloseTo(n.cr - crLowerBound80(n), 10)
    expect(crUpperBound80({ cr: 0.99, k: 1, clicks: 1 })).toBeLessThanOrEqual(1)
  })

  it('matches, negatives and brand words read as Amazon does', () => {
    expect(['EXACT', '_EXACT', 'NEGATIVE_EXACT', 'negative_phrase', 'BROAD', 'ASIN_SAME_AS'].map((m) => matchOf(m))).toEqual(['EXACT', 'EXACT', 'EXACT', 'PHRASE', 'BROAD', null])
    expect(matchOf('ASIN_SAME_AS', 'PRODUCT')).toBe('PRODUCT')
    expect(negativeBlocks('cheap jacket', { text: 'cheap', match: 'PHRASE' })).toBe(true)
    expect(negativeBlocks('cheapest jacket', { text: 'cheap', match: 'PHRASE' })).toBe(false)
    expect(negativeBlocks('cheap jacket', { text: 'cheap', match: 'EXACT' })).toBe(false)
    expect(brandWordIn('storm jacket women', ['storm'])).toBe('storm')
    expect(brandWordIn('stormx jacket', ['storm'])).toBeNull()
  })
})

describe('AB-9 — one decision per term', () => {
  it('waste: 0 orders past the pooled test and the spend gate is a negate candidate; short of either it is watched', () => {
    const d = decide(facts('cheap jacket', ev(320, 0, 3200)))
    expect(d.state).toBe('NEGATE_CANDIDATE')
    expect(d.tests.negate).toMatchObject({ by: 'brain', pass: true, clicksNeeded: expect.any(Number), spendGateCents: expect.any(Number) })
    expect(d.why).toMatch(/negate it exact/)
    // One order: the brain's own test refuses (and the decision guards it again).
    const sold = decide(facts('cheap jacket', ev(320, 1, 3200, 100)))
    expect(sold.tests.negate).toMatchObject({ pass: false, words: expect.stringMatching(/it has orders/) })
    expect(sold.state).toBe('WATCH')
    // Short of the clicks.
    expect(decide(facts('cheap jacket', ev(200, 0, 3200))).state).toBe('WATCH')
    // Short of the spend gate (1.5 × AOV̂ × 25 %).
    const gate = d.tests.negate.spendGateCents!
    expect(decide(facts('cheap jacket', ev(320, 0, gate - 1))).state).toBe('WATCH')
    // No target anywhere: no spend gate, never negated.
    const none = decide(facts('cheap jacket', ev(5000, 0, 900_000)), ctx({ targetAcos: null, bandTop: null }))
    expect(none.state).toBe('WATCH')
    expect(none.tests.negate.refused).toMatch(/no target ACoS/)
  })

  it('protected terms are never negated: the protected list, the brand word, a winner', () => {
    const waste = ev(5000, 0, 900_000)
    const prot = decide(facts('giacca moto acme', waste))
    expect(prot).toMatchObject({ state: 'PROTECTED', protection: 'protected-term' })
    const brand = decide(facts('storm jacket', waste))
    expect(brand).toMatchObject({ state: 'PROTECTED', protection: 'brand' })
    // A winner (it meets the harvest test within the target) with no home is harvested; with a home it is targeted.
    const win = decide(facts('racing jacket', ev(200, 6, 4000, 48_000)))
    expect(win).toMatchObject({ state: 'HARVEST_CANDIDATE', protection: 'winner' })
    const home = decide(facts('racing jacket', ev(200, 6, 4000, 48_000), { targets: [place({ match: 'EXACT', bidCents: 60 })] }))
    expect(home).toMatchObject({ state: 'TARGETED', protection: 'winner' })
    // A converting protected term still graduates (protection forbids a negative, not a harvest).
    expect(decide(facts('acme jacket', ev(200, 6, 4000, 48_000))).state).toBe('HARVEST_CANDIDATE')
  })

  it('a protected term blocked by the product\'s own negative stays PROTECTED and the clash is named', () => {
    const d = decide(facts('storm jacket', ev(10, 0, 100), { negatives: [place({ match: 'EXACT', level: 'AD_GROUP', targetId: 'neg-1' })] }))
    expect(d.state).toBe('PROTECTED')
    expect(d.clashes).toEqual([expect.objectContaining({ kind: 'protected-negated', negativeId: 'neg-1', resolution: expect.stringMatching(/retires/) })])
  })

  it('never harvested and negated at once — over a grid of evidence, with an Owner\'s negate group that allows orders', () => {
    const base = ctx()
    const owner = ctx({ negateGroup: { minClicks: 10, minSpendCents: 500, maxOrders: 3, windowDays: 60, source: 'the ads strategy: IT, version 2' } })
    const seen: string[] = []
    let brainWithOrders = 0
    for (const orders of [0, 1, 2, 3, 5]) for (const clicks of [0, 20, 400, 3000]) for (const spend of [0, 1000, 50_000]) for (const c of [base, owner]) {
      if (orders > clicks) continue
      for (const term of ['plain jacket', 'storm jacket', 'acme jacket']) {
        const d = decide(facts(term, ev(clicks, orders, spend)), c)
        expect(TERM_STATES).toContain(d.state)
        seen.push(d.state)
        if (d.state === 'NEGATE_CANDIDATE') {
          expect(d.tests.harvest.pass).toBe(false)
          expect(d.protection).toBeNull()
        }
        if (d.tests.harvest.pass && d.tests.negate.pass) {
          expect(d.state).toBe('HARVEST_CANDIDATE')
          expect(d.clashes.map((x) => x.kind)).toContain('harvest-and-negate')
        }
        if (term !== 'plain jacket') expect(d.state).not.toBe('NEGATE_CANDIDATE')
        // The brain's own test never negates a term with an order.
        if (c === base && orders > 0) { brainWithOrders++; expect(d.state).not.toBe('NEGATE_CANDIDATE') }
      }
    }
    expect(brainWithOrders).toBeGreaterThan(50)
    expect(new Set(seen)).toEqual(new Set(['WATCH', 'NEGATE_CANDIDATE', 'HARVEST_CANDIDATE', 'PROTECTED']))
  })

  it('the Owner\'s groups win whole: his harvest bar over the brain\'s, his negate group with an order asks first', () => {
    // One order into a 40-keyword ad group: the brain wants 2; the Owner's group asks for 1.
    const one = facts('touring jacket', ev(60, 1, 900, 8000))
    expect(decide(one).state).toBe('WATCH')
    const ownerHarvest = ctx({ harvestGroup: { minOrders: 1, minClicks: 5, maxAcosPct: 40, windowDays: 60, source: 'the ads strategy: IT, version 3' } })
    expect(decide(one, ownerHarvest)).toMatchObject({ state: 'HARVEST_CANDIDATE', tests: { harvest: { by: 'owner', pass: true } } })
    // Stricter than the brain: 5 orders.
    const strict = ctx({ harvestGroup: { minOrders: 5, minClicks: 5, maxAcosPct: null, windowDays: 60, source: 'x' } })
    expect(decide(facts('racing jacket', ev(200, 3, 3000, 24_000)), strict).state).toBe('WATCH')
    // His negate group allows 1 order: a candidate a person decides.
    const ownerNegate = ctx({ negateGroup: { minClicks: 50, minSpendCents: 1000, maxOrders: 1, windowDays: 60, source: 'x' } })
    expect(decide(facts('summer jacket', ev(400, 1, 9000, 1000)), ownerNegate)).toMatchObject({ state: 'NEGATE_CANDIDATE', askFirst: true })
    expect(decide(facts('summer jacket', ev(400, 0, 9000)), ownerNegate)).toMatchObject({ state: 'NEGATE_CANDIDATE', askFirst: false })
  })

  it('the harvest bar is the same as ads-harvest.service.ts meetsHarvest (pinned together)', async () => {
    const { meetsHarvest } = await import('../ads-harvest.service.js')
    const groups = [{ minOrders: 2, minClicks: 10, maxAcosPct: 30 }, { minOrders: 1, minClicks: 0, maxAcosPct: null }]
    for (const g of groups) for (const [clicks, orders, spend, sales] of [[20, 2, 1000, 5000], [20, 2, 2000, 5000], [5, 1, 0, 0], [10, 3, 100, 0]]) {
      const ours = decide(facts('x jacket', ev(clicks, orders, spend, sales)), ctx({ harvestGroup: { ...g, windowDays: 60, source: 's' } })).tests.harvest.pass
      expect(ours).toBe(meetsHarvest({ orders, clicks, costCents: spend, salesCents: sales }, g))
    }
  })

  it('a home is never negated over: TARGETED; a negative in the same place is a clash it removes, one in the source is the graduation', () => {
    const exact = place({ match: 'EXACT', adGroupId: 'g-exact', bidCents: 50 })
    const same = decide(facts('city jacket', ev(500, 0, 50_000), { targets: [exact], negatives: [place({ match: 'EXACT', adGroupId: 'g-exact', level: 'AD_GROUP', targetId: 'neg-same' })] }))
    expect(same.state).toBe('TARGETED')
    expect(same.clashes).toEqual([expect.objectContaining({ kind: 'self-blocking', targetId: exact.targetId, negativeId: 'neg-same' })])
    const graduated = decide(facts('city jacket', ev(500, 4, 5000), { targets: [exact], negatives: [place({ match: 'EXACT', adGroupId: 'g-auto', level: 'AD_GROUP' })] }))
    expect(graduated.state).toBe('TARGETED')
    expect(graduated.clashes).toEqual([])
    // A campaign-level phrase negative blocks every keyword of the campaign that holds it.
    expect(selfBlockingPairs({ targets: [place({ match: 'BROAD', adGroupId: 'g-2' })], negatives: [place({ match: 'PHRASE', level: 'CAMPAIGN', adGroupId: 'g-9', text: 'city' })] })).toHaveLength(1)
    // The Owner's match-type funnel: a phrase of two words or more over a broad keyword narrows it — no clash, no revive.
    expect(selfBlockingPairs({ term: 'city jacket', targets: [place({ match: 'BROAD', adGroupId: 'g-2' })], negatives: [place({ match: 'PHRASE', level: 'CAMPAIGN', adGroupId: 'g-9' })] })).toEqual([])
    expect(selfBlockingPairs({ targets: [place({ match: 'PHRASE', adGroupId: 'g-2' })], negatives: [place({ match: 'PHRASE', level: 'CAMPAIGN', adGroupId: 'g-9', text: 'city jacket' })] })).toHaveLength(1)
  })

  it('the text of the product\'s own phrase or broad keyword is never negated (it would block that keyword)', () => {
    const d = decide(facts('rain jacket', ev(800, 0, 90_000), { targets: [place({ match: 'PHRASE', bidCents: 40 })] }))
    expect(d.state).toBe('WATCH')
    expect(d.why).toMatch(/own phrase keyword/)
  })

  it('a standing negative with no order is NEGATED; an order since makes it watched', () => {
    const neg = [place({ match: 'PHRASE', level: 'CAMPAIGN', text: 'cheap' })]
    expect(decide(facts('cheap jacket', ev(30, 0, 300), { negatives: neg })).state).toBe('NEGATED')
    expect(decide(facts('cheap jacket', ev(30, 1, 300), { negatives: neg })).state).toBe('WATCH')
  })

  it('a harvest names its destination, or why there is none', () => {
    const conv = ev(200, 6, 4000, 48_000)
    expect(decide(facts('racing jacket', conv)).why).toMatch(/destination ad group g-exact/)
    expect(decide(facts('racing jacket', conv, { destination: { source: 'ambiguous', adGroupId: null, keywords: null, candidates: 3 } })).why).toMatch(/3 exact ad groups/)
    expect(decide(facts('racing jacket', conv, { destination: { source: 'none', adGroupId: null, keywords: null } })).why).toMatch(/no exact ad group/)
  })

  it('held: the lever OFF or locked, the Owner\'s lock on the term; the day\'s caps, negatives first by spend', () => {
    const waste = facts('cheap jacket', ev(320, 0, 3200))
    expect(decide(waste, ctx({ levers: { negatives: 'OFF', harvest: 'OBSERVE' } })).heldBy).toMatch(/negatives lever is OFF/)
    expect(decide(waste, ctx({ levers: { negatives: 'LOCKED', harvest: 'OBSERVE' } })).heldBy).toMatch(/locked/)
    expect(decide(waste, ctx({ lockedTerms: { negatives: new Set(['cheap jacket']), harvest: new Set() } })).heldBy).toMatch(/Owner locked this term/)
    expect(decide(waste).heldBy).toBeNull()
    const c = ctx({ caps: { negativesPerDay: 2, harvestPerDay: 1 } })
    const capped = applyCaps([
      decide(facts('a jacket', ev(320, 0, 4000)), c), decide(facts('b jacket', ev(320, 0, 9000)), c), decide(facts('c jacket', ev(320, 0, 3500)), c),
      decide(facts('d jacket', ev(200, 6, 4000, 48_000)), c), decide(facts('e jacket', ev(200, 8, 4000, 64_000)), c),
    ], c.caps)
    expect(capped.filter((d) => d.capped).map((d) => d.term)).toEqual(['c jacket', 'd jacket'])
    expect(capped.find((d) => d.term === 'c jacket')!.heldBy).toMatch(/cap of 2 new negatives/)
    expect(stateCounts(capped)).toMatchObject({ NEGATE_CANDIDATE: 3, HARVEST_CANDIDATE: 2, WATCH: 0 })
  })

  it('no money in the words: a why carries counts and rates, never an amount', () => {
    const d = decide(facts('cheap jacket', ev(321, 0, 4321)))
    expect(d.why).not.toMatch(/4321|43\.21|€/)
    const h = decide(facts('racing jacket', ev(200, 6, 4321, 48_765)))
    expect(h.why).not.toMatch(/4321|48765|487\.65|€/)
  })
})

describe('AB-9 — sibling products: the arbiter\'s verdict in the decision', () => {
  const lead = (leadProductId: string, maxBidCents: number | null = 40): LeadVerdict => ({ leadProductId, rule: 'profit', leadBidCents: maxBidCents == null ? null : 50, maxBidCents, why: '2 products claim it; product p-sibling leads' })

  it('a term this product would harvest but a sibling leads is OWNED_BY_SIBLING, never harvested', () => {
    const d = decide(facts('racing jacket', ev(200, 6, 4000, 48_000)), ctx(), lead('p-sibling'))
    expect(d.state).toBe('OWNED_BY_SIBLING')
    expect(d.lead).toMatchObject({ leadProductId: 'p-sibling', isThis: false })
    expect(d.clashes.map((c) => c.kind)).toEqual(['sibling'])
  })

  it('targeted by a non-lead: kept at most 0.8 × the lead\'s bid (named, shadow)', () => {
    const d = decide(facts('racing jacket', ev(100, 0, 1000), { targets: [place({ match: 'EXACT', bidCents: 55, targetId: 't-own' })] }), ctx(), lead('p-sibling', 40))
    expect(d.state).toBe('TARGETED')
    expect(d.wouldLower).toEqual([{ targetId: 't-own', bidCents: 55, toBidCents: 40 }])
  })

  it('a non-lead\'s winning term is never negated; its 0-order waste is, with the lead named', () => {
    expect(decide(facts('racing jacket', ev(500, 2, 60_000, 16_000)), ctx(), lead('p-sibling')).state).not.toBe('NEGATE_CANDIDATE')
    const waste = decide(facts('racing jacket', ev(320, 0, 3200)), ctx(), lead('p-sibling'))
    expect(waste.state).toBe('NEGATE_CANDIDATE')
    expect(waste.why).toMatch(/p-sibling leads it/)
  })

  it('the lead keeps its term: never negated, even with 0 orders on a keyword of its own', () => {
    const d = decide(facts('racing jacket', ev(900, 0, 90_000), { targets: [place({ match: 'BROAD', bidCents: 30 })] }), ctx(), lead('p-jacket'))
    expect(d.state).not.toBe('NEGATE_CANDIDATE')
    expect(d.lead).toMatchObject({ isThis: true })
  })
})
