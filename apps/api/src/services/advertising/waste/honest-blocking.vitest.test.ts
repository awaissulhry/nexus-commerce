/**
 * HONEST 5–9 (2026-10-27) — blocking and verbs on the Negative Targeting page, from hand-made facts (no database):
 *
 *   5  a clash is a negative that blocks EVERY search our keyword can serve; the Owner's funnel (a negative exact over our
 *      phrase or broad keyword, a negative phrase over our broad one) is never a clash, never offered for removal
 *   6  "blocks" means blocks NOW: a negative switched off, or one Amazon never took, blocks nothing
 *   7  a term's negative goes campaign-wide only when no other ad group of the campaign sold it or holds our keyword of it
 *   8  the hold on a pause or a negative, read again on the server (stopHold), whatever the client sends
 *   9  a term whose every buying keyword is paused is not running: PAUSED, not wasting, out of the Wasting tile
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { dayIndex, isFunnelNegative, isWasting, negativeClashesWith, termKeyOf, totalsOf, type Match, type WasteRow } from './pure.js'
import { buildWasteRows, servingPlaces, stopHold, type TargetFact, type WasteFacts } from './read.js'
import { placeTerms } from './reach.js'
import { verbFor } from './verb.js'
import { buildWords } from './words.js'

const NOW = new Date('2026-10-20T12:00:00Z')
const DAY = 86_400_000
const OLD = dayIndex(NOW) - 200

// ── A made-up market: campaigns, ad groups, our keywords, negatives and search terms ─────────────────────────────

interface Camp { id: string; live?: boolean; product?: string | null }
interface Group { id: string; campaignId: string; live?: boolean; firstDay?: number | null }
type Target = Partial<TargetFact> & { id: string; adGroupId: string; expressionValue: string }

const kw = (id: string, adGroupId: string, text: string, match: 'EXACT' | 'PHRASE' | 'BROAD', extra: Partial<TargetFact> = {}): Target =>
  ({ id, adGroupId, kind: 'KEYWORD', expressionType: match, expressionValue: text, status: 'ENABLED', isNegative: false, negativeLevel: null, externalTargetId: `X-${id}`, ...extra })
const asinTarget = (id: string, adGroupId: string, asin: string): Target =>
  ({ id, adGroupId, kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: asin, status: 'ENABLED', isNegative: false, negativeLevel: null, externalTargetId: `X-${id}` })
const neg = (id: string, adGroupId: string, text: string, match: 'EXACT' | 'PHRASE' | 'ASIN', extra: Partial<TargetFact> = {}): Target => ({
  id, adGroupId, kind: match === 'ASIN' ? 'PRODUCT' : 'KEYWORD', expressionType: match === 'ASIN' ? 'ASIN_SAME_AS' : `NEGATIVE_${match}`, expressionValue: text,
  status: 'ENABLED', isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `X-${id}`, ...extra,
})

const sums = (clicks: number, spendCents: number, orders: number) => ({ impressions: clicks * 20, clicks, spendCents, orders, salesCents: orders * 4000 })
interface Term { adGroupId: string; text: string; via?: string[] | null; clicks?: number; spendCents?: number; orders?: number; orders90?: number; unknownVia?: boolean }

function factsOf(a: { campaigns: Camp[]; groups: Group[]; targets: Target[]; terms?: Term[]; harvested?: Record<string, number>; protections?: string[] }): WasteFacts {
  const campaigns = new Map(a.campaigns.map((c) => [c.id, { id: c.id, name: `Made up ${c.id}`, market: 'IT', status: c.live === false ? 'PAUSED' : 'ENABLED', portfolioId: null, externalCampaignId: `XC-${c.id}`, dailyBudgetCurrency: 'EUR', live: c.live !== false }]))
  const adGroups = new Map(a.groups.map((g) => [g.id, { id: g.id, name: `group ${g.id}`, campaignId: g.campaignId, externalAdGroupId: `XG-${g.id}`, status: 'ENABLED', live: g.live !== false && campaigns.get(g.campaignId)!.live, productIds: ['p1'], firstDay: g.firstDay === undefined ? OLD : g.firstDay }]))
  const targets: TargetFact[] = a.targets.map((t) => ({ kind: 'KEYWORD', expressionType: 'EXACT', status: 'ENABLED', isNegative: false, negativeLevel: null, externalTargetId: null, createdAt: NOW, retiredAt: null, ...t }) as TargetFact)
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v])
  const positivesByGroup = new Map<string, TargetFact[]>()
  const negByGroup = new Map<string, TargetFact[]>()
  const negByCampaign = new Map<string, TargetFact[]>()
  const targetByExt = new Map<string, TargetFact[]>()
  for (const t of targets) {
    if (t.externalTargetId) push(targetByExt, t.externalTargetId, t)
    if (!t.isNegative) push(positivesByGroup, t.adGroupId, t)
    else if (t.negativeLevel === 'CAMPAIGN') push(negByCampaign, adGroups.get(t.adGroupId)!.campaignId, t)
    else push(negByGroup, t.adGroupId, t)
  }
  const termPlaces = new Map<string, any>()
  const placesByKey = new Map<string, any[]>()
  const placesByGroup = new Map<string, any[]>()
  const placesByCampaign = new Map<string, any[]>()
  for (const t of a.terms ?? []) {
    const clicks = t.clicks ?? 40, spend = t.spendCents ?? 4000, orders = t.orders ?? 0
    const campaignId = adGroups.get(t.adGroupId)!.campaignId
    const s = sums(clicks, spend, orders)
    const vias = new Map((t.via ?? []).map((id) => [`X-${id}`, { clicks, orders, win60: s, d90: { clicks, orders, spendCents: spend }, spark: new Array(8).fill(0) }]))
    const p = {
      adGroupId: t.adGroupId, campaignId, key: termKeyOf(t.text), text: t.text, matchType: 'BROAD', clicks93: clicks, clicksDefault: clicks, servedDefault: clicks * 21,
      win: { 30: s, 60: s, 90: sums(clicks, spend, t.orders90 ?? orders) }, d90: { clicks, orders: t.orders90 ?? orders, spendCents: spend }, spark: new Array(8).fill(0), vias,
      // The last day it spent (HONEST 18b reads "still serves" by spend): within the window.
      lastSpendDay: dayIndex(NOW) - 10,
      ...(t.unknownVia ? { unknownVia: true } : {}),
    }
    termPlaces.set(`${t.adGroupId}|${p.key}`, p)
    push(placesByKey, p.key, p); push(placesByGroup, p.adGroupId, p); push(placesByCampaign, campaignId, p)
  }
  const facts = { cr: 0.1, targetCpaCents: 1000, targetSource: 'made up' }
  return {
    now: NOW, markets: ['IT'], focus: null, campaigns, adGroups, adGroupOfExt: new Map(),
    ownership: new Map(a.campaigns.map((c) => [c.id, c.product === null ? { owner: { kind: 'shared' }, productIds: ['p1', 'p2'], unresolved: [] } : { owner: { kind: 'product', productId: 'p1' }, productIds: ['p1'], unresolved: [] }])),
    products: new Map([['p1', { id: 'p1', name: 'MADE-UP' }]]), portfolioNames: new Map(),
    targets, positivesByGroup, negByGroup, negByCampaign, targetByExt, targetById: new Map(targets.map((t) => [t.id, t])),
    termPlaces, placesByKey, placesByGroup, placesByCampaign, keywords: new Map(), negativeSpendBefore: new Map(), stock: new Map(),
    productFacts: new Map([['IT|p1', facts]]), marketFacts: new Map([['IT', facts]]), negateBar: new Map(), marketNegateBar: new Map([['IT', null]]),
    protections: (a.protections ?? []).map((term, i) => ({ id: `pr${i}`, term, isPrefix: false, matchType: 'EXACT', reason: null, marketplace: null, market: null, campaignId: null })),
    followUps: [], brainProducts: new Set(), rules: [], ruleProductScope: new Map(), ruleAssigned: new Map(), stateChanges: new Map(), lastPause: new Map(),
    negativeCreates: new Map(), retires: [], brainReasons: new Map(), harvestSources: new Set(),
    harvestedAt: new Map(Object.entries(a.harvested ?? {}).map(([k, daysAgo]) => [k, NOW.getTime() - daysAgo * DAY])),
    waitingKw: new Map(), waitingTerm: [], waitItems: [], negativeAdded: new Map(), holds: new Map(), origins: new Map(), skips: new Map(),
    names: { rules: new Map(), claudeChangeSets: new Set(), people: new Map() }, currencyOf: new Map(),
    freshness: { searchTermsThrough: null, keywordsThrough: null, readAt: NOW.toISOString() },
  } as unknown as WasteFacts
}

const rowsOf = (f: WasteFacts) => new Map(buildWasteRows(f, {}).map((r) => [r.id, r]))
const termId = (adGroupId: string, text: string) => `term:IT|XG-${adGroupId}|${termKeyOf(text)}`

// ── 5 — a clash blocks every search our keyword can serve ────────────────────────────────────────────────────────

describe('HONEST 5 — negativeClashesWith: every match type', () => {
  const clash = (match: Match, n: 'EXACT' | 'PHRASE' | 'ASIN', text = 'rain jacket', ours = 'rain jacket') => negativeClashesWith({ text: ours, match }, { text, match: n })
  it('our EXACT keyword: a negative exact of its words, or a negative phrase its words hold, blocks its only search', () => {
    expect(clash('EXACT', 'EXACT')).toBe(true)
    expect(clash('EXACT', 'PHRASE')).toBe(true)
    expect(clash('EXACT', 'PHRASE', 'jacket')).toBe(true)
    expect(clash('EXACT', 'EXACT', 'jacket')).toBe(false)
    expect(clash('EXACT', 'PHRASE', 'rain coat')).toBe(false)
    expect(clash('EXACT', 'PHRASE', 'jacket rain')).toBe(false)
  })
  it('our PHRASE keyword: only a negative phrase its words hold; a negative exact of its words is the funnel', () => {
    expect(clash('PHRASE', 'PHRASE')).toBe(true)
    expect(clash('PHRASE', 'PHRASE', 'jacket')).toBe(true)
    expect(clash('PHRASE', 'EXACT')).toBe(false)
    expect(clash('PHRASE', 'PHRASE', 'rain jacket blue')).toBe(false)
  })
  it('our BROAD keyword: never (a negative exact or phrase of its words blocks only some of its searches)', () => {
    expect(clash('BROAD', 'EXACT')).toBe(false)
    expect(clash('BROAD', 'PHRASE')).toBe(false)
    expect(clash('BROAD', 'PHRASE', 'jacket')).toBe(false)
  })
  it('a product target: a negative product of the same ASIN only; a keyword is never blocked by a negative product', () => {
    expect(negativeClashesWith({ text: 'B0MADEUP01', match: 'ASIN' }, { text: 'b0madeup01', match: 'ASIN' })).toBe(true)
    expect(negativeClashesWith({ text: 'B0MADEUP01', match: 'ASIN' }, { text: 'B0MADEUP02', match: 'ASIN' })).toBe(false)
    expect(negativeClashesWith({ text: 'B0MADEUP01', match: 'ASIN' }, { text: 'B0MADEUP01', match: 'EXACT' })).toBe(false)
    expect(negativeClashesWith({ text: 'b0madeup01', match: 'EXACT' }, { text: 'B0MADEUP01', match: 'ASIN' })).toBe(false)
    expect(clash('AUTO', 'EXACT')).toBe(false)
    expect(clash('CATEGORY', 'PHRASE')).toBe(false)
  })
  it('isFunnelNegative: our own words, narrower than our keyword', () => {
    const funnel = (match: Match, n: 'EXACT' | 'PHRASE', text = 'rain jacket') => isFunnelNegative({ text: 'Rain  Jacket', match }, { text, match: n })
    expect([funnel('PHRASE', 'EXACT'), funnel('BROAD', 'EXACT'), funnel('BROAD', 'PHRASE')]).toEqual([true, true, true])
    expect([funnel('EXACT', 'EXACT'), funnel('PHRASE', 'PHRASE'), funnel('BROAD', 'EXACT', 'jacket')]).toEqual([false, false, false])
  })
})

describe('HONEST 5 — Harvest\'s source negative is never "Blocks a term that sold here" (the Owner\'s pick A, 2026-10-27)', () => {
  // A term that sold, then Harvest made it a keyword and negated it at its source: on purpose. Another negative of the same
  // kind over a term that sold stays a clash.
  const f = factsOf({
    campaigns: [{ id: 'c1' }],
    groups: [{ id: 'ga', campaignId: 'c1' }],
    targets: [kw('kb', 'ga', 'boots', 'BROAD'), neg('nh', 'ga', 'boots women', 'EXACT'), neg('nx', 'ga', 'boots men', 'EXACT')],
    terms: [
      { adGroupId: 'ga', text: 'boots women', via: ['kb'], orders: 2 },
      { adGroupId: 'ga', text: 'boots men', via: ['kb'], orders: 1 },
    ],
  })
  ;(f.harvestSources as Set<string>).add('nh')
  const rows = rowsOf(f)
  it('Harvest\'s negative: blocked, no clash', () => {
    expect(rows.get(termId('ga', 'boots women'))).toMatchObject({ state: 'NEGATED', clash: null })
  })
  it('anyone else\'s negative over a term that sold: still a clash', () => {
    expect(rows.get(termId('ga', 'boots men'))).toMatchObject({ state: 'NEGATED', clash: { kind: 'BLOCKS_SOLD' } })
  })
})

describe('HONEST 5 — the Owner\'s funnel is never a clash, nor offered for removal; a real clash still is', () => {
  // The funnel (saved rule 2026-10-09): "rain jacket" in exact, phrase and broad; the phrase ad group holds a negative
  // exact, the broad one a negative exact and a negative phrase. Both of the phrase and broad terms sold before it.
  const f = factsOf({
    campaigns: [{ id: 'c1' }],
    groups: [{ id: 'gx', campaignId: 'c1' }, { id: 'gp', campaignId: 'c1' }, { id: 'gb', campaignId: 'c1' }, { id: 'gc', campaignId: 'c1' }, { id: 'gt', campaignId: 'c1' }],
    targets: [
      kw('kx', 'gx', 'rain jacket', 'EXACT'), kw('kp', 'gp', 'rain jacket', 'PHRASE'), kw('kb', 'gb', 'rain jacket', 'BROAD'),
      neg('np', 'gp', 'rain jacket', 'EXACT'), neg('nbx', 'gb', 'rain jacket', 'EXACT'), neg('nbp', 'gb', 'rain jacket', 'PHRASE'),
      // Real clashes: over our exact keyword (exact, and a phrase its words hold), over our phrase keyword, over a product target.
      kw('ks', 'gc', 'storm jacket', 'EXACT'), neg('ns', 'gc', 'storm jacket', 'EXACT'),
      kw('kw2', 'gc', 'wind coat', 'EXACT'), neg('nw', 'gc', 'coat', 'PHRASE'),
      kw('kph', 'gc', 'snow jacket', 'PHRASE'), neg('nph', 'gc', 'snow jacket', 'PHRASE'),
      asinTarget('ka', 'gt', 'B0MADEUP01'), neg('na', 'gt', 'B0MADEUP01', 'ASIN'),
      // A campaign negative: exact over our exact keyword in another ad group (a clash), exact over our phrase one (the funnel).
      kw('kc', 'gt', 'hail jacket', 'EXACT'), kw('kcp', 'gt', 'sleet jacket', 'PHRASE'),
      neg('ncx', 'gx', 'hail jacket', 'EXACT', { negativeLevel: 'CAMPAIGN' }), neg('ncp', 'gx', 'sleet jacket', 'EXACT', { negativeLevel: 'CAMPAIGN' }),
      // A negative that blocks a term which sold here, not the funnel's.
      neg('nm', 'gb', 'rain jacket men', 'EXACT'),
    ],
    terms: [
      { adGroupId: 'gp', text: 'rain jacket', via: ['kp'], orders: 2 },
      { adGroupId: 'gb', text: 'rain jacket blue', via: ['kb'], orders: 1 },
      { adGroupId: 'gb', text: 'rain jacket men', via: ['kb'], orders: 1 },
    ],
  })
  const rows = rowsOf(f)

  it('no funnel negative makes a clash; our phrase and broad keywords keep their own verb (no Remove)', () => {
    for (const id of ['kw:kp', 'kw:kb', 'kw:kcp']) {
      expect(rows.get(id)!.clash, id).toBeNull()
      expect(rows.get(id)!.verb.action, id).toBe('PAUSE')
    }
  })
  it('a term the funnel blocks that sold here is NEGATED, never "Blocks a term that sold here"', () => {
    expect(rows.get(termId('gp', 'rain jacket'))).toMatchObject({ state: 'NEGATED', clash: null })
    expect(rows.get(termId('gb', 'rain jacket blue'))).toMatchObject({ state: 'NEGATED', clash: null })
    // Another negative that blocks a term which sold here stays a clash.
    expect(rows.get(termId('gb', 'rain jacket men'))).toMatchObject({ state: 'NEGATED', clash: { kind: 'BLOCKS_SOLD' } })
  })
  it('a negative that blocks every search of ours is a clash, its fix Remove (it does not waste)', () => {
    const own = (id: string, negId: string, level = 'AD_GROUP') => {
      const r = rows.get(id)!
      expect(r.clash, id).toMatchObject({ kind: 'NEG_OVER_OWN_KEYWORD', negative: { rowId: `neg:${negId}`, level } })
      expect(r.verb, id).toMatchObject({ action: 'REMOVE_NEGATIVE', targetRowId: `neg:${negId}` })
    }
    own('kw:ks', 'ns')
    own('kw:kw2', 'nw')
    own('kw:kph', 'nph')
    own('kw:ka', 'na')
    own('kw:kc', 'ncx', 'CAMPAIGN')
  })
  it('the Clashes tile counts exactly those', () => {
    const list = [...rows.values()]
    expect(list.filter((r) => r.clash).map((r) => r.id).sort()).toEqual(['kw:ka', 'kw:kc', 'kw:kph', 'kw:ks', 'kw:kw2', termId('gb', 'rain jacket men')].sort())
    expect(totalsOf(list, 'all', { negated: 0 }).clashes).toBe(6)
  })
})

// ── 6 — blocks NOW ──────────────────────────────────────────────────────────────────────────────────────────────

describe('HONEST 6 — a negative switched off, or never taken by Amazon, blocks nothing', () => {
  const f = factsOf({
    campaigns: [{ id: 'c1' }],
    groups: [{ id: 'g1', campaignId: 'c1' }, { id: 'g2', campaignId: 'c1' }],
    targets: [
      kw('k1', 'g1', 'made up boots', 'EXACT'), neg('n-off', 'g1', 'made up boots', 'EXACT', { status: 'PAUSED' }),
      kw('k2', 'g1', 'made up socks', 'EXACT'), neg('n-never', 'g1', 'made up socks', 'PHRASE', { externalTargetId: null }),
      kw('k3', 'g1', 'made up hats', 'EXACT'), neg('n-on', 'g1', 'made up hats', 'EXACT'),
      kw('kb1', 'g1', 'made up', 'BROAD'), kw('kb2', 'g2', 'made up', 'BROAD'),
      neg('n-never2', 'g2', 'made up cheap', 'EXACT', { externalTargetId: null }),
      neg('n-cheap', 'g1', 'cheap', 'PHRASE', { externalTargetId: null }),
    ],
    terms: [
      { adGroupId: 'g2', text: 'made up cheap', via: ['kb2'], orders: 1 },
      { adGroupId: 'g1', text: 'made up cheap', via: ['kb1'] },
      { adGroupId: 'g1', text: 'cheap made up gloves', via: ['kb1'] },
      { adGroupId: 'g1', text: 'cheap made up scarf', via: ['kb1'] },
    ],
  })
  const rows = rowsOf(f)

  it('no clash from a negative that does not block now; one that does is', () => {
    expect(rows.get('kw:k1')!.clash).toBeNull()
    expect(rows.get('kw:k2')!.clash).toBeNull()
    expect(rows.get('kw:k3')!.clash).toMatchObject({ kind: 'NEG_OVER_OWN_KEYWORD', negative: { rowId: 'neg:n-on' } })
  })
  it('a term blocked only by a negative Amazon never took is RUNNING (no "Blocks a term that sold"), and it still serves there', () => {
    expect(rows.get(termId('g2', 'made up cheap'))).toMatchObject({ state: 'RUNNING', clash: null })
    expect(servingPlaces(f, 'made up cheap', 'g1')).toEqual(['g2'])
    expect(rows.get(termId('g1', 'made up cheap'))!.stillServesIn).toBe(1)
  })
  it('the reach check counts a term such a negative "blocks" (it changes something)', () => {
    const t = placeTerms(f, { campaignId: 'c1', adGroupId: 'g2', level: 'AD_GROUP', text: 'made up cheap', match: 'EXACT' }, 60)
    expect(t.find((x) => x.key === 'made up cheap')!.blocked).toBe(false)
  })
  it('the Words view: a negative phrase Amazon never took does not make a place BLOCKED', () => {
    const cheap = buildWords(f, {}).find((b) => b.row.word === 'cheap')
    expect(cheap).toBeDefined()
    expect(cheap!.places.find((p) => p.adGroupId === 'g1')!.state).not.toBe('BLOCKED')
    expect(cheap!.places.find((p) => p.adGroupId === 'g1')!.blockedBy).toBeNull()
  })
})

// ── 7 — the whole campaign ──────────────────────────────────────────────────────────────────────────────────────

describe('HONEST 7 — campaign-wide only when no other ad group sold it or holds our keyword of it', () => {
  it('verbFor: 2+ ad groups → the campaign; a sale or our keyword in another → this ad group', () => {
    const term = { kind: 'TERM' as const, match: 'BROAD' as const, text: 'made up kids', adGroupsInCampaign: 2 }
    expect(verbFor(term).where).toBe('campaign')
    expect(verbFor({ ...term, soldInSibling: true }).where).toBe('adGroup')
    expect(verbFor({ ...term, ownKeywordInSibling: true }).where).toBe('adGroup')
  })
  it('from the facts: a sale (in the 90 days Nexus keeps) or our keyword in a sibling, paused ones too, keeps it in its ad group', () => {
    const base = { groups: [{ id: 'g1', campaignId: 'c1' }, { id: 'g2', campaignId: 'c1' }, { id: 'g3', campaignId: 'c1', live: false }], campaigns: [{ id: 'c1' }] }
    const kws = [kw('kb1', 'g1', 'made up', 'BROAD'), kw('kb2', 'g2', 'made up', 'BROAD')]
    const wide = rowsOf(factsOf({ ...base, targets: kws, terms: [{ adGroupId: 'g1', text: 'made up kids', via: ['kb1'] }, { adGroupId: 'g2', text: 'made up kids', via: ['kb2'] }] }))
    expect(wide.get(termId('g1', 'made up kids'))!.verb).toMatchObject({ action: 'NEGATE_EXACT', where: 'campaign' })
    // It sold in g2, outside the 60-day window but inside the 90 days.
    const sold = rowsOf(factsOf({ ...base, targets: kws, terms: [{ adGroupId: 'g1', text: 'made up kids', via: ['kb1'] }, { adGroupId: 'g2', text: 'made up kids', via: ['kb2'], orders90: 1 }] }))
    expect(sold.get(termId('g1', 'made up kids'))!.verb).toMatchObject({ action: 'NEGATE_EXACT', where: 'adGroup' })
    // Our phrase keyword of those words in g3 (a paused ad group: a campaign negative lands there too).
    const own = rowsOf(factsOf({ ...base, targets: [...kws, kw('kp3', 'g3', 'made up kids', 'PHRASE')], terms: [{ adGroupId: 'g1', text: 'made up kids', via: ['kb1'] }, { adGroupId: 'g2', text: 'made up kids', via: ['kb2'] }] }))
    expect(own.get(termId('g1', 'made up kids'))!.verb).toMatchObject({ action: 'NEGATE_EXACT', where: 'adGroup' })
  })
})

// ── 8 — the hold, read again on the server ──────────────────────────────────────────────────────────────────────

describe('HONEST 8 — stopHold: the row\'s own hold, for a pause and for a negative', () => {
  const f = factsOf({
    campaigns: [{ id: 'c1' }, { id: 'cs', product: null }],
    groups: [{ id: 'g1', campaignId: 'c1' }, { id: 'gn', campaignId: 'c1', firstDay: dayIndex(NOW) - 5 }, { id: 'gs', campaignId: 'cs' }],
    targets: [
      kw('k-ok', 'g1', 'made up boots', 'EXACT'), kw('k-new', 'gn', 'made up gloves', 'EXACT'), kw('k-shared', 'gs', 'made up socks', 'EXACT'),
      kw('k-harv', 'g1', 'made up hats', 'EXACT'), kw('k-sells', 'g1', 'made up', 'BROAD'), kw('k-prot', 'g1', 'made up brand', 'EXACT'),
      kw('k-own', 'g1', 'made up scarf', 'PHRASE'),
    ],
    terms: [{ adGroupId: 'g1', text: 'made up coats', via: ['k-sells'], orders: 3 }],
    harvested: { 'made up hats': 10, 'made up belts': 3 },
    protections: ['made up brand'],
  })
  const pause = (targetId: string, protectedToo = true) => stopHold(f, { kind: 'pause', targetId }, { protectedToo })?.label ?? null
  const negate = (adGroupId: string, text: string) => stopHold(f, { kind: 'negate', adGroupId, text }, { protectedToo: false })?.label ?? null

  it('a pause: none, a new place, a shared campaign, harvested lately, its terms sell, protected (unless the review removes it)', () => {
    expect(pause('k-ok')).toBeNull()
    expect(pause('k-new')).toBe('New place')
    expect(pause('k-shared')).toBe('Shared campaign')
    expect(pause('k-harv')).toBe('Harvested lately')
    expect(pause('k-sells')).toBe('Its terms sell')
    expect(pause('k-prot')).toBe('Protected')
    expect(pause('k-prot', false)).toBeNull()
  })
  it('a negative: our keyword there, a new place, a shared campaign, harvested lately — with or without a row of its own', () => {
    expect(negate('g1', 'made up shoes')).toBeNull()
    expect(negate('g1', 'made up scarf')).toBe('Our keyword')
    expect(negate('gn', 'made up shoes')).toBe('New place')
    expect(negate('gs', 'made up shoes')).toBe('Shared campaign')
    expect(negate('g1', 'made up belts')).toBe('Harvested lately')
    // The reason the review shows after "Left out:".
    expect(stopHold(f, { kind: 'negate', adGroupId: 'gn', text: 'made up shoes' }, { protectedToo: false })!.reason).toMatch(/5 days old/)
  })
  it('a place the page does not read holds nothing here (the tool decides)', () => {
    expect(stopHold(f, { kind: 'pause', targetId: 'nope' }, { protectedToo: true })).toBeNull()
    expect(stopHold(f, { kind: 'negate', adGroupId: 'nope', text: 'x' }, { protectedToo: true })).toBeNull()
  })
})

// ── 9 — a term whose keyword is paused ──────────────────────────────────────────────────────────────────────────

describe('HONEST 9 — every keyword that bought a term is paused: not running, not wasting', () => {
  const f = factsOf({
    campaigns: [{ id: 'c1' }],
    groups: [{ id: 'g1', campaignId: 'c1' }, { id: 'g2', campaignId: 'c1' }],
    targets: [
      kw('kp', 'g1', 'made up', 'BROAD', { status: 'PAUSED' }), kw('kp2', 'g1', 'made up boots', 'PHRASE', { status: 'PAUSED' }),
      kw('kon', 'g2', 'made up', 'BROAD'), kw('kp3', 'g2', 'made up boots', 'PHRASE', { status: 'PAUSED' }),
    ],
    terms: [
      { adGroupId: 'g1', text: 'made up boots cheap', via: ['kp', 'kp2'] },
      { adGroupId: 'g2', text: 'made up boots cheap', via: ['kon', 'kp3'] },
      { adGroupId: 'g1', text: 'made up boots blue', via: ['kp'], unknownVia: true },
    ],
  })
  const rows = rowsOf(f)
  const paused = rows.get(termId('g1', 'made up boots cheap'))!

  it('PAUSED, its test as it was, out of the Wasting list, its tile and its spend', () => {
    expect(paused.state).toBe('PAUSED')
    expect(paused.test.met).toBe(true)
    expect(isWasting(paused)).toBe(false)
    const list: WasteRow[] = [...rows.values()]
    const without = list.filter((r) => r.id !== paused.id)
    const t = totalsOf(list, 'wasting', { negated: 0 })
    const w = totalsOf(without, 'wasting', { negated: 0 })
    expect([t.wasting, t.wastingSpendCents]).toEqual([w.wasting, w.wastingSpendCents])
    expect(t.wasting).toBeGreaterThan(0)
  })
  it('one buying keyword that runs, or a buyer Nexus does not know, keeps it RUNNING', () => {
    expect(rows.get(termId('g2', 'made up boots cheap'))!.state).toBe('RUNNING')
    expect(rows.get(termId('g1', 'made up boots blue'))!.state).toBe('RUNNING')
  })
  it('it does not "still serve" where its keywords are paused', () => {
    expect(servingPlaces(f, 'made up boots cheap', null)).toEqual(['g2'])
    expect(rows.get(termId('g2', 'made up boots cheap'))!.stillServesIn).toBe(0)
  })
})
