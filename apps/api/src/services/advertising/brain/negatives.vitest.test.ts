/**
 * ONE BRAIN AB-10 — the negatives module, pure (brain/negatives.ts). The ledger's decisions are made by the real ledger
 * (brain/terms.ts termTests + decideTerm) over one made-up jacket in IT: an auto campaign, an exact campaign (its home for
 * "racing jacket"), a broad campaign and a product-targeting one; the pooled conversion is 2 % (0 orders in 149 clicks is
 * the 95 % call) and the spend gate 1.5 × (80 € × 25 %) = 30 €.
 *
 *   where     waste → exact where it served: in its ad group, one campaign negative over two ad groups of one campaign,
 *             an ASIN as a negative product target; never in a product-targeting ad group, a shared campaign or a place
 *             already blocked
 *   guards    never a protected term, the brand, a winner, a term with an order, a term the product leads, a positive where
 *             it lands (L1), a locked term or ad group
 *   set       the playbook's negatives into every keyword and auto ad group; a phrase over the product's own keyword held
 *   n-gram    a word wasting across two terms past the pooled test and the gate → one phrase; never a word of a converting,
 *             targeted or protected term; the exact it covers in the same place is dropped
 *   isolation a term with a live exact home negated exact elsewhere; where it converts, only once the home converts
 *   budget    never above the maximum (held, named); at the warning level duplicates retire (a phrase over exacts, a twin),
 *             a person's negative is left, a negative sharing its Amazon id is never a cover; recurring words → one phrase
 *   revive    the product's own keyword under its negative, a protected term, a term it now leads, a term that converted
 *             where it is blocked — never an isolation negative; a person's or unknown negative asks first
 *   levels    per campaign: OBSERVE logs, PROPOSE asks, AUTO writes; an order asks first; the shadow days and the server
 *             switch hold PROPOSE and AUTO to shadow; excluded, locked and OFF campaigns are left, named
 *   caps      20 new negatives a day (each placement counts), today's acted ones counted once; revives capped
 *   log       a waiting request is not asked again; a rejected one waits 30 days; today's write is not redone
 *
 * Every value is made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decideTerm, termTests, type LeadVerdict, type ProductContext, type TermDecision, type TermEvidence, type TermFacts, type TermPlace } from './terms.js'
import {
  BRAIN_NEGATIVES_ACTOR, coverOf, coversOf, decideNegatives, holdsRun, itemKey, pieceAllowed, piecesOf, reconcile, REJECTED_HOLD_DAYS, REVIVES_PER_DAY, shadowSinceOf,
  type NegAdGroup, type NegCampaign, type NegativesInput, type NegItem, type StandingNegative,
} from './negatives.js'
import { leverWriterOf } from '../ads-write-gate.js'
import type { Positive } from '../ads-winner-lock.js'

const NOW = new Date('2026-10-09T05:25:00Z')
const DAY = 86_400_000
const ev = (clicks: number, orders: number, spendCents: number, salesCents = orders * 8000): TermEvidence => ({ impressions: clicks * 10, clicks, orders, spendCents, salesCents })

const ctx: ProductContext = {
  productId: 'jacket',
  pool: { nodes: [{ level: 'product', evidence: { clicks: 20_000, orders: 400, salesCents: 3_200_000, costCents: 400_000 } }, { level: 'market', evidence: { clicks: 20_000, orders: 400, salesCents: 3_200_000, costCents: 400_000 } }], listPriceCents: 8000 },
  targetAcos: { value: 0.25, source: 'the ads strategy: IT' },
  bandTop: { value: 0.3, source: 'the band top' },
  harvestGroup: null, negateGroup: null,
  protections: [{ term: 'acme', matchType: 'CONTAINS', reason: 'brand' } as never],
  brand: ['storm'],
  margin: { value: 0.4, source: 'profit' },
  levers: { negatives: 'AUTO', harvest: 'OBSERVE' },
  lockedTerms: { negatives: new Set(), harvest: new Set() },
  caps: { negativesPerDay: 20, harvestPerDay: 10 },
}

const place = (adGroupId: string, match: TermPlace['match'], extra: Partial<TermPlace> = {}): TermPlace => ({ campaignId: `c-${adGroupId.slice(2)}`, adGroupId, targetId: `t-${adGroupId}-${match}`, match, ...extra })
function decision(term: string, evidence: TermEvidence, opts: { targets?: TermPlace[]; negatives?: TermPlace[]; lead?: LeadVerdict | null; context?: ProductContext } = {}): TermDecision {
  const f: TermFacts = { term, evidence, targets: opts.targets ?? [], negatives: opts.negatives ?? [], destination: { source: 'none', adGroupId: null, keywords: null } }
  const c = opts.context ?? ctx
  return decideTerm(f, c, termTests(f, c), opts.lead ?? null)
}
const pos = (adGroupId: string, text: string, match: Positive['match'], live = true): Positive => ({ adTargetId: `p-${adGroupId}-${text}`, adGroupId, text, match, live })
const campaign = (id: string, extra: Partial<NegCampaign> = {}): NegCampaign => ({ id, name: id, status: 'ENABLED', targetingType: 'MANUAL', lever: 'AUTO', leverWhy: 'the negatives lever: AUTO', lockedAdGroups: new Set(), warn: 800, max: 950, ...extra })
const group = (id: string, campaignId: string, positives: Positive[] = [], extra: Partial<NegAdGroup> = {}): NegAdGroup => ({ id, campaignId, name: id, status: 'ENABLED', positives, ...extra })
let nid = 0
const neg = (adGroupId: string, text: string, match: StandingNegative['match'], extra: Partial<StandingNegative> = {}): StandingNegative => ({
  id: `n${++nid}`, campaignId: `c-${adGroupId.slice(2)}`, adGroupId, level: 'AD_GROUP', match, text, externalTargetId: `EXT-${nid}`, live: true, origin: 'automation', createdAt: new Date(NOW.getTime() - 40 * DAY), ...extra,
})

/** The jacket's account: auto, exact (home of "racing jacket"), broad, a product-targeting campaign, and the second auto group. */
function input(over: Partial<NegativesInput> & { decisions: TermDecision[]; places?: Record<string, Record<string, TermEvidence>> }): NegativesInput {
  const places = new Map(Object.entries(over.places ?? {}).map(([t, byGroup]) => [t, new Map(Object.entries(byGroup))]))
  return {
    productId: 'jacket', market: 'IT', now: NOW, protections: ctx.protections, brand: ctx.brand, lockedTerms: new Set(),
    cr: 0.02, aovCents: 8000, targetAcos: ctx.targetAcos,
    campaigns: [campaign('c-auto', { targetingType: 'AUTO' }), campaign('c-exact'), campaign('c-broad'), campaign('c-pat')],
    adGroups: [
      group('g-auto', 'c-auto'), group('g-auto2', 'c-auto'),
      group('g-exact', 'c-exact', [pos('g-exact', 'racing jacket', 'EXACT')]),
      group('g-broad', 'c-broad', [pos('g-broad', 'moto jacket', 'BROAD')]),
      group('g-pat', 'c-pat', [pos('g-pat', 'B0COMPET01', 'PRODUCT')]),
    ],
    standing: [], productSet: [],
    caps: { perDay: 20, usedToday: 0, revivedToday: 0 },
    gates: { ceilingLive: true, shadowSince: new Date(NOW.getTime() - 30 * DAY), shadowDays: 14 },
    ...over,
    places,
  } as NegativesInput
}
const adds = (items: NegItem[]) => items.filter((i) => i.action === 'ADD')
const brief = (i: NegItem) => `${i.action} ${i.reasons[0]} ${i.match} "${i.text}" ${i.level === 'CAMPAIGN' ? i.campaignId : i.adGroupId} ${i.mode}${i.heldBy ? ' HELD' : ''}`

describe('AB-10 — where and what to negate', () => {
  it('waste: exact where it served — its ad group; one campaign negative over two ad groups of one campaign; an ASIN as a product target', () => {
    const cheap = decision('cheap jacket', ev(300, 0, 6000))
    expect(cheap.state).toBe('NEGATE_CANDIDATE')
    const asin = decision('b0compet99', ev(300, 0, 6000))
    const plan = decideNegatives(input({
      decisions: [cheap, asin],
      places: { 'cheap jacket': { 'g-auto': ev(200, 0, 4000), 'g-auto2': ev(60, 0, 1200), 'g-broad': ev(40, 0, 800) }, b0compet99: { 'g-auto': ev(300, 0, 6000) } },
    }))
    expect(plan.items.map(brief)).toEqual([
      'ADD waste PRODUCT "B0COMPET99" g-auto AUTO',
      'ADD waste EXACT "cheap jacket" c-auto AUTO',
      'ADD waste EXACT "cheap jacket" g-broad AUTO',
    ])
    expect(plan.items[1]).toMatchObject({ level: 'CAMPAIGN', adGroupId: null, evidence: { placeClicks: 260, clicksNeeded: 149 } })
    expect(plan.items[1].why).toMatch(/one campaign negative: it served in 2 ad groups of this campaign/)
    // No money in the words (the conversion rate is a percent; amounts live under evidence.money).
    expect(plan.items[1].why).not.toMatch(/€|\d+\.\d\d(?! %)|6000|4000/)
  })

  it('waste: never in a product-targeting ad group, a place already blocked, or a place that would block its own keyword', () => {
    const cheap = decision('cheap jacket', ev(300, 0, 6000))
    const plan = decideNegatives(input({
      decisions: [cheap],
      standing: [neg('g-auto', 'cheap', 'PHRASE', { origin: 'person' })],
      places: { 'cheap jacket': { 'g-auto': ev(200, 0, 4000), 'g-pat': ev(50, 0, 1000), 'g-broad': ev(50, 0, 1000) } },
    }))
    expect(plan.items.map(brief)).toEqual(['ADD waste EXACT "cheap jacket" g-broad AUTO'])
  })

  it('a NEGATED term still served in another place is negated there too, the same pooled test passing', () => {
    const d = decision('storm sale', ev(300, 0, 6000), { negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })] })
    const cheap = decision('rain coat', ev(300, 0, 6000), { negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })] })
    expect(cheap.state).toBe('NEGATED')
    const plan = decideNegatives(input({
      decisions: [d, cheap],
      standing: [neg('g-auto', 'rain coat', 'EXACT')],
      places: { 'rain coat': { 'g-auto': ev(200, 0, 4000), 'g-broad': ev(100, 0, 2000) }, 'storm sale': { 'g-broad': ev(300, 0, 6000) } },
    }))
    // "storm sale" holds the brand word: never negated, wherever it served.
    expect(plan.items.map(brief)).toEqual(['ADD waste EXACT "rain coat" g-broad AUTO'])
  })

  it('guards: never a protected term, the brand, a winner, a term with an order, a term the product leads, a locked term', () => {
    const lead: LeadVerdict = { leadProductId: 'jacket', rule: 'profit', leadBidCents: 50, maxBidCents: 40, why: 'test' }
    const decisions = [
      decision('giacca acme', ev(300, 0, 6000)),
      decision('storm jacket', ev(300, 0, 6000)),
      decision('touring jacket', ev(150, 5, 2000)),
      decision('one order jacket', ev(400, 1, 8000)),
      decision('led jacket', ev(300, 0, 6000), { lead }),
      decision('locked jacket', ev(300, 0, 6000)),
    ]
    expect(decisions.map((d) => d.state)).toEqual(['PROTECTED', 'PROTECTED', 'HARVEST_CANDIDATE', 'WATCH', 'WATCH', 'NEGATE_CANDIDATE'])
    const plan = decideNegatives(input({
      decisions, lockedTerms: new Set(['locked jacket']),
      places: Object.fromEntries(decisions.map((d) => [d.term, { 'g-auto': d.evidence }])),
    }))
    expect(plan.items).toEqual([])
  })
})

describe('AB-10 — the product set, n-grams and isolation', () => {
  it('the playbook\'s negatives go into every keyword and auto ad group; a phrase over the product\'s own keyword is held there; none in a product-targeting ad group', () => {
    const plan = decideNegatives(input({ decisions: [], productSet: [{ text: 'Free', match: 'EXACT' }, { text: 'jacket', match: 'PHRASE' }, { text: 'B0COMPET02', match: 'EXACT' }] }))
    expect(plan.items.map(brief).sort()).toEqual([
      'ADD productSet EXACT "free" g-auto AUTO', 'ADD productSet EXACT "free" g-auto2 AUTO', 'ADD productSet EXACT "free" g-broad AUTO', 'ADD productSet EXACT "free" g-exact AUTO',
      'ADD productSet PHRASE "jacket" g-auto AUTO', 'ADD productSet PHRASE "jacket" g-auto2 AUTO',
      'ADD productSet PHRASE "jacket" g-broad AUTO HELD', 'ADD productSet PHRASE "jacket" g-exact AUTO HELD',
    ])
    expect(plan.items.find((i) => i.adGroupId === 'g-exact' && i.match === 'PHRASE')!.heldBy).toMatch(/would block the product's own exact keyword "racing jacket" in ad group g-exact \(the lock L1\)/)
  })

  it('n-gram: a word wasting across two terms past the pooled test and the gate becomes one phrase; the exact it covers in that place is dropped', () => {
    const blue = decision('kids jacket blue', ev(160, 0, 3200))
    const red = decision('kids helmet red', ev(100, 0, 2000))
    const racing = decision('racing jacket', ev(600, 18, 12_000), { targets: [place('g-exact', 'EXACT', { bidCents: 60 })] })
    expect([blue.state, red.state, racing.state]).toEqual(['NEGATE_CANDIDATE', 'WATCH', 'TARGETED'])
    const plan = decideNegatives(input({
      decisions: [blue, red, racing],
      places: { 'kids jacket blue': { 'g-auto': ev(160, 0, 3200) }, 'kids helmet red': { 'g-auto': ev(100, 0, 2000) }, 'racing jacket': { 'g-exact': ev(600, 18, 12_000) } },
    }))
    // "jacket" is in a targeted term (never a phrase); "kids" passes: 260 clicks, 0 orders, two terms.
    expect(plan.items.map(brief)).toEqual(['ADD ngram PHRASE "kids" g-auto AUTO'])
    expect(plan.items[0].evidence).toMatchObject({ termCount: 2, clicks: 260, clicksNeeded: 149, terms: ['kids jacket blue', 'kids helmet red'] })
  })

  it('n-gram: never a word of a converting or protected term, a stopword, a number, a size or one term alone', () => {
    const terms = [
      decision('kids jacket blue', ev(160, 0, 3200)), decision('kids helmet red', ev(100, 0, 2000)), decision('kids gloves', ev(50, 2, 600)),
      decision('per moto xl', ev(200, 0, 4000)), decision('per moto xxl', ev(200, 0, 4000)),
    ]
    const plan = decideNegatives(input({ decisions: terms, places: Object.fromEntries(terms.map((d) => [d.term, { 'g-auto': d.evidence }])) }))
    // "kids" is in a converting term; "per", "xl", "xxl" are a stopword and sizes: only "moto" wastes across terms.
    expect(plan.items.filter((i) => i.reasons[0] === 'ngram').map((i) => i.text)).toEqual(['moto'])
    expect(pieceAllowed('per')).toBe(false)
    expect(pieceAllowed('per moto')).toBe(false)
    expect(pieceAllowed('2026')).toBe(false)
    expect(pieceAllowed('xxl')).toBe(false)
    expect(pieceAllowed('b0compet01')).toBe(false)
    expect(piecesOf('a b c d')).toEqual(['a', 'b', 'c', 'd', 'a b', 'b c', 'c d', 'a b c', 'b c d'])
    expect(holdsRun('cheap racing jacket', 'racing jacket')).toBe(true)
    expect(holdsRun('cheap racing jacket', 'cheap jacket')).toBe(false)
  })

  it('isolation: a term with a live exact home is negated exact in the product\'s other ad groups; where it converts, only once its home converts', () => {
    const racing = decision('racing jacket', ev(800, 3, 16_000), { targets: [place('g-exact', 'EXACT', { bidCents: 60 })] })
    const plan = decideNegatives(input({ decisions: [racing], places: { 'racing jacket': { 'g-exact': ev(600, 0, 12_000), 'g-auto': ev(150, 3, 3000), 'g-broad': ev(50, 0, 1000) } } }))
    expect(plan.items.map(brief)).toEqual(['ADD isolation EXACT "racing jacket" g-auto AUTO HELD', 'ADD isolation EXACT "racing jacket" g-broad AUTO'])
    expect(plan.items[0].heldBy).toMatch(/a winner keeps running where it wins until its home proves itself/)
    // Once the home converts, the winner's old place is closed too (the Owner's handover rule "proven").
    const proven = decideNegatives(input({ decisions: [racing], places: { 'racing jacket': { 'g-exact': ev(600, 9, 12_000), 'g-auto': ev(150, 3, 3000) } } }))
    expect(proven.items.map(brief)).toEqual(['ADD isolation EXACT "racing jacket" g-auto AUTO'])
    // A home that is not live (paused, or not at Amazon) sends no search anywhere: nothing isolated.
    const paused = decideNegatives(input({
      decisions: [racing], places: { 'racing jacket': { 'g-auto': ev(150, 0, 3000) } },
      adGroups: [group('g-auto', 'c-auto'), group('g-exact', 'c-exact', [pos('g-exact', 'racing jacket', 'EXACT', false)])],
    }))
    expect(paused.items).toEqual([])
  })
})

describe('AB-10 — the per-entity budget: 800 warn / 950 max, duplicates retire, recurring words consolidate', () => {
  const full = (adGroupId: string, n: number, prefix = 'filler') => Array.from({ length: n }, (_, k) => neg(adGroupId, `${prefix} ${k}`, 'EXACT', { origin: 'person' }))

  it('never above the maximum: the add is held and named; below the warning nothing retires', () => {
    const cheap = decision('cheap jacket', ev(300, 0, 6000))
    const plan = decideNegatives(input({ decisions: [cheap], standing: full('g-broad', 950), places: { 'cheap jacket': { 'g-broad': ev(300, 0, 6000) } } }))
    expect(plan.items.map(brief)).toEqual(['ADD waste EXACT "cheap jacket" g-broad AUTO HELD'])
    expect(plan.items[0].heldBy).toMatch(/the ad group "g-broad" holds 950 negatives: never more than 950 \(Amazon allows 1,000; §2\.7\)/)
    expect(plan.entities.find((e) => e.id === 'g-broad')).toMatchObject({ standing: 950, adds: 0, retires: 0, after: 950, state: 'full', warn: 800, max: 950 })
    expect(plan.entities.find((e) => e.id === 'g-auto')).toMatchObject({ standing: 0, state: 'ok' })
  })

  it('at the warning level a duplicate retires (a phrase over an exact, a campaign negative over an ad group one, a twin) and frees its slot; a person\'s is left; one sharing its Amazon id is never a cover', () => {
    const cheap = decision('cheap jacket', ev(300, 0, 6000))
    const standing = [
      ...full('g-broad', 795),
      neg('g-broad', 'cheap', 'PHRASE', { origin: 'person' }),
      neg('g-broad', 'cheap boots', 'EXACT'),
      neg('g-broad', 'old helmet', 'EXACT', { createdAt: new Date(NOW.getTime() - 50 * DAY) }),
      neg('g-broad', 'old helmet', 'EXACT'),
      neg('g-broad', 'cheap socks', 'EXACT', { origin: 'person' }),
      neg('g-broad', 'used jacket', 'EXACT', { externalTargetId: 'SAME' }),
      neg('g-broad', 'used', 'PHRASE', { externalTargetId: 'SAME' }),
    ]
    const plan = decideNegatives(input({
      decisions: [cheap], standing: [...standing, neg('g-broad', 'winter sale', 'EXACT', { level: 'CAMPAIGN' }), neg('g-broad', 'winter sale', 'EXACT')],
      places: { 'cheap jacket': { 'g-auto': ev(300, 0, 6000) } },
      campaigns: [campaign('c-auto', { targetingType: 'AUTO' }), campaign('c-exact'), campaign('c-broad', { warn: 800, max: 803 }), campaign('c-pat')],
    }))
    const retired = plan.items.filter((i) => i.action === 'RETIRE')
    expect(retired.map((i) => i.text).sort()).toEqual(['cheap boots', 'old helmet', 'winter sale'])
    expect(retired.every((i) => i.reasons[0] === 'duplicate' && i.mode === 'AUTO' && !i.heldBy)).toBe(true)
    expect(retired.find((i) => i.text === 'cheap boots')!.why).toMatch(/negative phrase "cheap" at its ad group already blocks what this negative exact "cheap boots" blocks/)
    // The newer twin retires, the older stays; the campaign negative covers its ad-group copy.
    expect(retired.find((i) => i.text === 'old helmet')!.negativeId).toBe(standing.filter((n) => n.text === 'old helmet')[1].id)
    expect(plan.entities.find((e) => e.id === 'g-broad')).toMatchObject({ retires: 3, state: 'full' })
  })

  it('coversOf: a newer twin is covered by the older (never both ways); a cover nothing covers is named', () => {
    const a = neg('g-auto', 'x y', 'EXACT', { createdAt: new Date(1) })
    const b = neg('g-auto', 'x y', 'EXACT', { createdAt: new Date(2) })
    const p1 = neg('g-auto', 'x', 'PHRASE')
    const p2 = neg('g-auto', 'x y', 'PHRASE')
    const index = { standingOf: (level: string, id: string) => (level === 'AD_GROUP' && id === 'g-auto' ? [a, b, p1, p2] : []) }
    expect(coversOf(a, index).map((c) => c.id)).toEqual([p1.id, p2.id])
    expect(coversOf(b, index).map((c) => c.id)).toEqual([a.id, p1.id, p2.id])
    expect(coversOf(p1, index)).toEqual([])
    expect(coverOf(b, index)!.id).toBe(p1.id)
  })

  it('consolidation: at the warning level a word in 3 exact negatives an engine made becomes one phrase there (they retire once it is live)', () => {
    const standing = [...full('g-broad', 797), neg('g-broad', 'cheap boots', 'EXACT'), neg('g-broad', 'cheap socks', 'EXACT'), neg('g-broad', 'cheap hat', 'EXACT')]
    const plan = decideNegatives(input({ decisions: [], standing }))
    expect(plan.items.map(brief)).toEqual(['ADD consolidate PHRASE "cheap" g-broad AUTO'])
    expect(plan.items[0].evidence).toMatchObject({ termCount: 3 })
    // Once the phrase is live, the exacts it holds are duplicates and retire.
    const later = decideNegatives(input({ decisions: [], standing: [...standing, neg('g-broad', 'cheap', 'PHRASE', { origin: 'brain' })] }))
    expect(later.items.filter((i) => i.action === 'RETIRE').map((i) => i.text).sort()).toEqual(['cheap boots', 'cheap hat', 'cheap socks'])
  })
})

describe('AB-10 — revive', () => {
  it('the product\'s own keyword under its negative, a protected term, a term it now leads, a term that converted where it is blocked', () => {
    nid = 100
    const ownBlocked = neg('g-exact', 'racing jacket', 'EXACT')
    const protectedNeg = neg('g-auto', 'giacca acme', 'EXACT')
    const ledNeg = neg('g-auto', 'led jacket', 'EXACT')
    const convertsNeg = neg('g-broad', 'city jacket', 'EXACT')
    const lead: LeadVerdict = { leadProductId: 'jacket', rule: 'profit', leadBidCents: 50, maxBidCents: 40, why: 'test' }
    const racing = decision('racing jacket', ev(600, 18, 12_000), { targets: [place('g-exact', 'EXACT', { bidCents: 60 })], negatives: [{ ...place('g-exact', 'EXACT', { level: 'AD_GROUP' }), targetId: ownBlocked.id }] })
    const acme = decision('giacca acme', ev(100, 0, 2000), { negatives: [{ ...place('g-auto', 'EXACT', { level: 'AD_GROUP' }), targetId: protectedNeg.id }] })
    const led = decision('led jacket', ev(100, 0, 2000), { negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })], targets: [place('g-broad', 'PHRASE')], lead })
    const city = decision('city jacket', ev(120, 1, 2400), { negatives: [place('g-broad', 'EXACT', { level: 'AD_GROUP' })] })
    expect([racing.state, acme.state, led.state, city.state]).toEqual(['TARGETED', 'PROTECTED', 'NEGATED', 'WATCH'])
    const plan = decideNegatives(input({
      decisions: [racing, acme, led, city], standing: [ownBlocked, protectedNeg, ledNeg, convertsNeg],
      places: { 'city jacket': { 'g-broad': ev(80, 1, 1600), 'g-auto': ev(40, 0, 800) }, 'racing jacket': { 'g-exact': ev(600, 18, 12_000) } },
    }))
    const retires = plan.items.filter((i) => i.action === 'RETIRE')
    expect(Object.fromEntries(retires.map((i) => [i.negativeId, `${i.reasons[0]} ${i.mode}`]))).toEqual({
      [ownBlocked.id]: 'reviveSelfBlocking AUTO', [protectedNeg.id]: 'reviveProtected AUTO', [ledNeg.id]: 'reviveLead AUTO', [convertsNeg.id]: 'reviveConverts AUTO',
    })
    expect(retires.find((i) => i.negativeId === convertsNeg.id)!.why).toMatch(/converted where this negative exact "city jacket" blocks it now \(1 order at its ad group/)
  })

  it('never an isolation negative (the term has its home elsewhere) nor a harvest candidate\'s source; a person\'s or unknown negative asks first; a phrase asks first', () => {
    nid = 200
    const isolation = neg('g-auto', 'racing jacket', 'EXACT')
    const racing = decision('racing jacket', ev(800, 20, 16_000), { targets: [place('g-exact', 'EXACT', { bidCents: 60 })], negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })] })
    const source = neg('g-auto', 'touring jacket', 'EXACT')
    const touring = decision('touring jacket', ev(150, 5, 2000), { negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })] })
    expect([racing.state, touring.state]).toEqual(['TARGETED', 'HARVEST_CANDIDATE'])
    const unknown = neg('g-exact', 'moto race', 'EXACT', { origin: 'unknown' })
    const phrase = neg('g-exact', 'cross', 'PHRASE')
    const moto = decision('moto race', ev(300, 9, 6000), { targets: [place('g-exact', 'EXACT', { bidCents: 50 })], negatives: [{ ...place('g-exact', 'EXACT', { level: 'AD_GROUP' }), targetId: unknown.id }] })
    const cross = decision('cross boots', ev(300, 9, 6000), { targets: [place('g-exact', 'EXACT', { bidCents: 50 })], negatives: [{ ...place('g-exact', 'PHRASE', { level: 'AD_GROUP', text: 'cross' }), targetId: phrase.id }] })
    const plan = decideNegatives(input({
      decisions: [racing, touring, moto, cross], standing: [isolation, source, unknown, phrase],
      places: { 'racing jacket': { 'g-auto': ev(200, 2, 4000), 'g-exact': ev(600, 18, 12_000) }, 'touring jacket': { 'g-auto': ev(150, 5, 2000) } },
      adGroups: [group('g-auto', 'c-auto'), group('g-exact', 'c-exact', [pos('g-exact', 'racing jacket', 'EXACT'), pos('g-exact', 'moto race', 'EXACT'), pos('g-exact', 'cross boots', 'EXACT')])],
    }))
    const retires = plan.items.filter((i) => i.action === 'RETIRE')
    expect(retires.map((i) => [i.negativeId, i.reasons[0], i.askFirst, i.mode]).sort()).toEqual([
      [unknown.id, 'reviveSelfBlocking', true, 'PROPOSE'],
      [phrase.id, 'reviveSelfBlocking', true, 'PROPOSE'],
    ])
    expect(retires.find((i) => i.negativeId === unknown.id)!.why).toMatch(/a negative Nexus cannot attribute .* so a person decides/)
    expect(retires.find((i) => i.negativeId === phrase.id)!.why).toMatch(/a phrase also blocks other searches there, so a person decides/)
  })

  it('revives are capped per day', () => {
    const lead: LeadVerdict = { leadProductId: 'jacket', rule: 'profit', leadBidCents: 50, maxBidCents: 40, why: 'test' }
    const terms = Array.from({ length: REVIVES_PER_DAY + 2 }, (_, k) => `led term ${k}`)
    const decisions = terms.map((t) => decision(t, ev(10, 0, 200), { negatives: [place('g-auto', 'EXACT', { level: 'AD_GROUP' })], targets: [place('g-broad', 'PHRASE')], lead }))
    const plan = decideNegatives(input({ decisions, standing: terms.map((t) => neg('g-auto', t, 'EXACT')), caps: { perDay: 20, usedToday: 0, revivedToday: 1 } }))
    expect(plan.items.filter((i) => !i.heldBy)).toHaveLength(REVIVES_PER_DAY - 1)
    expect(plan.items.filter((i) => i.heldBy).every((i) => /past today's cap of 10 revives/.test(i.heldBy!))).toBe(true)
  })
})

describe('AB-10 — levels, the shadow, the switch, excluded and locked campaigns, caps', () => {
  const cheap = () => decision('cheap jacket', ev(300, 0, 6000))
  const everywhere = { 'cheap jacket': { 'g-auto': ev(100, 0, 2000), 'g-exact': ev(100, 0, 2000), 'g-broad': ev(100, 0, 2000) } }

  it('per campaign: OBSERVE logs, PROPOSE asks, AUTO writes; a negative on a term with an order asks first even at AUTO', () => {
    const plan = decideNegatives(input({
      decisions: [cheap()], places: everywhere,
      campaigns: [campaign('c-auto', { targetingType: 'AUTO', lever: 'OBSERVE' }), campaign('c-exact', { lever: 'PROPOSE' }), campaign('c-broad'), campaign('c-pat')],
    }))
    expect(plan.items.map(brief)).toEqual(['ADD waste EXACT "cheap jacket" g-auto OBSERVE', 'ADD waste EXACT "cheap jacket" g-broad AUTO', 'ADD waste EXACT "cheap jacket" g-exact PROPOSE'])
    const owner = { ...ctx, negateGroup: { minClicks: 50, minSpendCents: 1000, maxOrders: 1, windowDays: 60, source: 'the ads strategy: IT' } }
    const withOrder = decision('one order jacket', ev(100, 1, 2000), { context: owner })
    expect(withOrder).toMatchObject({ state: 'NEGATE_CANDIDATE', askFirst: true })
    const asked = decideNegatives(input({ decisions: [withOrder], places: { 'one order jacket': { 'g-broad': ev(100, 1, 2000) } } }))
    expect(asked.items.map(brief)).toEqual(['ADD waste EXACT "one order jacket" g-broad PROPOSE'])
    expect(asked.items[0].askFirst).toBe(true)
  })

  it('the shadow days and the server switch hold PROPOSE and AUTO to shadow, named; the Owner\'s 0 days acts at once', () => {
    const young = decideNegatives(input({ decisions: [cheap()], places: everywhere, gates: { ceilingLive: true, shadowSince: new Date(NOW.getTime() - 3 * DAY), shadowDays: 14 } }))
    expect(young.shadow).toMatchObject({ inShadow: true, daysRun: 3, days: 14 })
    expect(young.items.every((i) => i.mode === 'OBSERVE' && /at AUTO, shadow for now: the negatives lever runs 14 days in shadow first .* 3 days run/.test(i.why))).toBe(true)
    const off = decideNegatives(input({ decisions: [cheap()], places: everywhere, gates: { ceilingLive: false, shadowSince: new Date(NOW.getTime() - 30 * DAY), shadowDays: 14 } }))
    expect(off.items.every((i) => i.mode === 'OBSERVE' && /NEXUS_BID_BRAIN_MODE is not live/.test(i.why))).toBe(true)
    const owner = decideNegatives(input({ decisions: [cheap()], places: everywhere, gates: { ceilingLive: true, shadowSince: NOW, shadowDays: 0 } }))
    expect(owner.items.every((i) => i.mode === 'AUTO')).toBe(true)
  })

  it('an excluded, locked, OFF or paused campaign is left and named; a locked ad group takes nothing; nothing is ever planned in a shared campaign (it is not the product\'s)', () => {
    const plan = decideNegatives(input({
      decisions: [cheap()], places: { 'cheap jacket': { 'g-auto': ev(100, 0, 2000), 'g-auto2': ev(100, 0, 2000), 'g-exact': ev(100, 0, 2000), 'g-broad': ev(100, 0, 2000), 'g-shared': ev(100, 0, 2000) } },
      campaigns: [
        campaign('c-auto', { targetingType: 'AUTO', lockedAdGroups: new Set(['g-auto']) }),
        campaign('c-exact', { lever: 'EXCLUDED', leverWhy: 'the negatives lever: excluded by the Owner\'s campaign override' }),
        campaign('c-broad', { lever: 'LOCKED', leverWhy: 'the negatives lever: locked at the Owner\'s own value' }),
        campaign('c-pat', { lever: 'OFF', leverWhy: 'the negatives lever: OFF' }),
        campaign('c-paused', { status: 'PAUSED' }),
      ],
    }))
    expect(plan.items.map(brief)).toEqual(['ADD waste EXACT "cheap jacket" g-auto2 AUTO'])
    expect(plan.skipped.map((s) => [s.campaignId, s.why])).toEqual([
      ['c-broad', 'the negatives lever: locked at the Owner\'s own value'],
      ['c-exact', 'the negatives lever: excluded by the Owner\'s campaign override'],
      ['c-pat', 'the negatives lever: OFF'],
      ['c-paused', 'not running (PAUSED): a negative there blocks nothing now'],
    ])
    // A locked ad group is never an entity the brain counts or writes.
    expect(plan.entities.map((e) => e.id)).toEqual(['c-auto', 'g-auto2'])
  })

  it('caps: 20 new negatives a day, each placement counts, in priority order; today\'s acted ones are counted once', () => {
    const terms = ['alpha coat', 'beta boots', 'gamma hat'].map((t, k) => decision(t, ev(300 + k, 0, 6000 + k * 100)))
    const places = Object.fromEntries(terms.map((d) => [d.term, { 'g-broad': d.evidence }]))
    const plan = decideNegatives(input({ decisions: terms, places, productSet: [{ text: 'free', match: 'EXACT' }], caps: { perDay: 2, usedToday: 0, revivedToday: 0 } }))
    // The Owner's set first (4 places: 2 fit), then waste by spend: none left today.
    expect(plan.items.filter((i) => !i.heldBy).map((i) => `${i.reasons[0]} ${i.text} ${i.adGroupId}`)).toEqual(['productSet free g-auto', 'productSet free g-auto2'])
    expect(plan.items.filter((i) => i.heldBy).every((i) => /past today's cap of 2 new negatives for this product/.test(i.heldBy!))).toBe(true)
    const used = decideNegatives(input({ decisions: terms, places, caps: { perDay: 2, usedToday: 2, revivedToday: 0 } }))
    expect(used.items.filter((i) => !i.heldBy)).toEqual([])
    // The two already asked today are in usedToday and in the plan: counted once, the third still waits.
    const keys = new Set(used.items.slice(0, 2).map((i) => i.key))
    const again = decideNegatives(input({ decisions: terms, places, caps: { perDay: 2, usedToday: 2, revivedToday: 0, actedKeys: keys } }))
    expect(again.items.filter((i) => !i.heldBy).map((i) => i.key).sort()).toEqual([...keys].sort())
  })
})

describe('AB-10 — the log: idempotent reruns, waiting and rejected requests; the shadow\'s start; the brain\'s actor', () => {
  const item = { mode: 'AUTO' as const, heldBy: null }
  it('reconcile', () => {
    expect(reconcile(item, undefined, undefined, NOW)).toMatchObject({ status: 'PLANNED', act: 'write' })
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, undefined, undefined, NOW)).toMatchObject({ status: 'PLANNED', act: 'propose' })
    expect(reconcile({ mode: 'OBSERVE', heldBy: null }, undefined, undefined, NOW)).toMatchObject({ status: 'SHADOW', act: null })
    expect(reconcile({ mode: 'AUTO', heldBy: 'full' }, undefined, undefined, NOW)).toMatchObject({ status: 'HELD', act: null })
    const proposed = { key: 'k', status: 'PROPOSED', approvalId: 'ap-1', actedAt: new Date(NOW.getTime() - DAY) }
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, proposed, { status: 'pending', decidedAt: null }, NOW)).toMatchObject({ status: 'PROPOSED', act: null, approvalId: 'ap-1' })
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, proposed, { status: 'rejected', decidedAt: new Date(NOW.getTime() - 2 * DAY) }, NOW)).toMatchObject({ status: 'REJECTED', act: null, note: expect.stringMatching(/rejected it: not asked again for 30 days/) })
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, proposed, { status: 'expired', decidedAt: null }, NOW)).toMatchObject({ status: 'PLANNED', act: 'propose' })
    const rejected = { key: 'k', status: 'REJECTED', approvalId: 'ap-1', actedAt: new Date(NOW.getTime() - (REJECTED_HOLD_DAYS - 1) * DAY) }
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, rejected, undefined, NOW)).toMatchObject({ status: 'REJECTED', act: null })
    expect(reconcile({ mode: 'PROPOSE', heldBy: null }, { ...rejected, actedAt: new Date(NOW.getTime() - (REJECTED_HOLD_DAYS + 1) * DAY) }, undefined, NOW)).toMatchObject({ status: 'PLANNED', act: 'propose' })
    const written = { key: 'k', status: 'WRITTEN', approvalId: null, actedAt: new Date(NOW.getTime() - 3_600_000) }
    expect(reconcile(item, written, undefined, NOW)).toMatchObject({ status: 'WRITTEN', act: null })
    expect(reconcile(item, { ...written, status: 'REFUSED' }, undefined, NOW)).toMatchObject({ status: 'REFUSED', act: null })
    expect(reconcile(item, { ...written, actedAt: new Date(NOW.getTime() - DAY) }, undefined, NOW)).toMatchObject({ status: 'PLANNED', act: 'write' })
  })

  it('the shadow starts at the enrollment, again after the Owner last had the lever OFF; OFF now: none', () => {
    const enrolled = new Date(NOW.getTime() - 40 * DAY)
    expect(shadowSinceOf(enrolled, [], NOW)).toEqual(enrolled)
    const back = new Date(NOW.getTime() - 5 * DAY)
    expect(shadowSinceOf(enrolled, [{ value: 'OFF', createdAt: new Date(NOW.getTime() - 20 * DAY), endedAt: back }, { value: 'AUTO', createdAt: back, endedAt: null }], NOW)).toEqual(back)
    expect(shadowSinceOf(enrolled, [{ value: 'OFF', createdAt: new Date(NOW.getTime() - 2 * DAY), endedAt: null }], NOW)).toBeNull()
    expect(shadowSinceOf(null, [], NOW)).toBeNull()
  })

  it('the brain writes as its own actor, which the write gate passes on a lever the product\'s brain owns', () => {
    expect(BRAIN_NEGATIVES_ACTOR).toBe('automation:ads-brain-negatives')
    expect(leverWriterOf('negatives', { actor: BRAIN_NEGATIVES_ACTOR })).toBe('brain')
    expect(leverWriterOf('negatives', { actor: 'automation:rule-1' })).toBe('other')
    expect(itemKey({ action: 'ADD', level: 'AD_GROUP', campaignId: 'c', adGroupId: 'g', match: 'EXACT', text: 'Cheap  Jacket' })).toBe('ADD|AD_GROUP|g|EXACT|cheap jacket')
    expect(itemKey({ action: 'RETIRE', level: 'AD_GROUP', campaignId: 'c', adGroupId: 'g', match: 'EXACT', text: 'x', negativeId: 'n1' })).toBe('RETIRE|n1')
  })
})
