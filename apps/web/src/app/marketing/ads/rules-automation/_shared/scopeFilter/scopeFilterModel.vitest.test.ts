import { describe, expect, it } from 'vitest'
import {
  NO_PICKS, addApiParams, apiParams, buildIndex, campaignsOf, carryQuery, carryTabs, idList, legacyPick, narrowRules, normalizePicks, picksActive,
  picksCount, picksKey, placeInReach, reachOf, readPicks, ruleInReach, scopeDimensions, withPicks,
  type ScopeOptionsAnswer, type ScopePicks, type ScopedRule,
} from './scopeFilterModel'

/**
 * Two markets. IT: portfolio Boots (c1 Boots Exact, c2 Boots Auto), portfolio Jackets (c3 Jacket Exact), c4 no portfolio,
 * c5 archived in Boots. DE: c9 in Boots DE. Ad groups g1/g2 in c1, g3 in c3, g9 in c9. Products: line L1 (Boots: c1, its
 * child K1 also in c2), line L2 (Jacket: c3), line L9 (DE only).
 */
const OPTIONS: ScopeOptionsAnswer = {
  campaigns: [
    { id: 'c1', name: 'Boots Exact', marketplace: 'IT', portfolioId: 'pBoots', status: 'ENABLED' },
    { id: 'c2', name: 'Boots Auto', marketplace: 'IT', portfolioId: 'pBoots', status: 'PAUSED' },
    { id: 'c3', name: 'Jacket Exact', marketplace: 'IT', portfolioId: 'pJackets', status: 'ENABLED' },
    { id: 'c4', name: 'Loose', marketplace: 'IT', portfolioId: null, status: 'ENABLED' },
    { id: 'c5', name: 'Old Boots', marketplace: 'IT', portfolioId: 'pBoots', status: 'ARCHIVED' },
    { id: 'c9', name: 'Stiefel', marketplace: 'DE', portfolioId: 'pBootsDe', status: 'ENABLED' },
  ],
  portfolios: [
    { externalPortfolioId: 'pBoots', name: 'Boots' },
    { externalPortfolioId: 'pJackets', name: 'Jackets' },
    { externalPortfolioId: 'pBootsDe', name: 'Boots DE' },
    { externalPortfolioId: 'pEmpty', name: 'Empty' },
  ],
  productLines: [
    { id: 'L1', sku: 'BOOT', name: 'Boot', variations: 1, campaigns: ['c1', 'c2'], children: [{ id: 'K1', sku: 'BOOT-42', name: 'Boot 42', campaigns: ['c2'] }] },
    { id: 'L2', sku: 'JKT', name: '', variations: 0, campaigns: ['c3'], children: [] },
    { id: 'L9', sku: 'DE', name: 'German', variations: 0, campaigns: ['c9'], children: [] },
  ],
  adGroups: [
    { id: 'g1', name: 'Exact', campaignId: 'c1', status: 'ENABLED' },
    { id: 'g2', name: 'Exact 2', campaignId: 'c1', status: 'ENABLED' },
    { id: 'g3', name: 'Exact', campaignId: 'c3', status: 'ENABLED' },
    { id: 'g9', name: 'Genau', campaignId: 'c9', status: 'ENABLED' },
    { id: 'gx', name: 'Gone', campaignId: 'c1', status: 'ARCHIVED' },
  ],
}
const IT = buildIndex(OPTIONS, 'IT')
const ALL = buildIndex(OPTIONS, 'all')
const picks = (p: Partial<Record<keyof ScopePicks, string[]>>): ScopePicks => ({ ...NO_PICKS, ...p })
const ids = (s: ReadonlySet<string>) => [...s].sort()

describe('the address', () => {
  it('reads comma lists: trimmed, each once, empty parts dropped, at most 500', () => {
    expect(idList(' a, b,,a ,')).toEqual(['a', 'b'])
    expect(idList(null)).toEqual([])
    expect(idList(Array.from({ length: 600 }, (_, i) => `x${i}`).join(','))).toHaveLength(500)
    expect(readPicks(new URLSearchParams('portfolio=p1,p2&campaign=c1&adGroup=&product=L1'))).toEqual({ portfolio: ['p1', 'p2'], campaign: ['c1'], adGroup: [], product: ['L1'] })
  })

  it("reads the Negative Targeting page's old ?scope= into its list", () => {
    expect(legacyPick('pf:p1')).toEqual({ key: 'portfolio', id: 'p1' })
    expect(legacyPick('ag:g1')).toEqual({ key: 'adGroup', id: 'g1' })
    expect(legacyPick('xx:1')).toBeNull()
    expect(readPicks(new URLSearchParams('scope=cp:c9&campaign=c1')).campaign).toEqual(['c1', 'c9'])
    expect(readPicks(new URLSearchParams('scope=cp:c1&campaign=c1')).campaign).toEqual(['c1'])
  })

  it('writes the four lists, drops the old scope and the cleared params, keeps the rest', () => {
    const qs = new URLSearchParams(withPicks('?market=IT&scope=pf:p&page=3&view=stopped', picks({ portfolio: ['p1', 'p2'], product: ['L1'] }), ['page']))
    expect(qs.get('portfolio')).toBe('p1,p2')
    expect(qs.get('product')).toBe('L1')
    expect(qs.has('campaign')).toBe(false)
    expect(qs.has('scope')).toBe(false)
    expect(qs.has('page')).toBe(false)
    expect(qs.get('market')).toBe('IT')
    expect(qs.get('view')).toBe('stopped')
    // One address change clears the picks and the view's own params together.
    const cleared = new URLSearchParams(withPicks('?campaign=c1&q=coat&kind=term', NO_PICKS, [], { q: null, kind: null }))
    expect(cleared.toString()).toBe('')
  })

  it('counts, keys and the server params', () => {
    const p = picks({ portfolio: ['p1'], adGroup: ['g1', 'g2'] })
    expect(picksActive(NO_PICKS)).toBe(false)
    expect(picksActive(p)).toBe(true)
    expect(picksCount(p)).toBe(2)
    expect(picksKey(p)).toBe('portfolio=p1&campaign=&adGroup=g1,g2&product=')
    expect(apiParams(p)).toEqual({ portfolioIds: 'p1', adGroupIds: 'g1,g2' })
    expect(addApiParams(new URLSearchParams('market=IT'), apiParams(p)).toString()).toBe('market=IT&portfolioIds=p1&adGroupIds=g1%2Cg2')
    expect(addApiParams(new URLSearchParams('a=1'), null).toString()).toBe('a=1')
  })

  it('the tabs carry only the four lists, only between the three pages', () => {
    const carry = carryQuery(new URLSearchParams('market=IT&campaign=c1,c2&view=bids&q=x'))
    expect(carry).toBe('campaign=c1%2Cc2')
    const items = [{ id: 'bid', href: '/r/bid' }, { id: 'budget', href: '/r/budget' }, { id: 'negative-targeting', href: '/r/neg' }, { id: 'keyword-harvest', href: '/r/kh?x=1' }]
    expect(carryTabs(items, 'bid', carry).map((t) => t.href)).toEqual(['/r/bid?campaign=c1%2Cc2', '/r/budget', '/r/neg?campaign=c1%2Cc2', '/r/kh?x=1&campaign=c1%2Cc2'])
    expect(carryTabs(items, 'budget', carry).map((t) => t.href)).toEqual(items.map((t) => t.href))
    expect(carryTabs(items, 'bid', '').map((t) => t.href)).toEqual(items.map((t) => t.href))
  })
})

describe('the lists of one market', () => {
  it('keeps only the market (all = every market), every state for links', () => {
    expect([...IT.campaigns.keys()].sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect([...IT.portfolios.keys()].sort()).toEqual(['pBoots', 'pJackets'])
    expect([...(IT.adGroups?.keys() ?? [])].sort()).toEqual(['g1', 'g2', 'g3', 'gx'])
    expect([...IT.products.keys()].sort()).toEqual(['K1', 'L1', 'L2'])
    expect(ids(IT.products.get('L1')!.campaigns)).toEqual(['c1', 'c2'])
    expect(IT.products.get('L1')!.family).toEqual(['L1', 'K1'])
    expect(ALL.campaigns.size).toBe(6)
  })

  it('an older answer without ad groups: no ad group list', () => {
    const { adGroups: _gone, ...older } = OPTIONS
    expect(buildIndex(older, 'IT').adGroups).toBeNull()
  })

  it('narrows the campaigns: OR inside a list, AND across lists', () => {
    expect(ids(campaignsOf(picks({ portfolio: ['pBoots', 'pJackets'] }), IT))).toEqual(['c1', 'c2', 'c3', 'c5'])
    expect(ids(campaignsOf(picks({ portfolio: ['pBoots'], product: ['L2'] }), IT))).toEqual([])
    expect(ids(campaignsOf(picks({ portfolio: ['pBoots'], product: ['K1'] }), IT))).toEqual(['c2'])
    expect(ids(campaignsOf(picks({ adGroup: ['g1', 'g3'] }), IT))).toEqual(['c1', 'c3'])
    expect(ids(campaignsOf(picks({ campaign: ['c1', 'c3'] }), IT, ['portfolio']))).toHaveLength(5)
  })
})

describe('a pick that no longer fits is dropped', () => {
  it('another market drops what is not in it', () => {
    expect(normalizePicks(picks({ portfolio: ['pBootsDe', 'pBoots'], campaign: ['c9'], adGroup: ['g9'], product: ['L9'] }), IT))
      .toEqual({ portfolio: ['pBoots'], campaign: [], adGroup: [], product: [] })
    expect(normalizePicks(picks({ portfolio: ['pBootsDe'], campaign: ['c9'], adGroup: ['g9'], product: ['L9'] }), ALL))
      .toEqual({ portfolio: ['pBootsDe'], campaign: ['c9'], adGroup: ['g9'], product: ['L9'] })
  })

  it('a campaign outside the picked portfolios goes; its ad groups with it', () => {
    expect(normalizePicks(picks({ portfolio: ['pJackets'], campaign: ['c1', 'c3'], adGroup: ['g1', 'g3'] }), IT))
      .toEqual({ portfolio: ['pJackets'], campaign: ['c3'], adGroup: ['g3'], product: [] })
    // No portfolio picked: every campaign of the market fits.
    expect(normalizePicks(picks({ campaign: ['c1', 'c4'] }), IT).campaign).toEqual(['c1', 'c4'])
  })

  it('a product the picks above do not advertise goes; an unknown id goes', () => {
    expect(normalizePicks(picks({ campaign: ['c3'], product: ['L1', 'L2'] }), IT).product).toEqual(['L2'])
    expect(normalizePicks(picks({ campaign: ['zz'], product: ['nope'] }), IT)).toEqual(NO_PICKS)
  })

  it('without the ad group list, ad group picks are kept for the server to check', () => {
    const { adGroups: _gone, ...older } = OPTIONS
    expect(normalizePicks(picks({ adGroup: ['g1', 'zz'] }), buildIndex(older, 'IT')).adGroup).toEqual(['g1', 'zz'])
  })
})

describe('the bar', () => {
  const dims = (p: ScopePicks) => Object.fromEntries(scopeDimensions(p, IT, 'ready').map((d) => [d.key, d]))
  const values = (d: { options: Array<{ value: string }> }) => d.options.map((o) => o.value)

  it('four lists in order, with their words and counts', () => {
    const d = scopeDimensions(NO_PICKS, IT, 'ready')
    expect(d.map((x) => x.label)).toEqual(['Portfolio', 'Campaign', 'Ad group', 'Product'])
    expect(d[0].options).toEqual([{ value: 'pBoots', label: 'Boots', count: 2, searchText: 'Boots' }, { value: 'pJackets', label: 'Jackets', count: 1, searchText: 'Jackets' }])
    // Live campaigns by name, each with its live ad groups; the archived one is not offered.
    expect(d[1].options.map((o) => [o.label, o.count])).toEqual([['Boots Auto', 0], ['Boots Exact', 2], ['Jacket Exact', 1], ['Loose', 0]])
    // An ad group is named with its campaign, and found by it.
    expect(d[2].options.map((o) => o.label)).toEqual(['Exact · Boots Exact', 'Exact 2 · Boots Exact', 'Exact · Jacket Exact'])
    expect(d[2].options[0].searchText).toBe('Exact · Boots Exact')
    // Products: lines only, named (else their SKU), counted by the campaigns that advertise them.
    expect(d[3].options).toEqual([{ value: 'L1', label: 'Boot', count: 2, searchText: 'Boot BOOT' }, { value: 'L2', label: 'JKT', count: 1, searchText: 'JKT JKT' }])
    expect(d.every((x) => x.heldReason === null && x.placeholder === 'All')).toBe(true)
  })

  it('each list narrows to the picks above it; a product narrows the campaigns and ad groups', () => {
    expect(values(dims(picks({ portfolio: ['pJackets'] })).campaign)).toEqual(['c3'])
    expect(values(dims(picks({ portfolio: ['pJackets'] })).adGroup)).toEqual(['g3'])
    expect(values(dims(picks({ campaign: ['c1'] })).adGroup)).toEqual(['g1', 'g2'])
    expect(values(dims(picks({ campaign: ['c3'] })).product)).toEqual(['L2'])
    expect(values(dims(picks({ product: ['L2'] })).campaign)).toEqual(['c3'])
    expect(values(dims(picks({ product: ['L2'] })).adGroup)).toEqual(['g3'])
    // The portfolios are not narrowed by what is below them.
    expect(values(dims(picks({ campaign: ['c3'] })).portfolio)).toEqual(['pBoots', 'pJackets'])
  })

  it('a pick never hides from its own list', () => {
    const d = dims(picks({ product: ['L2'], campaign: ['c1'] }))
    expect(values(d.campaign)).toEqual(['c1', 'c3'])
    expect(d.campaign.value).toEqual(['c1'])
    // A variation a link named shows by its name.
    expect(dims(picks({ product: ['K1'] })).product.options[0]).toEqual({ value: 'K1', label: 'Boot 42', searchText: 'Boot 42 BOOT-42' })
  })

  it('a list with nothing to offer is held, with why', () => {
    const d = dims(picks({ portfolio: ['pJackets'], campaign: ['c3'] }))
    expect(d.product.heldReason).toBeNull()
    const none = Object.fromEntries(scopeDimensions(NO_PICKS, buildIndex({ ...OPTIONS, adGroups: [] }, 'IT'), 'ready').map((x) => [x.key, x]))
    expect(none.adGroup.heldReason).toBe('No ad group fits the picks above')
    expect(Object.fromEntries(scopeDimensions(NO_PICKS, buildIndex(OPTIONS, 'FR'), 'ready').map((x) => [x.key, x])).portfolio.heldReason).toBe('No portfolio in this market')
  })

  it('while the lists are read (or failed): every list held, a link\'s picks shown by id', () => {
    const reading = scopeDimensions(picks({ campaign: ['c1'] }), null, 'reading')
    expect(reading.every((d) => d.heldReason === 'Reading the list')).toBe(true)
    expect(reading[1].options).toEqual([{ value: 'c1', label: 'c1' }])
    expect(scopeDimensions(NO_PICKS, null, 'failed', 'HTTP 500')[0].heldReason).toBe('Not read: HTTP 500')
  })
})

describe('what the picks reach (the views filtered here)', () => {
  const rule = (scope: Partial<ScopedRule['scope']>): ScopedRule => ({ scope: { all: false, product: null, portfolios: [], campaigns: [], adGroups: [], ...scope } })
  const ref = (id: string) => ({ id })

  it('nothing picked: every row stays', () => {
    expect(reachOf(NO_PICKS, IT)).toBeNull()
    expect(ruleInReach(rule({}), null)).toBe(true)
    expect(placeInReach({ campaign: ref('c1') }, null)).toBe(true)
  })

  it('a rule shows when one of its campaigns is reached; a whole-market rule always', () => {
    const reach = reachOf(picks({ portfolio: ['pJackets'] }), IT)
    expect(ids(reach!.campaigns)).toEqual(['c3'])
    expect(ruleInReach(rule({ campaigns: [ref('c3'), ref('c1')], portfolios: [ref('pJackets'), ref('pBoots')] }), reach)).toBe(true)
    // A campaign rule lists its campaign's portfolio: another campaign of that portfolio is not this rule's.
    expect(ruleInReach(rule({ campaigns: [ref('c1')], portfolios: [ref('pBoots')] }), reachOf(picks({ campaign: ['c2'] }), IT))).toBe(false)
    expect(ruleInReach(rule({ all: true, campaigns: [ref('c1')] }), reach)).toBe(true)
    // A product rule is judged by the campaigns it reaches.
    expect(ruleInReach(rule({ all: true, product: ref('L1'), campaigns: [ref('c1'), ref('c2')] }), reach)).toBe(false)
  })

  it('ad groups: a rule bound to ad groups needs a picked one; a whole-campaign rule needs the campaign of one', () => {
    const reach = reachOf(picks({ adGroup: ['g2'] }), IT)
    expect(ids(reach!.campaigns)).toEqual(['c1'])
    expect(ruleInReach(rule({ campaigns: [ref('c1')], adGroups: [ref('g1')] }), reach)).toBe(false)
    expect(ruleInReach(rule({ campaigns: [ref('c1')], adGroups: [ref('g1'), ref('g2')] }), reach)).toBe(true)
    expect(ruleInReach(rule({ campaigns: [ref('c1')] }), reach)).toBe(true)
    // The Negative Targeting rule's one ad group.
    expect(ruleInReach(rule({ campaigns: [ref('c1')], adGroup: ref('g2') }), reach)).toBe(true)
    // No ad group picked: an ad-group rule shows when its ad group sits in a reached campaign.
    expect(ruleInReach(rule({ campaigns: [ref('c1')], adGroups: [ref('g1')] }), reachOf(picks({ portfolio: ['pBoots'] }), IT))).toBe(true)
    expect(ruleInReach(rule({ campaigns: [ref('c1')], adGroups: [ref('g1')] }), reachOf(picks({ portfolio: ['pJackets'] }), IT))).toBe(false)
  })

  it('a list cut at 100 is judged by its portfolios, never hidden for a name it did not send', () => {
    const reach = reachOf(picks({ campaign: ['c2'] }), IT)
    const cut = rule({ campaigns: [ref('c1')], portfolios: [ref('pBoots')], counts: { campaigns: 150, portfolios: 1 } })
    expect(ruleInReach(cut, reach)).toBe(true)
    expect(ruleInReach({ scope: { ...cut.scope, portfolios: [ref('pJackets')] } }, reach)).toBe(false)
    expect(ruleInReach({ scope: { ...cut.scope, portfolios: [ref('pJackets')], counts: { campaigns: 150, portfolios: 120 } } }, reach)).toBe(true)
    // An ad group list cut at 100: its campaigns decide.
    expect(ruleInReach(rule({ campaigns: [ref('c2')], adGroups: [ref('g1')], counts: { adGroups: 140 } }), reach)).toBe(true)
  })

  it('a product: its family, and the campaigns that advertise it', () => {
    const reach = reachOf(picks({ product: ['L1'] }), IT)
    expect(ids(reach!.campaigns)).toEqual(['c1', 'c2'])
    expect(ids(reach!.products!)).toEqual(['K1', 'L1'])
    expect(placeInReach({ campaign: ref('c2'), product: ref('K1') }, reach)).toBe(true)
    expect(placeInReach({ campaign: ref('c2'), product: ref('L2') }, reach)).toBe(false)
    expect(placeInReach({ campaign: ref('c2'), product: null }, reach)).toBe(true)
    expect(placeInReach({ campaign: ref('c3') }, reach)).toBe(false)
  })

  it('a place: its campaign, then its ad group when ad groups are picked', () => {
    const reach = reachOf(picks({ adGroup: ['g1'] }), IT)
    expect(placeInReach({ campaign: ref('c1'), adGroup: ref('g1') }, reach)).toBe(true)
    expect(placeInReach({ campaign: ref('c1'), adGroup: ref('g2') }, reach)).toBe(false)
  })
})

describe('a rules answer narrowed', () => {
  type Row = ScopedRule & { id: string; archived: boolean; waiting: number; mode: { set: string } }
  const row = (id: string, campaigns: string[], over: Partial<Row> = {}): Row => ({
    id, archived: false, waiting: 0, mode: { set: 'WATCH' },
    scope: { all: false, product: null, portfolios: [], campaigns: campaigns.map((c) => ({ id: c })), adGroups: [] }, ...over,
  })
  const answer = {
    market: 'IT',
    rules: [
      row('brain', [], { waiting: 4 }),
      row('r1', ['c1'], { waiting: 2 }),
      row('r2', ['c3'], { mode: { set: 'OFF' } }),
      row('r3', ['c1'], { archived: true }),
      row('r4', ['c3'], { waiting: 1, mode: { set: 'AUTO' } }),
    ],
    totals: { rules: 3, on: 2, waiting: 3, archived: 1, otherMarkets: 5, clashes: 7 },
  }
  const brain = (r: Row) => r.id === 'brain'

  it('as read when nothing is picked', () => {
    expect(narrowRules(answer, null, brain)).toBe(answer)
  })

  it('keeps the always-shown rows and the rules that reach a pick; counts again over what shows', () => {
    const out = narrowRules(answer, reachOf(picks({ campaign: ['c1'] }), IT), brain)
    expect(out.rules.map((r) => r.id)).toEqual(['brain', 'r1', 'r3'])
    expect(out.totals).toEqual({ rules: 1, on: 1, waiting: 2, archived: 1, otherMarkets: 5, clashes: 7 })
    const jackets = narrowRules(answer, reachOf(picks({ portfolio: ['pJackets'] }), IT), brain)
    expect(jackets.rules.map((r) => r.id)).toEqual(['brain', 'r2', 'r4'])
    expect(jackets.totals).toMatchObject({ rules: 2, on: 1, waiting: 1, archived: 0 })
  })
})
