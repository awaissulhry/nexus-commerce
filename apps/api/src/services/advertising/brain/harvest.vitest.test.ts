/**
 * ONE BRAIN AB-11 — the harvest module's decisions (brain/harvest.ts), pure: where a converting term goes (the Owner's
 * stored destination, the playbook slot, the product's exact ad group, the best of several, or a new campaign by
 * approval), the size-scaled threshold, the sources negated in the same change set (excluded and locked campaigns left
 * alone), the levels, the caps, the start bid and the judgement after the attribution window + 72 h. Values are made up
 * (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

import {
  chooseDestination, decideHarvests, destinationRefusal, judgeHarvest, JUDGE_AFTER_MS, lowestLevel, newCampaignName, sourcePlans, startBid,
  type HarvestCampaignSettings, type HarvestCandidateFacts, type HarvestGroup, type HarvestProductFacts,
} from './harvest.js'
import { decideTerm, termTests, type LeadVerdict, type LeverEffective, type ProductContext, type TermEvidence, type TermFacts, type TermPlace } from './terms.js'

const ev = (clicks: number, orders: number, spendCents: number, salesCents = orders * 8000): TermEvidence => ({ impressions: clicks * 20, clicks, orders, spendCents, salesCents })
const NOW = new Date('2026-10-09T05:25:00Z')

/** A jacket at €80, 1 % conversion over 1,000 clicks; target ACoS 25 %, band top 30 %. */
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
    targetAcos: { value: 0.25, source: 'the ads strategy: Jackets (IT)' },
    bandTop: { value: 0.3, source: 'the band top of the ads strategy' },
    harvestGroup: null,
    negateGroup: null,
    protections: [{ term: 'acme', matchType: 'CONTAINS', reason: 'brand' }],
    brand: ['storm'],
    margin: { value: 0.4, source: 'profit' },
    levers: { negatives: 'OBSERVE', harvest: 'AUTO' },
    lockedTerms: { negatives: new Set(), harvest: new Set() },
    caps: { negativesPerDay: 20, harvestPerDay: 10 },
    ...over,
  }
}

const group = (id: string, over: Partial<HarvestGroup> = {}): HarvestGroup => ({
  id, name: id, campaignId: `c-${id}`, campaignName: `campaign ${id}`, role: 'EXACT', roleFromName: true, manual: true, keywords: 10, productTargets: 0,
  serving: true, notServing: null, campaignMinCents: null, campaignMaxCents: null, ...over,
})
const settings = (over: Partial<HarvestCampaignSettings> = {}): HarvestCampaignSettings => ({
  name: 'x', excluded: false, harvest: 'AUTO', negatives: 'OBSERVE', harvestWhy: 'AUTO', negativesWhy: 'OBSERVE',
  harvestTermLocks: new Set(), negativesTermLocks: new Set(), negativesAdGroupLocks: new Set(), ...over,
})

/** An auto source, a phrase source and one exact destination of the jacket (each its own campaign). */
function productFacts(over: Partial<HarvestProductFacts> = {}, groups: HarvestGroup[] = [group('g-auto', { role: 'AUTO', manual: false }), group('g-phrase', { role: 'PHRASE' }), group('g-exact')]): HarvestProductFacts {
  return {
    productId: 'p-jacket', market: 'IT', ctx: ctx(),
    groups: new Map(groups.map((g) => [g.id, g])),
    campaigns: new Map(groups.map((g) => [g.campaignId, settings({ name: g.campaignName })])),
    slots: [],
    strategyLimits: new Map(), marketLimits: { minBidCents: null, maxBidCents: 80 },
    structure: 'OBSERVE', structureWhy: 'OBSERVE by the brain\'s default',
    records: new Map(),
    used: { keywordsToday: 0, campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 0 },
    caps: { harvestPerDay: 10, newCampaignsPerWeek: 2, skcMax: 20, marketCampaignsPerWeek: 6 },
    ceiling: { live: true, why: 'live' },
    newCampaign: { skus: ['JACKET-M', 'JACKET-L'], dailyBudgetCents: 500, budgetWhy: '10 % of the day\'s envelope', productLabel: 'Jacket', takenNames: new Set() },
    newCampaignRefusal: null,
    ...over,
  }
}

/** The ledger's decision for a term (brain/terms.ts), as the harvest reads it. */
function candidate(term: string, evidence: TermEvidence, over: Partial<TermFacts> = {}, verdict: LeadVerdict | null = null, c = ctx(), extra: Partial<HarvestCandidateFacts> = {}): HarvestCandidateFacts {
  const f: TermFacts = { term, evidence, targets: [], negatives: [], destination: { source: 'own', adGroupId: 'g-exact', keywords: 10 }, ...over }
  const decision = decideTerm(f, c, termTests(f, c), verdict)
  return { decision, sources: [{ adGroupId: 'g-auto', clicks: 120 }, { adGroupId: 'g-phrase', clicks: 30 }], stored: null, ...extra }
}
const TOURING = () => candidate('touring jacket', ev(150, 5, 3000, 40_000))

describe('AB-11 — the destination: the Owner\'s, the playbook\'s, the product\'s own, or a new campaign', () => {
  it('the ledger\'s candidate is a HARVEST_CANDIDATE with its sources', () => {
    expect(TOURING().decision.state).toBe('HARVEST_CANDIDATE')
  })

  it('the product\'s one exact ad group takes it; an auto or phrase ad group never does (a term climbs once, straight to exact)', () => {
    const d = chooseDestination(TOURING(), productFacts())
    expect(d).toMatchObject({ kind: 'EXISTING', how: 'own', adGroupId: 'g-exact', campaignId: 'c-g-exact', keywords: 10 })
    const f = productFacts()
    expect(destinationRefusal(f.groups.get('g-auto'), 'touring jacket', false, f)).toMatch(/automatic/)
    expect(destinationRefusal(f.groups.get('g-phrase'), 'touring jacket', false, f)).toMatch(/not an exact ad group \(phrase\)/)
  })

  it('the Owner\'s stored destination wins whole; one that cannot take it now holds the harvest (never another); one of another product is passed over', () => {
    const groups = [group('g-auto', { role: 'AUTO', manual: false }), group('g-exact'), group('g-exact-2', { keywords: 200 })]
    const stored = { adGroupId: 'g-exact-2', negateAtSource: true, grain: 'campaign', own: true }
    expect(chooseDestination({ ...TOURING(), stored }, productFacts({}, groups))).toMatchObject({ kind: 'EXISTING', how: 'stored', adGroupId: 'g-exact-2' })
    const paused = [group('g-auto', { role: 'AUTO', manual: false }), group('g-exact'), group('g-exact-2', { serving: false, notServing: 'its campaign is paused' })]
    expect(chooseDestination({ ...TOURING(), stored }, productFacts({}, paused))).toEqual({ held: expect.stringMatching(/the Owner's harvest destination .* cannot take it now: it does not serve now: its campaign is paused/) })
    const elsewhere = chooseDestination({ ...TOURING(), stored: { ...stored, adGroupId: 'g-other', own: false } }, productFacts())
    expect(elsewhere).toMatchObject({ kind: 'EXISTING', how: 'own', adGroupId: 'g-exact', why: expect.stringMatching(/never harvests into another product's campaign/) })
  })

  it('the playbook slot: a brand term to the brand slot, any other to the category slot', () => {
    const groups = [group('g-auto', { role: 'AUTO', manual: false }), group('g-brand'), group('g-cat')]
    const slots = [{ key: 'exact-brand', campaignId: 'c-g-brand', adGroupId: 'g-brand' }, { key: 'exact-category', campaignId: 'c-g-cat', adGroupId: 'g-cat' }]
    expect(chooseDestination(TOURING(), productFacts({ slots }, groups))).toMatchObject({ how: 'playbook', adGroupId: 'g-cat' })
    const brand = candidate('storm jacket pro', ev(150, 5, 3000, 40_000))
    expect(brand.decision.state).toBe('HARVEST_CANDIDATE')
    expect(chooseDestination(brand, productFacts({ slots }, groups))).toMatchObject({ how: 'playbook', adGroupId: 'g-brand', why: expect.stringMatching(/brand word "storm"/) })
  })

  it('several exact ad groups: the one in use (role from its name, the most keywords); a tie on both is named', () => {
    const groups = [group('g-auto', { role: 'AUTO', manual: false }), group('g-a', { keywords: 40 }), group('g-b', { keywords: 12 }), group('g-c', { keywords: 90, roleFromName: false })]
    const best = chooseDestination(TOURING(), productFacts({}, groups))
    expect(best).toMatchObject({ how: 'ranked', adGroupId: 'g-a' })
    expect(best).not.toHaveProperty('tie')
    const tied = [group('g-auto', { role: 'AUTO', manual: false }), group('g-a', { keywords: 40 }), group('g-b', { keywords: 40 })]
    expect(chooseDestination(TOURING(), productFacts({}, tied))).toMatchObject({ how: 'ranked', adGroupId: 'g-a', tie: ['g-a', 'g-b'] })
  })

  it('an exact ad group that only cannot serve now is named — never a second structure beside it; none at all → a new campaign', () => {
    const waiting = [group('g-auto', { role: 'AUTO', manual: false }), group('g-exact', { serving: false, notServing: 'its campaign\'s bids are suppressed' })]
    expect(chooseDestination(TOURING(), productFacts({}, waiting))).toEqual({ held: expect.stringMatching(/cannot take it now: "g-exact" — it does not serve now/) })
    expect(chooseDestination(TOURING(), productFacts({}, [group('g-auto', { role: 'AUTO', manual: false })]))).toMatchObject({ kind: 'NONE', why: expect.stringMatching(/no exact ad group/) })
  })

  it('the Owner\'s campaign settings: an excluded campaign, a locked harvest lever or a locked term is never a destination', () => {
    const f = productFacts()
    const g = f.groups.get('g-exact')!
    const with_ = (s: Partial<HarvestCampaignSettings>) => ({ campaigns: new Map([...f.campaigns, [g.campaignId, settings(s)]]) })
    expect(destinationRefusal(g, 'touring jacket', false, with_({ excluded: true }))).toMatch(/excluded from the brain by the Owner/)
    expect(destinationRefusal(g, 'touring jacket', false, with_({ harvest: 'LOCKED' }))).toMatch(/locked the harvest lever/)
    expect(destinationRefusal(g, 'touring jacket', false, with_({ harvest: 'OFF' }))).toMatch(/OFF/)
    expect(destinationRefusal(g, 'touring jacket', false, with_({ harvestTermLocks: new Set(['touring jacket']) }))).toMatch(/locked this term/)
  })

  it('an ASIN goes to a product-target ad group, never a keyword one', () => {
    const asin = candidate('b0abcd1234', ev(150, 5, 3000, 40_000))
    const groups = [group('g-auto', { role: 'AUTO', manual: false }), group('g-exact'), group('g-pat', { role: null, roleFromName: false, productTargets: 3 })]
    expect(chooseDestination(asin, productFacts({}, groups))).toMatchObject({ how: 'own', adGroupId: 'g-pat' })
  })
})

describe('AB-11 — the sources: negative exact in the same change set; the Owner\'s campaigns left alone', () => {
  it('every source where it ran but the destination; excluded, locked and lever-off campaigns are left with why; a standing negative is not added again', () => {
    const groups = [group('g-auto', { role: 'AUTO', manual: false }), group('g-phrase', { role: 'PHRASE' }), group('g-broad', { role: 'BROAD' }), group('g-old', { role: 'BROAD' }), group('g-exact')]
    const f = productFacts({}, groups)
    const campaigns = new Map(f.campaigns)
    campaigns.set('c-g-phrase', settings({ excluded: true }))
    campaigns.set('c-g-broad', settings({ negatives: 'LOCKED' }))
    const negatives: TermPlace[] = [{ campaignId: 'c-g-old', adGroupId: 'g-old', targetId: 'n-1', match: 'EXACT', level: 'AD_GROUP' }]
    const c = candidate('touring jacket', ev(150, 5, 3000, 40_000), { negatives: [] }, null, ctx(), {
      sources: [{ adGroupId: 'g-auto', clicks: 100 }, { adGroupId: 'g-phrase', clicks: 20 }, { adGroupId: 'g-broad', clicks: 10 }, { adGroupId: 'g-old', clicks: 5 }, { adGroupId: 'g-exact', clicks: 3 }],
    })
    c.decision = { ...c.decision, negatives }
    const plans = sourcePlans(c, 'g-exact', { groups: f.groups, campaigns })
    expect(plans.map((p) => [p.adGroupId, p.action])).toEqual([['g-auto', 'negate'], ['g-phrase', 'skipped'], ['g-broad', 'skipped'], ['g-old', 'standing'], ['g-exact', 'kept']])
    expect(plans[1].why).toMatch(/excluded from the brain by the Owner/)
    expect(plans[2].why).toMatch(/locked the negatives lever/)
    expect(plans[4].why).toMatch(/the destination itself/)
  })

  it('the Owner\'s stored destination with negateAtSource off keeps every source', () => {
    const stored = { adGroupId: 'g-exact', negateAtSource: false, grain: 'market', own: true }
    const plans = sourcePlans({ ...TOURING(), stored }, 'g-exact', productFacts())
    expect(plans.every((p) => p.action === 'kept')).toBe(true)
    expect(plans[0].why).toMatch(/negateAtSource off/)
  })

  it('batch 2 fix — the best-practice pairing never overrides the Owner: his negateAtSource off wins in the whole decision (the keyword alone, every source kept, said); on, the source is negated exact', () => {
    const off = decideHarvests([{ ...TOURING(), stored: { adGroupId: 'g-exact', negateAtSource: false, grain: 'market', own: true } }], productFacts(), NOW, 60)[0]
    expect(off).toMatchObject({ outcome: 'pair', destination: expect.objectContaining({ adGroupId: 'g-exact', how: 'stored' }) })
    expect(off.sources.map((x) => x.action)).toEqual(['kept', 'kept'])
    expect(off.sources.every((x) => /negateAtSource off/.test(x.why))).toBe(true)
    const on = decideHarvests([{ ...TOURING(), stored: { adGroupId: 'g-exact', negateAtSource: true, grain: 'market', own: true } }], productFacts(), NOW, 60)[0]
    expect(on.sources.map((x) => [x.adGroupId, x.action])).toEqual([['g-auto', 'negate'], ['g-phrase', 'negate']])
  })

  it('a protected term can never be negated anywhere: the pair could never be whole — held, with the manual route', () => {
    const protectedTerm = candidate('acme touring jacket', ev(150, 5, 3000, 40_000))
    expect(protectedTerm.decision.state).toBe('HARVEST_CANDIDATE')
    const [d] = decideHarvests([protectedTerm], productFacts(), NOW, 60)
    expect(d).toMatchObject({ outcome: 'held', act: 'none', heldBy: expect.stringMatching(/never negated anywhere, so the pair .* could never be whole/) })
    expect(d.why).toMatch(/negateSource false/)
  })
})

describe('AB-11 — the size-scaled threshold, the levels and the caps', () => {
  it('one order would do in a small exact ad group; a big one asks for more — judged against the ad group chosen', () => {
    const one = candidate('touring jacket', ev(150, 1, 300, 8000), { destination: { source: 'own', adGroupId: 'g-exact', keywords: 10 } })
    expect(one.decision.state).toBe('HARVEST_CANDIDATE')
    const big = [group('g-auto', { role: 'AUTO', manual: false }), group('g-exact', { keywords: 950 })]
    const [d] = decideHarvests([one], productFacts({}, big), NOW, 60)
    expect(d).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/holds 950 keywords: a harvest there needs 3 orders, the term has 1/) })
    const [ok] = decideHarvests([one], productFacts(), NOW, 60)
    expect(ok).toMatchObject({ outcome: 'pair', act: 'write' })
  })

  it('AUTO writes the pair; PROPOSE asks; OBSERVE logs; the lowest level of the destination and the negated sources wins', () => {
    const at = (dest: LeverEffective, source: LeverEffective) => {
      const f = productFacts()
      const campaigns = new Map(f.campaigns)
      campaigns.set('c-g-exact', settings({ harvest: dest }))
      campaigns.set('c-g-auto', settings({ harvest: source }))
      campaigns.set('c-g-phrase', settings({ harvest: source }))
      return decideHarvests([TOURING()], { ...f, campaigns }, NOW, 60)[0]
    }
    expect(at('AUTO', 'AUTO')).toMatchObject({ outcome: 'pair', act: 'write', level: 'AUTO', destination: { adGroupId: 'g-exact' } })
    expect(at('AUTO', 'PROPOSE')).toMatchObject({ act: 'propose', level: 'PROPOSE' })
    expect(at('PROPOSE', 'AUTO')).toMatchObject({ act: 'propose', level: 'PROPOSE' })
    expect(at('AUTO', 'OBSERVE')).toMatchObject({ act: 'log', level: 'OBSERVE' })
    const d = at('AUTO', 'AUTO')
    expect(d.sources.map((s) => [s.adGroupId, s.action])).toEqual([['g-auto', 'negate'], ['g-phrase', 'negate']])
    expect(d.bid!.cents).toBeGreaterThan(0)
    expect(lowestLevel(['AUTO', 'PROPOSE', 'OBSERVE'])).toBe('OBSERVE')
    expect(lowestLevel(['AUTO', 'OFF'])).toBeNull()
  })

  it('under a shadow ceiling every level only logs what it would do', () => {
    const [d] = decideHarvests([TOURING()], productFacts({ ceiling: { live: false, why: 'the harvest\'s env ceiling NEXUS_ADS_BRAIN_HARVEST_MODE is shadow' } }), NOW, 60)
    expect(d).toMatchObject({ outcome: 'pair', act: 'log', level: 'AUTO', heldBy: expect.stringMatching(/shadow: it would write it now/) })
  })

  it('a tie between exact ad groups at AUTO asks a person instead of picking', () => {
    const tied = [group('g-auto', { role: 'AUTO', manual: false }), group('g-a', { keywords: 40 }), group('g-b', { keywords: 40 })]
    const [d] = decideHarvests([TOURING()], productFacts({}, tied), NOW, 60)
    expect(d).toMatchObject({ act: 'propose', heldBy: expect.stringMatching(/several exact ad groups tie/) })
  })

  it('the day\'s cap counts what was already taken; a term in flight or placed is never decided again; an ended one waits the cooldown', () => {
    const many = ['alpha jacket', 'beta jacket', 'gamma jacket'].map((t, i) => candidate(t, ev(150, 5 + i, 3000, 40_000)))
    const out = decideHarvests(many, productFacts({ used: { keywordsToday: 9, campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 0 } }), NOW, 60)
    expect(out.map((d) => [d.term, d.outcome])).toEqual([['gamma jacket', 'pair'], ['beta jacket', 'held'], ['alpha jacket', 'held']])
    expect(out[1].heldBy).toMatch(/past today's cap of 10 new keywords/)
    const records = new Map([
      ['alpha jacket', { term: 'alpha jacket', status: 'DONE' as const, changedAt: NOW, landedAt: NOW }],
      ['beta jacket', { term: 'beta jacket', status: 'DECLINED' as const, changedAt: new Date(NOW.getTime() - 5 * 86_400_000), landedAt: null }],
      ['gamma jacket', { term: 'gamma jacket', status: 'UNDONE' as const, changedAt: new Date(NOW.getTime() - 40 * 86_400_000), landedAt: null }],
    ])
    expect(decideHarvests(many, productFacts({ records }), NOW, 60).map((d) => d.term)).toEqual(['gamma jacket'])
    // One the gate refused (or Amazon failed) never graduated: it is decided again the next day, not after 30.
    const refused = new Map([['alpha jacket', { term: 'alpha jacket', status: 'REFUSED' as const, changedAt: new Date(NOW.getTime() - 2 * 86_400_000), landedAt: null }]])
    expect(decideHarvests([many[0]], productFacts({ records: refused }), NOW, 60).map((d) => d.term)).toEqual(['alpha jacket'])
    const today = new Map([['alpha jacket', { term: 'alpha jacket', status: 'FAILED' as const, changedAt: new Date(NOW.getTime() - 3_600_000), landedAt: null }]])
    expect(decideHarvests([many[0]], productFacts({ records: today }), NOW, 60)).toEqual([])
  })

  it('the ledger\'s own holds stand (the lever, the Owner\'s term lock); a sibling\'s lead is never harvested', () => {
    const locked = candidate('touring jacket', ev(150, 5, 3000, 40_000), {}, null, ctx({ lockedTerms: { negatives: new Set(), harvest: new Set(['touring jacket']) } }))
    expect(decideHarvests([locked], productFacts(), NOW, 60)[0]).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/locked this term on the harvest lever/) })
    const c = TOURING()
    c.decision = { ...c.decision, lead: { leadProductId: 'p-glove', rule: 'profit', leadBidCents: 50, maxBidCents: 40, why: 'x', isThis: false } }
    expect(decideHarvests([c], productFacts(), NOW, 60)[0]).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/product p-glove leads this term/) })
  })
})

describe('AB-11 — no destination: a new campaign through a Nexus builder, by approval (D1 = B), inside caps', () => {
  const noExact = [group('g-auto', { role: 'AUTO', manual: false }), group('g-phrase', { role: 'PHRASE' })]

  it('always a request a person approves, at AUTO too; the plan: the product\'s SKUs, one exact keyword at the start bid, the first budget', () => {
    const [d] = decideHarvests([TOURING()], productFacts({}, noExact), NOW, 60)
    expect(d).toMatchObject({ outcome: 'new-campaign', act: 'propose', level: 'AUTO', destination: { kind: 'NEW_CAMPAIGN', how: 'new' } })
    if (d.destination.kind !== 'NEW_CAMPAIGN') throw new Error('no plan')
    expect(d.destination.plan).toMatchObject({ name: 'Jacket | IT | Exact | touring jacket', skus: ['JACKET-M', 'JACKET-L'], dailyBudgetCents: 500, keywords: [{ text: 'touring jacket', matchType: 'EXACT', bidCents: d.bid!.cents }], productTargets: [] })
    expect(d.destination.why).toMatch(/create-ad-campaign .* approved by a person \(D1 = B\)/)
    expect(d.sources.map((s) => s.action)).toEqual(['negate', 'negate'])
  })

  it('the caps: two a week per product, six per market, twenty harvest campaigns per product', () => {
    const held = (used: Partial<HarvestProductFacts['used']>) => decideHarvests([TOURING()], productFacts({ used: { keywordsToday: 0, campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 0, ...used } }, noExact), NOW, 60)[0]
    expect(held({ campaignsThisWeek: 2 })).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/2 new campaigns for this product/) })
    expect(held({ marketCampaignsThisWeek: 6 })).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/6 new campaigns in IT/) })
    expect(held({ skcs: 20 })).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/20 harvest campaigns/) })
  })

  it('the Owner keeps the structure lever off or locked: no new campaign; OBSERVE logs it; no SKU: said', () => {
    expect(decideHarvests([TOURING()], productFacts({ structure: 'OFF' }, noExact), NOW, 60)[0]).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/structure lever is OFF/) })
    expect(decideHarvests([TOURING()], { ...productFacts({}, noExact), ctx: ctx({ levers: { negatives: 'OBSERVE', harvest: 'OBSERVE' } }) }, NOW, 60)[0]).toMatchObject({ outcome: 'new-campaign', act: 'log' })
    expect(decideHarvests([TOURING()], productFacts({ newCampaign: null, newCampaignRefusal: 'its own campaigns advertise no SKU Nexus knows' }, noExact), NOW, 60)[0]).toMatchObject({ outcome: 'held', heldBy: expect.stringMatching(/no SKU/) })
  })

  it('a new campaign\'s name is new in the market', () => {
    expect(newCampaignName('Jacket', 'IT', 'touring jacket', new Set(['jacket | it | exact | touring jacket']))).toBe('Jacket | IT | Exact | touring jacket (2)')
    expect(newCampaignName('x'.repeat(200), 'IT', 't', new Set()).length).toBe(128)
  })
})

describe('AB-11 — the start bid: the bid brain\'s goal maths inside the limits', () => {
  it('target × CR̂ × AOV̂ ÷ r̂, held at the cautious bid, inside the strategy\'s and the campaign\'s limits', () => {
    const c = TOURING()
    const free = startBid(c.decision, ctx(), {})
    if ('refusal' in free) throw new Error(free.refusal)
    expect(free.cents).toBeGreaterThan(5)
    expect(free.why).toMatch(/goal bid/)
    expect(free.why).not.toMatch(/€|\d+¢/)
    const capped = startBid(c.decision, ctx(), { maxBidCents: 20 })
    expect(capped).toMatchObject({ cents: 20, why: expect.stringMatching(/held by the strategy highest bid/) })
    const floored = startBid(c.decision, ctx(), { minBidCents: 400 })
    expect(floored).toMatchObject({ cents: 400 })
    expect(startBid(c.decision, ctx({ targetAcos: null }), {})).toEqual({ refusal: expect.stringMatching(/no target ACoS/) })
  })
})

describe('AB-11 — judging after the attribution window + 72 h', () => {
  const landedAt = new Date(NOW.getTime() - 12 * 86_400_000)
  const pre = { clicks: 150, orders: 5, spendCents: 3000, salesCents: 40_000, cr: 0.02 }
  const j = (post: TermEvidence, over: Partial<Parameters<typeof judgeHarvest>[0]> = {}) => judgeHarvest({ landedAt, now: NOW, settledDays: 9, pre, post, bandTop: 0.3, ...over })

  it('never earlier: before 7 days + 72 h, or with fewer than 7 settled days, it waits', () => {
    expect(JUDGE_AFTER_MS).toBe(10 * 86_400_000)
    expect(j(ev(500, 0, 9000), { landedAt: new Date(NOW.getTime() - 9 * 86_400_000) })).toMatchObject({ verdict: 'WAITING', final: false })
    expect(j(ev(500, 0, 9000), { settledDays: 5 })).toMatchObject({ verdict: 'WAITING' })
  })

  it('worse: 0 orders in the clicks that make it a 95 % call at its harvest-time rate, or an ACoS above the band top and clearly worse', () => {
    expect(j(ev(150, 0, 3000))).toMatchObject({ verdict: 'WORSE', final: true, why: expect.stringMatching(/stopped converting .* an undo is proposed/) })
    expect(j(ev(100, 1, 6000, 8000))).toMatchObject({ verdict: 'WORSE', why: expect.stringMatching(/above the band top and clearly worse/) })
  })

  it('kept: it converts within the band; too little data waits, and after 30 days is kept', () => {
    expect(j(ev(100, 3, 2000, 24_000))).toMatchObject({ verdict: 'KEPT', final: true })
    expect(j(ev(40, 0, 800))).toMatchObject({ verdict: 'WAITING', final: false })
    expect(j(ev(40, 0, 800), { landedAt: new Date(NOW.getTime() - 31 * 86_400_000) })).toMatchObject({ verdict: 'KEPT', final: true, why: expect.stringMatching(/too little data in 30 days/) })
    // Money only under `money`.
    const k = j(ev(100, 3, 2000, 24_000))
    expect(k.numbers.money).toMatchObject({ postSpendCents: 2000, postSalesCents: 24_000 })
    expect(k.why).not.toMatch(/€|%\s*ACoS \d/)
  })
})
