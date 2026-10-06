/**
 * ADS PLAYBOOK PB-6b — a product's harvest rule compiled from its playbook (harvest-rule.ts compileHarvestRule), pure. A
 * made-up full-funnel template (Auto; Broad, Phrase and Exact × Brand, Competitor, Category; PAT) with the default
 * harvest edges: Broad and Phrase of an intent → its Exact, Auto → the intent router, the research slots' ASINs → PAT.
 *
 *   sources        every linked slot; waste negatives in every keyword and Auto slot; ASINs in Auto and PAT
 *   destinations   the edge's slot, or the router over the product's own Brand / Competitor / Category Exact
 *   numbers        none of its own: the strategy's harvest and negate groups decide
 *   cadence        the phase (the strategy's goal) picks it; off keeps the rule off
 *   links          an edge to a slot with no campaign is left out (said); every ad group is one of this product's links
 *   problems       a slot graduating one match type to two slots, start bids that differ, an edge to a wrong-shaped slot
 *   handover       B (`proven`): never negated at the landing; A (`landed`): at the landing where the edges say so; an
 *                  edge with negateSource false: its source is never negated for a graduated term
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const { compileHarvestRule, HARVEST_HANDOVER } = await import('./harvest-rule.js')
const { DEFAULT_ISOLATION, defaultHarvest, defaultPhases } = await import('./defaults.js')
const { SLOT } = await import('./doc.js')
type Doc = import('./doc.js').TemplateDoc
type Input = Parameters<typeof compileHarvestRule>[0]

function fullFunnel(): Doc {
  const slots = [
    { key: 'auto', targeting: 'AUTO', intent: 'ANY', nameParts: ['Auto'] },
    ...['Brand', 'Competitor', 'Category'].flatMap((k) => ['Broad', 'Phrase', 'Exact'].map((m) => ({
      key: `${m}-${k}`.toLowerCase(), targeting: 'KEYWORD', match: m.toUpperCase(), intent: k.toUpperCase(), nameParts: [m, k],
    }))),
    { key: 'pat', targeting: 'PRODUCT', intent: 'ANY', nameParts: ['PAT'] },
  ].map((s) => SLOT.parse(s))
  const weights = Object.fromEntries(slots.map((s) => [s.key, 10]))
  return {
    structure: { naming: { pattern: '{product} | {market} | {parts}', partSeparator: ' | ' }, portfolio: { pattern: '{product}', mode: 'none' }, productAds: { fulfilment: 'FBA' }, sharedTerms: 'accept', slots },
    budget: { weights, minPerSlotCents: 100 },
    bids: { ladder: Object.fromEntries(slots.map((s) => [s.key, 1])), launch: 'floor' },
    placements: {},
    harvest: defaultHarvest(slots),
    isolation: { ...DEFAULT_ISOLATION },
    rank: { roles: {} },
    phases: defaultPhases(slots, weights),
  }
}

const doc = fullFunnel()
const KEYS = doc.structure.slots.map((s) => s.key)
const linksFor = (keys: readonly string[]) => new Map(keys.map((k) => [k, { campaignId: `c-${k}`, adGroupId: `g-${k}` }]))
const input = (over: Partial<Input> = {}): Input => ({
  playbookId: 'pb-test-1', market: 'IT', nameToken: 'TESTPB', doc,
  terms: { brand: ['testpb jacket'], category: [], competitor: ['rivalco'], competitorAsins: [], negatives: [] },
  links: linksFor(KEYS), phase: 'LAUNCH', handover: 'proven', ...over,
})
const sourceOf = (out: ReturnType<typeof compileHarvestRule>, key: string) => out.action.sources.find((s) => s.adGroupId === `g-${key}`)
const withEdges = (edges: Doc['harvest']['edges']): Doc => ({ ...doc, harvest: { edges } })

describe('PB-6b — compileHarvestRule', () => {
  it('every linked slot is a source; each graduates by its edges into its own intent\'s Exact; Auto goes through the router', () => {
    const out = compileHarvestRule(input())
    expect(out.problems).toEqual([])
    expect(out.action.sources.map((s) => s.adGroupId)).toEqual(KEYS.map((k) => `g-${k}`))
    expect(out.action.sources.every((s) => s.harvestFrom === true)).toBe(true)
    expect(sourceOf(out, 'broad-brand')).toEqual({
      adGroupId: 'g-broad-brand', campaignId: 'c-broad-brand', harvestFrom: true, graduate: ['EXACT'], negate: ['EXACT'],
      graduateProduct: true, negateProduct: false, negateOnLanding: false, negateSource: true, bid: { mode: 'cpc' },
      destinations: { EXACT: 'g-exact-brand', PRODUCT: 'g-pat' },
    })
    expect(sourceOf(out, 'phrase-competitor')!.destinations).toEqual({ EXACT: 'g-exact-competitor', PRODUCT: 'g-pat' })
    expect(sourceOf(out, 'broad-competitor')!.destinations.EXACT).toBe('g-exact-competitor')
    expect(sourceOf(out, 'phrase-category')!.destinations.EXACT).toBe('g-exact-category')
    expect(sourceOf(out, 'auto')).toMatchObject({
      graduate: ['EXACT'], negate: ['EXACT'], graduateProduct: true, negateProduct: true,
      destinations: {
        EXACT: { router: 'intent', BRAND: 'g-exact-brand', COMPETITOR: 'g-exact-competitor', CATEGORY: 'g-exact-category', brand: ['TESTPB', 'testpb jacket'], competitor: ['rivalco'] },
        PRODUCT: 'g-pat',
      },
    })
    // An Exact slot negates waste only; PAT negates wasteful ASINs only.
    expect(sourceOf(out, 'exact-brand')).toEqual({ adGroupId: 'g-exact-brand', campaignId: 'c-exact-brand', harvestFrom: true, graduate: [], negate: ['EXACT'], graduateProduct: false, negateProduct: false, negateOnLanding: false, negateSource: true, destinations: {} })
    expect(sourceOf(out, 'pat')).toMatchObject({ graduate: [], negate: [], graduateProduct: false, negateProduct: true, destinations: {} })
  })

  it('names no numbers of its own: the strategy\'s harvest and negate groups decide; propose-first, both halves, literal lists', () => {
    const { action } = compileHarvestRule(input())
    expect(action).toMatchObject({ type: 'harvest_and_negate', v: 2, control: 'manual', mode: 'both', playbookId: 'pb-test-1', market: 'IT' })
    for (const key of ['windowDays', 'minSpendCents', 'minOrders', 'graduationBidEur']) expect(action).not.toHaveProperty(key)
    expect(JSON.stringify(action)).not.toMatch(/minOrders|minClicks|maxAcos|minSpend|windowDays/)
  })

  it('every ad group and campaign it names is one of this product\'s links (never another product\'s, rule 3)', () => {
    const out = compileHarvestRule(input())
    const groups = new Set([...linksFor(KEYS).values()].map((l) => l.adGroupId))
    const named = [
      ...out.action.homeScope,
      ...out.action.sources.map((s) => s.adGroupId),
      ...out.action.sources.flatMap((s) => Object.values(s.destinations).flatMap((d) => (typeof d === 'string' ? [d] : [d!.BRAND, d!.COMPETITOR, d!.CATEGORY]))),
    ]
    expect(named.every((id) => groups.has(id))).toBe(true)
    expect(new Set(out.action.homeScope)).toEqual(groups)
    expect(out.action.sources.every((s) => s.campaignId === s.adGroupId.replace(/^g-/, 'c-'))).toBe(true)
  })

  it('the cadence follows the phase: daily → 1 day, weekly → 7, off keeps the rule off; no phase → none, said', () => {
    expect(compileHarvestRule(input({ phase: 'LAUNCH' }))).toMatchObject({ enabled: true, cadenceDays: 1, action: { cadenceDays: 1 } })
    expect(compileHarvestRule(input({ phase: 'PROFIT' }))).toMatchObject({ enabled: true, cadenceDays: 7, action: { cadenceDays: 7 } })
    const off = compileHarvestRule(input({ phase: 'CLEAR_STOCK' }))
    expect(off).toMatchObject({ enabled: false, cadenceDays: null })
    expect(off.warnings.join('\n')).toMatch(/CLEAR_STOCK phase turns the harvest off/)
    const none = compileHarvestRule(input({ phase: null }))
    expect(none).toMatchObject({ enabled: true, cadenceDays: null })
    expect(none.warnings.join('\n')).toMatch(/sets no goal \(phase\)/)
  })

  it('an edge to a slot with no campaign yet is left out, said; a source slot with none is no source', () => {
    const out = compileHarvestRule(input({ links: linksFor(KEYS.filter((k) => k !== 'exact-competitor' && k !== 'phrase-brand')) }))
    expect(out.problems).toEqual([])
    expect(out.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/the slot "exact-competitor" has no campaign yet; this edge is left out/),
      expect.stringMatching(/The slot "phrase-brand" has no campaign yet: it is no source/),
    ]))
    // The router needs all three: Auto graduates no exact keyword until the Competitor slot is there; it keeps its ASINs.
    expect(sourceOf(out, 'auto')).toMatchObject({ graduate: [], destinations: { PRODUCT: 'g-pat' } })
    expect(sourceOf(out, 'broad-competitor')).toMatchObject({ graduate: [], negate: ['EXACT'], destinations: { PRODUCT: 'g-pat' } })
    expect(sourceOf(out, 'phrase-brand')).toBeUndefined()
    expect(out.action.homeScope).not.toContain('g-exact-competitor')
  })

  it('problems: one match type to two slots, start bids that differ, an edge to a wrong-shaped slot, an ASIN to the router', () => {
    const edges = doc.harvest.edges
    const twice = compileHarvestRule(input({ doc: withEdges([...edges, { from: ['broad-brand'], to: 'exact-category', what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true }]) }))
    expect(twice.problems).toEqual([expect.stringMatching(/"broad-brand" graduates exact keywords by two harvest edges to different slots/)])
    const bids = compileHarvestRule(input({ doc: withEdges(edges.map((e) => (e.what === 'ASIN_PRODUCT' ? { ...e, startBid: { mode: 'destDefault' as const } } : e))) }))
    expect(bids.problems).toEqual(expect.arrayContaining([expect.stringMatching(/"broad-brand" graduates by harvest edges with different start bids/)]))
    const shape = compileHarvestRule(input({ doc: withEdges([{ from: ['broad-brand'], to: 'phrase-brand', what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true }]) }))
    expect(shape.problems).toEqual([expect.stringMatching(/goes to the slot "phrase-brand", which is not an exact keyword slot/)])
    const asin = compileHarvestRule(input({ doc: withEdges([{ from: ['auto'], to: { router: 'intent', brand: 'pat', competitor: 'pat', category: 'pat' }, what: 'ASIN_PRODUCT', startBid: { mode: 'cpc' }, negateSource: true }]) }))
    expect(asin.problems).toEqual([expect.stringMatching(/never through the intent router/)])
    const nothing = compileHarvestRule(input({ links: new Map() }))
    expect(nothing.problems).toEqual(expect.arrayContaining([expect.stringMatching(/holds none of its playbook's slots/)]))
  })

  it('the start bid in the harvest wire\'s modes: CPC + a percent, the destination\'s default, a fixed bid in major units', () => {
    const one = (startBid: Doc['harvest']['edges'][number]['startBid']) =>
      sourceOf(compileHarvestRule(input({ doc: withEdges([{ from: ['broad-brand'], to: 'exact-brand', what: 'KEYWORD_EXACT', startBid, negateSource: true }]) })), 'broad-brand')!.bid
    expect(one({ mode: 'cpcPlusPct', value: 20 })).toEqual({ mode: 'cpcPlus', value: 20 })
    expect(one({ mode: 'destDefault' })).toEqual({ mode: 'adGroupDefault' })
    expect(one({ mode: 'fixedCents', value: 45 })).toEqual({ mode: 'fixed', value: 0.45 })
    expect(compileHarvestRule(input({ doc: withEdges([{ from: ['broad-brand'], to: 'exact-brand', what: 'KEYWORD_EXACT', startBid: { mode: 'fixedCents' }, negateSource: true }]) })).problems)
      .toEqual([expect.stringMatching(/fixed start bid that names no amount/)])
  })

  it('handover: B (the Owner\'s choice) never negates at the landing; A does where every edge of the source says so; negateSource false binds the source', () => {
    expect(HARVEST_HANDOVER).toBe('proven')
    expect(compileHarvestRule(input()).action.sources.every((s) => s.negateOnLanding === false)).toBe(true)
    const landed = compileHarvestRule(input({ handover: 'landed' }))
    expect(sourceOf(landed, 'broad-brand')!.negateOnLanding).toBe(true)
    expect(sourceOf(landed, 'exact-brand')!.negateOnLanding).toBe(false) // no edge: nothing lands from it
    const keep = withEdges(doc.harvest.edges.map((e) => (e.to === 'exact-brand' ? { ...e, negateSource: false } : e)))
    // One edge of broad-brand says not to negate it (its ASIN edge says yes): the source is never closed, under A or B.
    expect(sourceOf(compileHarvestRule(input({ doc: keep, handover: 'landed' })), 'broad-brand')).toMatchObject({ negateOnLanding: false, negateSource: false })
    const kept = compileHarvestRule(input({ doc: keep }))
    expect(sourceOf(kept, 'broad-brand')).toMatchObject({ negateOnLanding: false, negateSource: false })
    expect(sourceOf(kept, 'broad-category')!.negateSource).toBe(true)
    expect(kept.warnings.join('\n')).not.toMatch(/negate the source/)
  })
})
