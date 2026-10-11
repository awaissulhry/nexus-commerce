/**
 * HARVEST ENGINE — the pure plan of one harvest item (harvest/plan.ts): the destination (asked, else suggested in the
 * brain's order, never silently replaced), the landing guards (B1: an enabled copy stands, a paused copy is enabled, an
 * archived copy refuses the place; B10: a negative there refuses it), every source blocked (D3), the funnel blocks, the
 * Owner's saved "keep the source", the start bid (asked, the goal bid, else the CPC held in the strategy's band: B12), and
 * the refusals that keep an item out — each named, never dropped. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { funnelBlocks, harvestCampaignName, landingOf, placeRefusal, planItem, sourceBlocks, startBidOf, suggestDestination, type PlanProduct, type PlanTerm } from './plan.js'
import type { HarvestGroup, HarvestProductFacts } from '../brain/harvest.js'

const group = (id: string, role: HarvestGroup['role'], over: Partial<HarvestGroup> = {}): HarvestGroup => ({
  id, name: `${role ?? 'x'} group ${id}`, campaignId: `c-${id}`, campaignName: `${role ?? 'x'} campaign ${id}`, role, roleFromName: true,
  manual: role !== 'AUTO', keywords: role === 'AUTO' ? 0 : 5, productTargets: 0, serving: true, notServing: null, campaignMinCents: null, campaignMaxCents: null, ...over,
})

function product(groups: HarvestGroup[], over: Partial<PlanProduct> = {}, facts: Partial<HarvestProductFacts> = {}): PlanProduct {
  const f = {
    productId: 'p1', market: 'IT',
    ctx: { productId: 'p1', pool: { nodes: [], listPriceCents: null }, targetAcos: null, bandTop: null, harvestGroup: null, negateGroup: null, protections: [], brand: [], margin: null, levers: { negatives: 'OBSERVE', harvest: 'OBSERVE' }, lockedTerms: { negatives: new Set(), harvest: new Set() }, caps: { negativesPerDay: 10, harvestPerDay: 10 } },
    groups: new Map(groups.map((g) => [g.id, g])),
    campaigns: new Map(groups.map((g) => [g.campaignId, { name: g.campaignName, excluded: false, harvest: 'OBSERVE', negatives: 'OBSERVE', harvestWhy: '', negativesWhy: '', harvestTermLocks: new Set<string>(), negativesTermLocks: new Set<string>(), negativesAdGroupLocks: new Set<string>() }])),
    slots: [], strategyLimits: new Map(), marketLimits: { minBidCents: 10, maxBidCents: 90 }, structure: 'OBSERVE', structureWhy: '', records: new Map(),
    used: { keywordsToday: 0, campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 0 }, caps: { harvestPerDay: 10, newCampaignsPerWeek: 2, skcMax: 20, marketCampaignsPerWeek: 6 },
    ceiling: { live: false, why: 'shadow' }, newCampaign: null, newCampaignRefusal: 'none',
    ...facts,
  } as unknown as HarvestProductFacts
  return { productId: 'p1', market: 'IT', label: 'JACKET', facts: f, portfolioId: null, storedFor: () => null, paused: new Set(), brainRuns: false, ...over }
}

const decision = (over: Record<string, unknown> = {}) => ({
  term: 'touring jacket', isAsin: false, state: 'HARVEST_CANDIDATE', protection: null, lead: null, wouldLower: [], heldBy: null, capped: false, askFirst: false, why: '', clashes: [],
  evidence: { impressions: 700, clicks: 100, orders: 4, spendCents: 2000, salesCents: 30_000 }, targets: [], negatives: [],
  destination: { source: 'own', adGroupId: 'gx', keywords: 5 },
  tests: { harvest: { pass: true, by: 'brain', ordersNeeded: 1, clicksNeeded: 0, words: '' }, negate: { pass: false, by: 'brain', clicksNeeded: 0, cr: 0.04, spendGateCents: null, words: '' }, winner: false, protection: null, protectionWhy: null, cr: 0.04, aovCents: 7500, cpcCents: 20, profitPerClickCents: null },
  ...over,
}) as never

const term = (over: Partial<PlanTerm> = {}): PlanTerm => ({ term: 'touring jacket', isAsin: false, decision: decision(), sources: [{ adGroupId: 'ga', clicks: 80 }, { adGroupId: 'gp', clicks: 20 }], ...over })
const groups = () => [group('ga', 'AUTO'), group('gp', 'PHRASE'), group('gb', 'BROAD'), group('gx', 'EXACT')]
const none = () => null
const plan = (p: PlanProduct, t: PlanTerm, req: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  planItem({ req: { candidateId: 'IT|p1|touring jacket', ...req }, actor: 'PERSON', product: p, term: t, record: null, waiting: false, newCampaign: null, landing: none, ...extra } as never)

describe('the destination', () => {
  it('suggests the product\'s one exact ad group, blocks every source exact and adds the funnel blocks, at the asked bid', () => {
    const out = plan(product(groups()), term(), { bidCents: 35 })
    expect(out.refusal).toBeNull()
    expect(out.destination).toMatchObject({ kind: 'existing', how: 'own', adGroupId: 'gx', status: 'will-create' })
    expect(out.bid).toEqual({ cents: 35, why: 'the bid you set' })
    expect(out.sources.map((s) => [s.adGroupId, s.action, s.negMatch])).toEqual([['ga', 'negate', 'EXACT'], ['gp', 'negate', 'EXACT']])
    // The broad ad group is not a source: the funnel blocks it (exact → negative exact in phrase / broad / auto).
    expect(out.funnel.map((s) => [s.adGroupId, s.action, s.negMatch])).toEqual([['gb', 'negate', 'EXACT']])
  })

  it('a phrase harvest goes to the phrase ad group, a broad or auto source gets a negative phrase, the funnel only broad / auto', () => {
    const out = plan(product([...groups(), group('gp2', 'PHRASE', { keywords: 1 })]), term({ sources: [{ adGroupId: 'ga', clicks: 80 }, { adGroupId: 'gx', clicks: 5 }] }), { match: 'PHRASE', bidCents: 30 })
    expect(out.destination).toMatchObject({ kind: 'existing', how: 'ranked', adGroupId: 'gp' })
    expect(out.sources.map((s) => [s.adGroupId, s.negMatch])).toEqual([['ga', 'PHRASE'], ['gx', 'EXACT']])
    expect(out.funnel.map((s) => [s.adGroupId, s.negMatch])).toEqual([['gb', 'PHRASE']])
  })

  it('the asked ad group wins; one that cannot take it is refused with why, never replaced', () => {
    expect(plan(product(groups()), term(), { to: { adGroupId: 'gb' }, bidCents: 30 }).destination).toMatchObject({ adGroupId: 'gb', how: 'chosen' })
    const auto = plan(product(groups()), term(), { to: { adGroupId: 'ga' }, bidCents: 30 })
    expect(auto).toMatchObject({ destination: null, refusal: expect.stringMatching(/automatic ad group/) })
    const paused = plan(product([...groups(), group('gz', 'EXACT', { serving: false, notServing: 'its campaign is paused' })]), term(), { to: { adGroupId: 'gz' }, bidCents: 30 })
    expect(paused.refusal).toMatch(/does not serve now: its campaign is paused/)
    expect(plan(product(groups()), term(), { to: { adGroupId: 'not-mine' }, bidCents: 30 }).refusal).toMatch(/not one of this product's own ad groups/)
  })

  it('no ad group of the match: a new campaign is needed (named), and the item is refused until one is given', () => {
    const p = product([group('ga', 'AUTO')])
    expect(suggestDestination(p, term(), 'EXACT', none)).toMatchObject({ kind: 'new' })
    expect(plan(p, term(), { bidCents: 30 })).toMatchObject({ hold: { label: 'Needs a campaign' }, refusal: expect.stringMatching(/new campaign/) })
    const nc = { key: 'n1', productId: 'p1', match: 'EXACT', name: 'JACKET-SP-Keyword-Exact-Harvest', adGroupName: 'x', dailyBudgetCents: 500, portfolio: null }
    expect(plan(p, term(), { to: { newCampaign: 'n1' }, bidCents: 30 }, { newCampaign: nc })).toMatchObject({ refusal: null, destination: { kind: 'new', key: 'n1' } })
    expect(plan(p, term(), { to: { newCampaign: 'n1' }, bidCents: 30 }, { newCampaign: { ...nc, productId: 'p2' } }).refusal).toMatch(/another product/)
    // R1 (release review) — a new campaign belongs to one market: a term of another market (the same product family) is refused.
    expect(plan(p, term(), { to: { newCampaign: 'n1' }, bidCents: 30 }, { newCampaign: { ...nc, market: 'IT' } }).refusal).toBeNull()
    expect(plan(p, term(), { to: { newCampaign: 'n1' }, bidCents: 30 }, { newCampaign: { ...nc, market: 'DE' } })).toMatchObject({ hold: { label: 'Other market' }, refusal: expect.stringMatching(/in DE, this term in IT/) })
  })

  it('the Owner\'s saved place wins whole; one that cannot take it holds the item (never another place)', () => {
    const stored = (adGroupId: string, negateAtSource = true) => () => ({ adGroupId, negateAtSource, grain: 'line', own: true })
    expect(plan(product(groups(), { storedFor: stored('gb') }), term(), { bidCents: 30 }).destination).toMatchObject({ how: 'stored', adGroupId: 'gb' })
    expect(plan(product([...groups(), group('gz', 'EXACT', { serving: false, notServing: 'paused' })], { storedFor: stored('gz') }), term(), { bidCents: 30 })).toMatchObject({ destination: null, hold: { label: 'Saved place blocked' } })
    // negateAtSource off keeps the sources (shown), the request may switch it back on.
    const keep = plan(product(groups(), { storedFor: stored('gx', false) }), term(), { bidCents: 30 })
    expect(keep.storedKeepsSources).toBe(true)
    expect(keep.sources.every((s) => s.action === 'kept')).toBe(true)
    expect(plan(product(groups(), { storedFor: stored('gx', false) }), term(), { bidCents: 30, negateSource: true }).sources.every((s) => s.action === 'negate')).toBe(true)
  })
})

describe('B1 / B10 — the landing is the guard\'s decision (harvest-landing-guard.ts), never the engine\'s own', () => {
  it('landed = already there, enable = switched on (no landing yet), a hold or an unconfirmed switch refuses the place', () => {
    expect(landingOf({ kind: 'landed', targetId: 't1', externalTargetId: 'AMZ-T1', serves: true, why: 'runs' })).toEqual({ status: 'already-there', existingTargetId: 't1' })
    expect(landingOf({ kind: 'enable', targetId: 't1', externalTargetId: 'AMZ-T1', why: 'switch on' })).toEqual({ status: 're-enable', existingTargetId: 't1' })
    expect(landingOf({ kind: 'create', serves: true, why: 'nothing there' })).toEqual({ status: 'will-create', existingTargetId: null })
    const gx = group('gx', 'EXACT')
    expect(placeRefusal(gx, false, { kind: 'hold', deniedAt: 'landing_archived', why: 'ad group "Exact" cannot take "touring jacket": the exact keyword "touring jacket" there is archived' })).toMatch(/archived/)
    expect(placeRefusal(gx, false, { kind: 'hold', deniedAt: 'landing_negative', why: 'a negative exact "touring jacket" in ad group "Exact" blocks "touring jacket" there' })).toMatch(/blocks/)
    // H2 — a keyword switched on again that Amazon has not confirmed is no landing: the place waits.
    expect(placeRefusal(gx, false, { kind: 'landed', targetId: 't1', externalTargetId: 'AMZ', serves: false, why: 'switched on again and Amazon has not confirmed it yet' })).toMatch(/not confirmed/)
    expect(placeRefusal(gx, false, { kind: 'landed', targetId: 't1', externalTargetId: 'AMZ', serves: true, why: 'runs' })).toBeNull()
    // The suggestion skips a place the guard holds, and says why when none can take it.
    const out = plan(product(groups()), term(), { bidCents: 30 }, { landing: (id: string) => (id === 'gx' ? { kind: 'hold', deniedAt: 'landing_negative', why: 'a negative blocks it' } : null) })
    expect(out).toMatchObject({ destination: null, hold: { kind: 'destination' } })
  })

  it('a harvest left HALF_DONE (a switch-on with its blocks owed) is completed in the same place by harvesting it again', () => {
    const home = term({ decision: decision({ targets: [{ campaignId: 'c-gx', adGroupId: 'gx', targetId: 'k1', match: 'EXACT' }] }) })
    const out = plan(product(groups()), home, { bidCents: 30 }, { record: { status: 'HALF_DONE', actorKind: 'PERSON', destAdGroupId: 'gx' }, landing: () => ({ kind: 'landed', targetId: 'k1', externalTargetId: 'AMZ-K1', serves: true, why: 'runs' }) })
    expect(out).toMatchObject({ refusal: null, destination: { adGroupId: 'gx', status: 'already-there', existingTargetId: 'k1' } })
    // Not confirmed yet: it waits, named.
    expect(plan(product(groups()), home, { bidCents: 30 }, { record: { status: 'HALF_DONE', actorKind: 'PERSON', destAdGroupId: 'gx' }, landing: () => ({ kind: 'landed', targetId: 'k1', externalTargetId: 'AMZ-K1', serves: false, why: 'Amazon has not confirmed it yet' }) }).refusal).toMatch(/not confirmed/)
  })
})

describe('M5 — a paused source', () => {
  it('is never blocked by any actor\'s harvest, and a term whose every source is paused is refused for every actor', () => {
    const one = plan(product(groups(), { paused: new Set(['ga']) }), term(), { bidCents: 30 })
    expect(one.sources.map((s) => [s.adGroupId, s.action])).toEqual([['ga', 'skipped'], ['gp', 'negate']])
    expect(plan(product(groups(), { paused: new Set(['ga', 'gp']) }), term(), { bidCents: 30 }).hold).toMatchObject({ label: 'Source paused' })
  })
})

describe('the sources and the funnel', () => {
  it('a negative already there stands; a protected term is never negated (sources skipped, no funnel), the keyword still goes', () => {
    const negatives = [{ campaignId: 'c-gp', adGroupId: 'gp', targetId: 'n1', match: 'EXACT', level: 'AD_GROUP' }]
    const t = term({ decision: decision({ negatives }) })
    expect(sourceBlocks(product(groups()), t, 'EXACT', 'gx', { storedKeeps: false, actor: 'PERSON' }).map((s) => s.action)).toEqual(['negate', 'standing'])
    const prot = term({ decision: decision({ protection: 'protected-term' }) })
    const out = plan(product(groups()), prot, { bidCents: 30 })
    expect(out.refusal).toBeNull()
    expect(out.sources.every((s) => s.action === 'skipped')).toBe(true)
    expect(out.funnel).toEqual([])
  })

  it('the funnel never blocks an ad group where the product\'s own keyword is the term', () => {
    const t = term({ decision: decision({ targets: [{ campaignId: 'c-gb', adGroupId: 'gb', targetId: 'k1', match: 'BROAD' }] }) })
    expect(funnelBlocks(product(groups()), t, 'EXACT', 'gx', [])).toEqual([expect.objectContaining({ adGroupId: 'ga' }), expect.objectContaining({ adGroupId: 'gp' })])
    expect(plan(product(groups()), term(), { bidCents: 30, funnel: false }).funnel).toEqual([])
  })

  it('a rule leaves the campaigns the brain runs (sources skipped, a destination there refused); a person does not', () => {
    const p = product(groups(), { brainRuns: true })
    const rule = planItem({ req: { candidateId: 'x', bidCents: 30 }, actor: 'RULE', product: p, term: term(), record: null, waiting: false, newCampaign: null, landing: none })
    expect(rule).toMatchObject({ hold: { label: 'Brain decides' } })
    const person = plan(p, term(), { bidCents: 30 })
    expect(person.refusal).toBeNull()
  })
})

describe('the start bid (B12)', () => {
  it('the asked bid; else the goal bid; else the observed CPC held inside the strategy\'s lowest and highest bid', () => {
    const p = product(groups())
    expect(startBidOf(p, term(), group('gx', 'EXACT'), 40)).toEqual({ cents: 40, why: 'the bid you set' })
    expect(startBidOf(p, term(), group('gx', 'EXACT'), 1)).toMatchObject({ refusal: expect.stringMatching(/lowest bid/) })
    // No target ACoS anywhere: the goal bid cannot be computed — the CPC (20) is raised to the strategy's lowest bid (10)? no: 20 stays.
    expect(startBidOf(p, term(), group('gx', 'EXACT'), undefined)).toMatchObject({ cents: 20, why: expect.stringMatching(/observed cost per click/) })
    const pricey = term({ decision: decision({ tests: { ...((decision() as unknown as { tests: object }).tests), cpcCents: 150 } }) })
    expect(startBidOf(p, pricey, group('gx', 'EXACT'), undefined)).toMatchObject({ cents: 90, why: expect.stringMatching(/held inside the strategy/) })
    expect(startBidOf(p, term({ decision: null }), null, undefined)).toMatchObject({ refusal: expect.stringMatching(/set a bid/) })
  })
})

describe('refusals keep an item out, named (B5: never dropped)', () => {
  it('waiting, in progress, harvested, already a keyword of the product', () => {
    expect(plan(product(groups()), term(), { bidCents: 30 }, { waiting: true }).hold).toMatchObject({ label: 'Waiting for you' })
    expect(plan(product(groups()), term(), { bidCents: 30 }, { record: { status: 'WRITING', actorKind: 'PERSON' } }).hold).toMatchObject({ label: 'In progress' })
    // RULE — only what passes the one bar.
    const below = term({ decision: decision({ tests: { ...((decision() as unknown as { tests: Record<string, unknown> }).tests), harvest: { pass: false, by: 'brain', ordersNeeded: 2, clicksNeeded: 0, words: '' } } }) })
    expect(planItem({ req: { candidateId: 'x', bidCents: 30 }, actor: 'RULE', product: product(groups()), term: below, record: null, waiting: false, newCampaign: null, landing: none } as never).hold).toMatchObject({ label: 'Below the bar' })
    expect(plan(product(groups()), term(), { bidCents: 30 }, { record: { status: 'DONE', actorKind: 'BRAIN' } }).hold).toMatchObject({ label: 'Harvested' })
    const home = term({ decision: decision({ targets: [{ campaignId: 'c-gx', adGroupId: 'gx', targetId: 'k1', match: 'EXACT' }] }) })
    expect(plan(product(groups()), home, { bidCents: 30 }).hold).toMatchObject({ kind: 'home' })
    // …unless the person picks that very place (a paused copy there is enabled as the landing).
    expect(plan(product(groups()), home, { bidCents: 30, to: { adGroupId: 'gx' } }, { landing: () => ({ kind: 'enable', targetId: 'k1', externalTargetId: 'AMZ-K1', why: 'switch on' }) }).destination).toMatchObject({ status: 're-enable', existingTargetId: 'k1' })
    expect(plan(product(groups()), term({ isAsin: true, term: 'b0abcdefgh' }), { match: 'PHRASE', bidCents: 30 }).hold).toMatchObject({ label: 'ASIN: exact only' })
  })
})

describe('a new harvest campaign\'s name', () => {
  it('the SP Super Wizard\'s custom naming for the match, new in the market', () => {
    expect(harvestCampaignName('JACKET', 'EXACT', new Set())).toEqual({ name: 'JACKET-SP-Keyword-Exact-Harvest', adGroupName: 'JACKET-SP-Keyword-Exact-Harvest Ad Group' })
    expect(harvestCampaignName('JACKET', 'PHRASE', new Set(['jacket-sp-keyword-phrase-harvest'])).name).toBe('JACKET-SP-Keyword-Phrase-Harvest (2)')
  })
})
