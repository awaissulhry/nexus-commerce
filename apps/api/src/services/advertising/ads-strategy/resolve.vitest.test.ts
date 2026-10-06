/**
 * ADS AUTONOMY W1-2 — the pure strategy resolver (resolve.ts). Made-up rows and catalog; no database.
 *
 *   order        variation → parent → the root's primary category, deepest first → market; a field from the first row
 *                that sets it, with its source; every row consulted in the chain
 *   categories   no primary but one category: that one; several and no primary, or several primaries: the safer value
 *                across them, with a warning; the root's classification, not the variation's
 *   rows         an orphan (its scope gone) and an unreadable row are never applied; a value in the wrong unit or range,
 *                a half-set group, a field on a level that cannot hold it are ignored and named
 *   TACoS        shown as the target, skipped by the ACoS target the engines use
 *   groups       a group comes whole from one row
 *   products     an ad group takes the safer value per field and names the product; a descriptive field is "mixed";
 *                unknown products are left out, or the market applies when none is known
 *   caps         every cap of a scope the subject belongs to binds, none inherited
 *   claude       resolved per action type
 */
import { describe, expect, it } from 'vitest'
import {
  indexStrategy,
  resolveCategory,
  resolveMarket,
  resolveProduct,
  resolveProducts,
  valuesOf,
  type Catalog,
  type CatalogProduct,
  type StrategyRow,
} from './resolve.js'

const COLUMNS = [
  'goal', 'goalNote', 'targetKind', 'targetPct', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'maxChangePct',
  'maxActionsPerRun', 'protect', 'harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays',
  'negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays', 'stopMethod', 'stopBidCents',
  'claudeAutonomy', 'reviewEveryDays',
] as const

let n = 0
function row(level: 'MARKET' | 'CATEGORY' | 'PRODUCT', scopeId: string, set: Partial<Record<(typeof COLUMNS)[number], unknown>> = {}, extra: Partial<StrategyRow> = {}): StrategyRow {
  n += 1
  return {
    id: `s${n}`, channel: 'AMAZON', market: 'IT', level, scopeId, label: `${level} ${scopeId}`, version: 1,
    updatedAt: new Date('2026-10-06T00:00:00Z'), updatedBy: 'user:test',
    ...Object.fromEntries(COLUMNS.map((c) => [c, null])),
    ...set,
    ...extra,
  } as StrategyRow
}

const product = (id: string, parentId: string | null = null): CatalogProduct => ({ id, sku: `TEST-${id.toUpperCase()}`, parentId })

/** Parent P (root, primary category leaf ⊂ mid ⊂ top) with variation V; standalone S with no category. */
function catalog(memberships: Catalog['memberships'] = new Map([['p', { primary: ['leaf'], all: ['leaf'] }]])): Catalog {
  return {
    products: new Map([['v', product('v', 'p')], ['p', product('p')], ['s', product('s')], ['q', product('q')]]),
    memberships,
    ancestry: new Map([['leaf', ['leaf', 'mid', 'top']], ['mid', ['mid', 'top']], ['top', ['top']], ['other', ['other', 'top']], ['solo', ['solo']]]),
    categoryNames: new Map([['leaf', 'Leaf'], ['mid', 'Mid'], ['top', 'Top'], ['other', 'Other'], ['solo', 'Solo']]),
  }
}

const field = (r: ReturnType<typeof resolveMarket>, key: string) => r.fields.get(key as never)!

describe('the order inside a market', () => {
  const rows = [
    row('MARKET', '*', { maxBidCents: 200, targetKind: 'ACOS', targetPct: 30, goal: 'PROFIT', maxActionsPerRun: 50 }),
    row('CATEGORY', 'top', { maxBidCents: 180 }),
    row('CATEGORY', 'mid', { targetKind: 'ACOS', targetPct: 25 }),
    row('PRODUCT', 'p', { maxChangePct: 20 }),
    row('PRODUCT', 'v', { minBidCents: 15 }),
  ]
  const { index } = indexStrategy('IT', rows)
  const r = resolveProduct(index, product('v', 'p'), catalog())

  it('variation, then parent, then the deepest category that sets it, then the market — each with its source', () => {
    expect(field(r, 'minBidCents')).toEqual({ value: 15, source: expect.objectContaining({ level: 'product', scopeId: 'v' }) })
    expect(field(r, 'maxChangePct')).toEqual({ value: 20, source: expect.objectContaining({ level: 'product', scopeId: 'p', via: 'parent' }) })
    expect(field(r, 'targetAcosPct')).toEqual({ value: 25, source: expect.objectContaining({ level: 'category', scopeId: 'mid' }) })
    expect(field(r, 'maxBidCents')).toEqual({ value: 180, source: expect.objectContaining({ level: 'category', scopeId: 'top' }) })
    expect(field(r, 'goal')).toEqual({ value: 'PROFIT', source: expect.objectContaining({ level: 'market', scopeId: '*' }) })
    expect(field(r, 'maxActionsPerRun').value).toBe(50)
    expect(field(r, 'reviewEveryDays')).toEqual({ value: null, source: null })
    expect(r.warnings).toEqual([])
  })

  it('the chain shows every row consulted, most specific first, with what each says', () => {
    expect(r.chains!.get('maxBidCents')!.map((c) => [c.source.scopeId, c.value])).toEqual([['v', null], ['p', null], ['mid', null], ['top', 180], ['*', 200]])
  })

  it('a deeper category row wins over its ancestor; a category resolves through its own chain', () => {
    const deeper = indexStrategy('IT', [...rows, row('CATEGORY', 'leaf', { maxBidCents: 150 })]).index
    expect(field(resolveProduct(deeper, product('v', 'p'), catalog()), 'maxBidCents').source).toEqual(expect.objectContaining({ scopeId: 'leaf' }))
    expect(field(resolveCategory(index, 'mid', catalog()), 'maxBidCents')).toEqual({ value: 180, source: expect.objectContaining({ scopeId: 'top' }) })
    expect(field(resolveCategory(index, 'mid', catalog()), 'targetAcosPct').value).toBe(25)
    expect(field(resolveMarket(index), 'maxBidCents').value).toBe(200)
  })

  it("the root's classification is used, not the variation's", () => {
    // The variation is filed under "solo" and has no own row: only its parent's categories count.
    const c = catalog(new Map([['p', { primary: ['leaf'], all: ['leaf'] }], ['v', { primary: ['solo'], all: ['solo'] }]]))
    const solo = indexStrategy('IT', [...rows, row('CATEGORY', 'solo', { maxBidCents: 10 })]).index
    expect(field(resolveProduct(solo, product('v', 'p'), c), 'maxBidCents').value).toBe(180)
  })
})

describe('which category a product resolves through', () => {
  const rows = [row('MARKET', '*', { maxBidCents: 200 }), row('CATEGORY', 'leaf', { maxBidCents: 150, goal: 'GROW' }), row('CATEGORY', 'other', { maxBidCents: 120, goal: 'DEFEND' })]
  const { index } = indexStrategy('IT', rows)

  it('no primary flagged but exactly one category: that one, without a warning', () => {
    const r = resolveProduct(index, product('p'), catalog(new Map([['p', { primary: [], all: ['leaf'] }]])))
    expect(field(r, 'maxBidCents').value).toBe(150)
    expect(r.warnings).toEqual([])
  })

  it('several categories and none primary: the safer value across them, named, with a warning — nothing guessed', () => {
    const r = resolveProduct(index, product('p'), catalog(new Map([['p', { primary: [], all: ['leaf', 'other'] }]])))
    expect(field(r, 'maxBidCents')).toEqual({ value: 120, source: expect.objectContaining({ scopeId: 'other', product: 'Other' }) })
    expect(r.warnings).toEqual(['TEST-P: its family has 2 categories and none is primary; the safer value across them applies'])
    // A descriptive field they disagree on is mixed, not picked.
    expect(field(r, 'goal')).toMatchObject({ value: null, source: null, mixed: [{ who: 'Leaf', value: 'GROW' }, { who: 'Other', value: 'DEFEND' }] })
  })

  it('two primaries: the safer value across them, with a warning', () => {
    const r = resolveProduct(index, product('p'), catalog(new Map([['p', { primary: ['leaf', 'other'], all: ['leaf', 'other'] }]])))
    expect(field(r, 'maxBidCents').value).toBe(120)
    expect(r.warnings).toEqual(['TEST-P: its family has 2 primary categories; the safer value across them applies'])
  })

  it('no category at all: straight to the market', () => {
    expect(field(resolveProduct(index, product('s'), catalog()), 'maxBidCents').source).toEqual(expect.objectContaining({ level: 'market' }))
  })
})

describe('rows the resolver does not apply', () => {
  it('an orphan (its category or product is gone) is set apart and never applied', () => {
    const rows = [row('MARKET', '*', { maxBidCents: 200 }), row('CATEGORY', 'leaf', { maxBidCents: 150 }), row('PRODUCT', 'v', { maxBidCents: 90 })]
    const { index, orphans } = indexStrategy('IT', rows, { categories: new Set(['mid']), products: new Set(['p']) })
    expect(orphans.map((o) => [o.level, o.scopeId, o.why])).toEqual([
      ['CATEGORY', 'leaf', 'the category no longer exists'],
      ['PRODUCT', 'v', 'the product no longer exists or was deleted'],
    ])
    expect(field(resolveProduct(index, product('v', 'p'), catalog()), 'maxBidCents').value).toBe(200)
  })

  it('an unknown level or a scope that does not fit its level drops the row, and says so', () => {
    const { index } = indexStrategy('IT', [
      row('MARKET', '*', { maxBidCents: 200 }, { level: 'MARKETS' as never }),
      row('MARKET', 'IT', { maxBidCents: 190 }),
      row('PRODUCT', '*', { maxBidCents: 80 }),
    ])
    expect(index.rows).toEqual([])
    expect(index.warnings).toHaveLength(3)
    expect(index.warnings[1]).toMatch(/a market row must have the scope "\*"; the row is ignored/)
  })

  it('a value in the wrong unit or range is ignored and named — a money value is never quoted', () => {
    const { index } = indexStrategy('IT', [row('MARKET', '*', { targetKind: 'ACOS', targetPct: 0.3, maxChangePct: 30, goal: 'GROWTH', harvestWindowDays: 45 })])
    const r = resolveMarket(index)
    expect(field(r, 'targetAcosPct').value).toBeNull()
    expect(field(r, 'maxChangePct').value).toBe(30)
    expect(index.warnings).toContain('MARKET * (market, v1): targetPct holds a value that is not a whole number; ignored')
    expect(index.warnings).toContain('MARKET * (market, v1): goal "GROWTH" is not one of LAUNCH, GROW, PROFIT, CLEAR_STOCK, DEFEND; ignored')
    expect(index.warnings.join(' ')).not.toMatch(/0\.3/)
    // The target group lost its percent: it is half set, so it is ignored whole.
    expect(index.warnings).toContain('MARKET * (market, v1): target is only partly set (targetKind); a group counts only whole, so it is ignored')
  })

  it('a field on a level that cannot hold it is ignored (most actions per run: the market only; protect: never the market)', () => {
    const { index } = indexStrategy('IT', [row('MARKET', '*', { protect: true }), row('PRODUCT', 'v', { maxActionsPerRun: 5 })])
    const r = resolveProduct(index, product('v', 'p'), catalog())
    expect(field(r, 'protect').value).toBeNull()
    expect(field(r, 'maxActionsPerRun').value).toBeNull()
    expect(index.warnings).toEqual([
      'MARKET * (market, v1): protect cannot be set on a market row; ignored',
      'PRODUCT v (product, v1): maxActionsPerRun cannot be set on a product row; ignored',
    ])
  })
})

describe('targets: ACoS steers, TACoS is shown', () => {
  it('a TACoS target is the product\'s target as written; the engines\' ACoS target skips it to the next ACoS level', () => {
    const { index } = indexStrategy('IT', [
      row('MARKET', '*', { targetKind: 'ACOS', targetPct: 30 }),
      row('CATEGORY', 'leaf', { targetKind: 'ACOS', targetPct: 25 }),
      row('PRODUCT', 'v', { targetKind: 'TACOS', targetPct: 12 }),
    ])
    const r = resolveProduct(index, product('v', 'p'), catalog())
    expect(field(r, 'target')).toEqual({ value: { targetKind: 'TACOS', targetPct: 12 }, source: expect.objectContaining({ scopeId: 'v' }) })
    expect(field(r, 'targetAcosPct')).toEqual({ value: 25, source: expect.objectContaining({ scopeId: 'leaf' }) })
    // What an engine takes: a FRACTION, never the TACoS.
    expect(valuesOf(r)).toMatchObject({ targetAcos: 0.25, targetAcosPct: 25 })
  })
})

describe('groups resolve whole', () => {
  it('a half-set group is ignored; a whole group (an empty ACoS ceiling inside it) is taken entire, never mixed with the market', () => {
    const { index } = indexStrategy('IT', [
      row('MARKET', '*', { harvestMinOrders: 2, harvestMinClicks: 3, harvestMaxAcosPct: 45, harvestWindowDays: 60, stopMethod: 'LOW_BIDS', stopBidCents: 5 }),
      row('CATEGORY', 'leaf', { harvestMinOrders: 3, harvestMinClicks: 8, harvestWindowDays: 90 }),
      row('PRODUCT', 'v', { harvestMinOrders: 1 }),
    ])
    const r = resolveProduct(index, product('v', 'p'), catalog())
    expect(field(r, 'harvest')).toEqual({
      value: { harvestMinOrders: 3, harvestMinClicks: 8, harvestMaxAcosPct: null, harvestWindowDays: 90 },
      source: expect.objectContaining({ scopeId: 'leaf' }),
    })
    expect(index.warnings).toEqual(['PRODUCT v (product, v1): harvest is only partly set (harvestMinOrders); a group counts only whole, so it is ignored'])
    expect(valuesOf(r)).toMatchObject({ harvest: { minOrders: 3, minClicks: 8, maxAcosPct: null, windowDays: 90 }, stop: { method: 'LOW_BIDS', bidCents: 5 } })
  })

  it('a stop without its own bid lowers to the 2¢ floor', () => {
    const { index } = indexStrategy('IT', [row('MARKET', '*', { stopMethod: 'LOW_BIDS' })])
    expect(valuesOf(resolveMarket(index)).stop).toEqual({ method: 'LOW_BIDS', bidCents: 2 })
  })
})

describe('several products in one ad group: the safer value per field', () => {
  const rows = [
    row('MARKET', '*', { monthlySpendCapCents: 90_000, claudeAutonomy: { negative: 'auto', bid: 'confirm' } }),
    row('CATEGORY', 'top', { monthlySpendCapCents: 40_000 }),
    row('PRODUCT', 'p', {
      maxBidCents: 120, minBidCents: 20, maxChangePct: 30, protect: false, goal: 'LAUNCH', targetKind: 'ACOS', targetPct: 35,
      harvestMinOrders: 3, harvestMinClicks: 5, harvestWindowDays: 60, negateMinClicks: 10, negateMinSpendCents: 500, negateMaxOrders: 0, negateWindowDays: 30,
      stopMethod: 'PAUSE', monthlySpendCapCents: 9_000, claudeAutonomy: { bid: 'auto' }, reviewEveryDays: 14,
    }),
    row('PRODUCT', 'q', {
      maxBidCents: 90, minBidCents: 10, maxChangePct: 40, protect: true, goal: 'PROFIT', targetKind: 'ACOS', targetPct: 20,
      harvestMinOrders: 2, harvestMinClicks: 10, harvestWindowDays: 30, negateMinClicks: 10, negateMinSpendCents: 800, negateMaxOrders: 1, negateWindowDays: 60,
      stopMethod: 'LOW_BIDS', stopBidCents: 5, monthlySpendCapCents: 7_000, claudeAutonomy: { bid: 'ask' }, reviewEveryDays: 7,
    }),
  ]
  const { index } = indexStrategy('IT', rows)
  const r = resolveProducts(index, [product('v', 'p'), product('q')], catalog())

  it('the lower target, bids, change and review interval; any protection; the stricter harvest and negate; low bids over a pause', () => {
    expect(field(r, 'targetAcosPct')).toEqual({ value: 20, source: expect.objectContaining({ scopeId: 'q', product: 'TEST-Q' }) })
    expect(field(r, 'maxBidCents')).toMatchObject({ value: 90, source: { product: 'TEST-Q' } })
    expect(field(r, 'minBidCents')).toMatchObject({ value: 10, source: { product: 'TEST-Q' } })
    expect(field(r, 'maxChangePct')).toMatchObject({ value: 30, source: { product: 'TEST-V', via: 'parent' } })
    expect(field(r, 'reviewEveryDays').value).toBe(7)
    expect(field(r, 'protect')).toMatchObject({ value: true, source: { product: 'TEST-Q' } })
    expect(field(r, 'harvest').value).toMatchObject({ harvestMinOrders: 3, harvestMinClicks: 5 })
    expect(field(r, 'negate')).toMatchObject({ value: { negateMinClicks: 10, negateMinSpendCents: 800 }, source: { product: 'TEST-Q' } })
    expect(field(r, 'stop').value).toEqual({ stopMethod: 'LOW_BIDS', stopBidCents: 5 })
  })

  it('a descriptive field the products disagree on is mixed, per product', () => {
    expect(field(r, 'goal')).toMatchObject({ value: null, source: null, mixed: [{ who: 'TEST-V', value: 'LAUNCH' }, { who: 'TEST-Q', value: 'PROFIT' }] })
    expect(field(r, 'target').mixed).toHaveLength(2)
  })

  it('Claude: the lower level per action type; a narrowing from any product binds the ad group', () => {
    expect(r.autonomy.get('bid')).toMatchObject({ value: 'ask', source: { product: 'TEST-Q' } })
    expect(r.autonomy.get('negative')).toMatchObject({ value: 'auto', source: { level: 'market' } })
    expect(r.autonomy.get('negative')!.source).not.toHaveProperty('product')
    expect(r.autonomy.get('create')).toEqual({ value: null, source: null })
    expect(valuesOf(r).claude).toEqual({ bid: 'ask', negative: 'auto' })
  })

  it('caps are not merged: every product\'s, every category\'s and the market\'s bind on their own spend', () => {
    expect(r.caps.map((c) => [c.source.level, c.source.scopeId, c.monthlySpendCapCents])).toEqual([
      ['product', 'p', 9_000], ['category', 'top', 40_000], ['market', '*', 90_000], ['product', 'q', 7_000],
    ])
  })
})

describe('ads whose product Nexus does not know', () => {
  const { index } = indexStrategy('IT', [row('MARKET', '*', { maxBidCents: 200 }), row('PRODUCT', 'q', { maxBidCents: 90 })])

  it('are left out when a known product exists', () => {
    const r = resolveProducts(index, [product('q')], catalog(), 2)
    expect(field(r, 'maxBidCents').value).toBe(90)
    expect(r.warnings).toEqual(['2 ads advertise a product Nexus does not know; they are left out'])
  })

  it('with no known product, the market applies', () => {
    const r = resolveProducts(index, [], catalog(), 1)
    expect(field(r, 'maxBidCents')).toMatchObject({ value: 200, source: { level: 'market' } })
    expect(r.warnings).toEqual(["1 ad advertises a product Nexus does not know: the market's strategy applies"])
  })
})

describe('Claude per action type, most specific first', () => {
  it('a product row narrows one action type; the market keeps the others; unknown keys and levels are ignored', () => {
    const { index } = indexStrategy('IT', [
      row('MARKET', '*', { claudeAutonomy: { bid: 'confirm', negative: 'auto', pause: 'auto' } }),
      row('PRODUCT', 'v', { claudeAutonomy: { bid: 'ask', harvest: 'always' } }),
    ])
    const r = resolveProduct(index, product('v', 'p'), catalog())
    expect(valuesOf(r).claude).toEqual({ bid: 'ask', negative: 'auto' })
    expect(index.warnings).toEqual([
      'MARKET * (market, v1): claudeAutonomy has an unknown action type "pause"; ignored',
      'PRODUCT v (product, v1): claudeAutonomy.harvest "always" is not off, ask, confirm or auto; ignored',
    ])
  })
})

describe('an empty market', () => {
  it('says nothing about any field: engines keep today\'s behaviour', () => {
    const { index } = indexStrategy('IT', [])
    const v = valuesOf(resolveProducts(index, [product('q')], catalog()))
    expect(v).toEqual({
      targetAcos: null, targetAcosPct: null, minBidCents: null, maxBidCents: null, maxChangePct: null, maxActionsPerRun: null,
      reviewEveryDays: null, protect: null, harvest: null, negate: null, stop: null, monthlyCaps: [], claude: {},
    })
  })
})
