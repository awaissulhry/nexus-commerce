/**
 * ADS AUTONOMY W2 (AA-W2-2) — the strategy-bound ad tools' kit, pure (ads-autonomy-kit.ts, ads-strategy/autonomy.ts).
 * Values and names are made up (public repo). The reads (scopes, the ledger, the month) run on PGlite in
 * ads-autonomy-ledger.vitest.test.ts.
 *
 *   measure    what one change does to spend: raise / cut / same, its move in percent or points, the budget it adds
 *   rows       every bid against its own scope's band and step — W1-5's arithmetic, its rounding and the stop exemption
 *   safer      an ad group of two products takes the safer number per limit, naming the product and the row it came from
 *   ledger     one run per stored preview, an entity once per run, previews without facts (or of another version) ignored
 *   checks     C1–C7, the rows, the steps and the month: each can refuse and each can pass, with the sentence naming
 *              the limit, its value and its source; a preview without facts is never inside
 *   month      the upper bound: report spend + every enabled budget for the days not reported, + what the change adds
 *   limits     the shared limits: defaults (spend-adding 0), named so tightening stays a free brake
 *   note       each limit, its value, this change's value and its source
 */
import { describe, expect, it } from 'vitest'
import { AUTO_CAP_WINDOW_MS, limitsTighten } from '../claude-trust.service.js'
import { indexStrategy, resolveProducts, valuesOf, type Catalog, type StrategyRow } from '../../advertising/ads-strategy/resolve.js'
import { projectMonth, scopeLimitsOf, strategyVersionOf, type MonthProjection } from '../../advertising/ads-strategy/autonomy.js'
import {
  LIMIT_FACTS_MONEY,
  LIMIT_FACTS_VERSION,
  RULE_DAY_MS,
  STEP_PCT_LIMITS,
  STEP_POINT_LIMITS,
  adKitLimits,
  aloneRefusal,
  bidOutsideWhy,
  commonRefusal,
  dailyRefusal,
  engineOwnedRefusal,
  itemsRefusal,
  ledgerOf,
  limitFactsOf,
  limitsNote,
  measure,
  monthRefusal,
  outsideRefusal,
  perEntityRefusal,
  protectedRefusal,
  stepRefusal,
  strategyRefusal,
  type LimitFacts,
  type MarketFacts,
  type ScopeFacts,
} from './ads-autonomy-kit.js'

// ── Made-up strategy rows ─────────────────────────────────────────────────────────────────────────

let rowSeq = 0
const row = (level: 'MARKET' | 'CATEGORY' | 'PRODUCT', scopeId: string, label: string, values: Partial<StrategyRow>, version = 1): StrategyRow => ({
  id: `s${++rowSeq}`, channel: 'AMAZON', market: 'IT', level, scopeId, label, version, updatedAt: new Date('2026-10-01T00:00:00Z'), updatedBy: 'user:test',
  goal: null, goalNote: null, targetKind: null, targetPct: null, monthlySpendCapCents: null, minBidCents: null, maxBidCents: null, maxChangePct: null,
  maxActionsPerRun: null, protect: null, harvestMinOrders: null, harvestMinClicks: null, harvestMaxAcosPct: null, harvestWindowDays: null,
  negateMinClicks: null, negateMinSpendCents: null, negateMaxOrders: null, negateWindowDays: null, stopMethod: null, stopBidCents: null,
  claudeAutonomy: null, reviewEveryDays: null, ...values,
})
const catalog: Catalog = {
  products: new Map([['p1', { id: 'p1', sku: 'TEST-P1', parentId: null }], ['p2', { id: 'p2', sku: 'TEST-P2', parentId: null }]]),
  memberships: new Map([['p2', { primary: ['cat-h'], all: ['cat-h'] }]]),
  ancestry: new Map([['cat-h', ['cat-h']]]),
}
const source = (label: string, level: 'product' | 'category' | 'market' = 'market', version = 1, product?: string) =>
  ({ level, strategyId: `src-${label}`, scopeId: level === 'market' ? '*' : label, label, version, ...(product ? { product } : {}) })

// ── Facts builder for the checks ──────────────────────────────────────────────────────────────────

const market = (over: Partial<MarketFacts> = {}): MarketFacts => ({
  strategy: { version: 'abc123def456' }, currency: 'EUR', maxActionsPerRun: null, maxWritesPerDay: null, maxRaisesPerDay: null,
  maxBudgetIncreasePerDayCents: null, sources: {}, ...over,
})
const scope = (over: Partial<ScopeFacts> = {}): ScopeFacts => ({ market: 'IT', label: 'ad group "Test group" (IT)', limits: {}, sources: {}, ...over })

function facts(over: Partial<LimitFacts> & { thisOver?: Partial<LimitFacts['this']> } = {}): LimitFacts {
  const { thisOver, ...rest } = over
  return {
    v: LIMIT_FACTS_VERSION,
    tool: 'set-target-bid',
    action: 'bid',
    markets: { IT: market() },
    scopes: { 'IT|adGroup:g1': scope() },
    entityScopes: { 'target:t1': 'IT|adGroup:g1' },
    labels: { 'target:t1': 'target "test jacket"' },
    this: {
      markets: ['IT'], items: 1, writes: 1, raises: 0, cuts: 1, largestRaisePct: 0, largestCutPct: 10, largestRaisePoints: 0, largestCutPoints: 0,
      highestNewBidCents: 45, budgetIncreaseCents: 0, byMarket: { IT: { items: 1, writes: 1, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 } },
      entities: ['target:t1'], rowsOutsideStrategy: 0, firstOutside: null, ...thisOver,
    },
    today: { IT: { writes: 0, raises: 0, budgetIncreaseCents: 0 } },
    perEntityToday: { maxChangesByRule: 0, entity: null },
    unplaced: [], engineOwned: [], protectedHit: [],
    ...rest,
  }
}
const BASE = adKitLimits({ maxItems: 50 }, STEP_PCT_LIMITS).parse({}) as Record<string, unknown>
const RAISE = { raises: 1, cuts: 0, largestRaisePct: 10, largestCutPct: 0, byMarket: { IT: { items: 1, writes: 1, raises: 1, budgetIncreaseCents: 0, addedDailyCents: 0 } } }

describe('measure — what one change does to spend', () => {
  it('a bid or a budget: up is a raise, down a cut, in percent of the value before; a new keyword is a raise', () => {
    expect(measure({ field: 'bid', fromCents: 40, toCents: 50 })).toMatchObject({ direction: 'raise', pct: 25, newBidCents: 50, addedDailyCents: 0 })
    expect(measure({ field: 'bid', fromCents: 50, toCents: 40 })).toMatchObject({ direction: 'cut', pct: 20 })
    expect(measure({ field: 'bid', fromCents: 50, toCents: 50 })).toMatchObject({ direction: 'same', pct: 0 })
    expect(measure({ field: 'bid', fromCents: null, toCents: 30 })).toMatchObject({ direction: 'raise', pct: null, newBidCents: 30 })
    expect(measure({ field: 'dailyBudget', fromCents: 2000, toCents: 2500 })).toMatchObject({ direction: 'raise', pct: 25, addedDailyCents: 500, newBidCents: null })
    expect(measure({ field: 'dailyBudget', fromCents: 2000, toCents: 1500 })).toMatchObject({ direction: 'cut', addedDailyCents: -500 })
  })

  it('a placement or a target ACoS moves in points; a status starts or stops a budget; a negative only lowers', () => {
    expect(measure({ field: 'placementPct', fromPct: 20, toPct: 35 })).toMatchObject({ direction: 'raise', points: 15, pct: null })
    expect(measure({ field: 'targetAcosPct', fromPct: 30, toPct: 25 })).toMatchObject({ direction: 'cut', points: 5 })
    expect(measure({ field: 'status', from: 'PAUSED', to: 'ENABLED', dailyBudgetCents: 1000 })).toMatchObject({ direction: 'raise', addedDailyCents: 1000 })
    expect(measure({ field: 'status', from: 'ENABLED', to: 'ARCHIVED', dailyBudgetCents: 1000 })).toMatchObject({ direction: 'cut', addedDailyCents: -1000 })
    expect(measure({ field: 'status', from: 'PAUSED', to: 'PAUSED' })).toMatchObject({ direction: 'same' })
    expect(measure({ field: 'negative', term: 'free' })).toMatchObject({ direction: 'cut' })
  })
})

describe('every row against its own scope (W1-5 band and step)', () => {
  const s = { limits: { minBidCents: 10, maxBidCents: 120, maxChangePct: 10 }, sources: { minBidCents: source('Test market (IT)'), maxBidCents: source('Helmets (IT)', 'category', 3), maxChangePct: source('Test market (IT)', 'market', 2) } }

  it('above the highest bid or below the lowest: outside, naming the value, the limit and its row', () => {
    expect(bidOutsideWhy({ field: 'bid', fromCents: 115, toCents: 125 }, s, 'EUR')).toBe('the new bid EUR 1.25 is above the highest bid EUR 1.20 (ads strategy: Helmets (IT), category, v3)')
    expect(bidOutsideWhy({ field: 'bid', fromCents: 11, toCents: 9 }, s, 'EUR')).toBe('the new bid EUR 0.09 is below the lowest bid EUR 0.10 (ads strategy: Test market (IT), market, v1)')
    expect(bidOutsideWhy({ field: 'bid', fromCents: null, toCents: 130 }, s, 'EUR')).toMatch(/above the highest bid/)
  })

  it('a step larger than the largest change is outside; Amazon-cent rounding of the step is inside', () => {
    expect(bidOutsideWhy({ field: 'bid', fromCents: 50, toCents: 60 }, s, 'EUR')).toBe('the bid moves 20 % (EUR 0.50 → EUR 0.60), more than the largest change 10 % (ads strategy: Test market (IT), market, v2)')
    expect(bidOutsideWhy({ field: 'bid', fromCents: 45, toCents: 50 }, s, 'EUR')).toBeNull() // 45 × 1.1 = 49.5 → 50, as the write's step clamp rounds
    expect(bidOutsideWhy({ field: 'bid', fromCents: 50, toCents: 45 }, s, 'EUR')).toBeNull()
    expect(bidOutsideWhy({ field: 'bid', fromCents: null, toCents: 60 }, s, 'EUR')).toBeNull() // a new keyword: no step
  })

  it('a stop\'s forced lowering is exempt from the lowest bid and the step; no strategy, nothing is outside', () => {
    expect(bidOutsideWhy({ field: 'bid', fromCents: 50, toCents: 2, forced: true }, s, 'EUR')).toBeNull()
    expect(bidOutsideWhy({ field: 'bid', fromCents: 50, toCents: 500 }, { limits: {}, sources: {} }, 'EUR')).toBeNull()
  })
})

describe('the safer number for a mixed ad group (W1\'s resolver)', () => {
  it('two products, each with its own number: the lower bid, any protection, the lower level — each naming its product and row', () => {
    const rows = [
      row('MARKET', '*', 'Test market (IT)', { maxBidCents: 200, maxChangePct: 20, claudeAutonomy: { bid: 'auto' } }),
      row('PRODUCT', 'p1', 'TEST-P1 (IT)', { maxBidCents: 150, claudeAutonomy: { bid: 'confirm' } }, 4),
      row('CATEGORY', 'cat-h', 'Helmets (IT)', { maxBidCents: 90, protect: true }, 3),
    ]
    const { index } = indexStrategy('IT', rows)
    const resolved = resolveProducts(index, [...catalog.products.values()], catalog)
    const s = scopeLimitsOf({ values: valuesOf(resolved), resolved }, 'bid')
    expect(s.limits).toMatchObject({ maxBidCents: 90, maxChangePct: 20, protect: true, claudeLevel: 'confirm' })
    expect(s.sources.maxBidCents).toMatchObject({ level: 'category', label: 'Helmets (IT)', version: 3, product: 'TEST-P2' })
    expect(s.sources.protect).toMatchObject({ level: 'category', product: 'TEST-P2' })
    expect(s.sources.claudeLevel).toMatchObject({ level: 'product', label: 'TEST-P1 (IT)', version: 4, product: 'TEST-P1' })
    expect(s.sources.maxChangePct).toMatchObject({ level: 'market' })
    // Another kind of action: no level where no row speaks to it.
    expect(scopeLimitsOf({ values: valuesOf(resolved), resolved }, 'negative').limits.claudeLevel).toBeUndefined()
    expect(scopeLimitsOf({ values: valuesOf(resolved), resolved }, null).limits.claudeLevel).toBeUndefined()
  })

  it('the strategy version changes when any row of the market changes, and is null with no row', () => {
    const a = row('MARKET', '*', 'Test market (IT)', {}, 1)
    const b = row('PRODUCT', 'p1', 'TEST-P1 (IT)', {}, 1)
    const v1 = strategyVersionOf({ rows: [a, b] })
    expect(v1).toMatch(/^[0-9a-f]{12}$/)
    expect(strategyVersionOf({ rows: [b, a] })).toBe(v1)
    expect(strategyVersionOf({ rows: [a, { ...b, version: 2 }] })).not.toBe(v1)
    expect(strategyVersionOf({ rows: [] })).toBeNull()
  })
})

describe('today\'s ledger — one run per stored preview', () => {
  const stored = (byMarket: Record<string, unknown>, entities: string[], v: number = LIMIT_FACTS_VERSION) => ({ action: 'x', limitFacts: { v, markets: {}, this: { byMarket, entities } } })

  it('sums writes, raises and budget increases per market, and counts an entity once per run', () => {
    const ledger = ledgerOf([
      stored({ IT: { writes: 3, raises: 1, budgetIncreaseCents: 0 } }, ['target:t1', 'target:t1', 'target:t2']),
      stored({ IT: { writes: 2, raises: 0, budgetIncreaseCents: 500 }, DE: { writes: 1, raises: 1, budgetIncreaseCents: 0 } }, ['target:t1', 'campaign:c1']),
      { price: 10 }, // another tool's preview: no facts
      null,
      stored({ IT: { writes: 99, raises: 99, budgetIncreaseCents: 99 } }, ['target:t1'], 2), // another version: not read
    ])
    expect(ledger.runs).toBe(2)
    expect(ledger.byMarket).toEqual({ IT: { writes: 5, raises: 1, budgetIncreaseCents: 500 }, DE: { writes: 1, raises: 1, budgetIncreaseCents: 0 } })
    expect(ledger.byEntity).toEqual({ 'target:t1': 2, 'target:t2': 1, 'campaign:c1': 1 })
  })

  it('"today" is the business cap\'s own window', () => {
    expect(RULE_DAY_MS).toBe(AUTO_CAP_WINDOW_MS)
  })
})

describe('the common checks', () => {
  it('a preview without limit facts, or of another version, is never inside (a person decides)', () => {
    expect(commonRefusal(null, BASE)).toMatch(/no limit facts .* a person decides/)
    expect(commonRefusal({ limitFacts: { ...facts(), v: 2 } }, BASE)).toMatch(/no limit facts/)
    expect(limitFactsOf({ limitFacts: facts() })).not.toBeNull()
    expect(commonRefusal({ limitFacts: facts() }, BASE)).toBeNull()
  })

  it('C1 — an entity Nexus cannot place, or a market without a strategy', () => {
    expect(strategyRefusal(facts({ unplaced: [{ entity: 'target:x', why: 'target x was not found in this business' }] })))
      .toBe('target x was not found in this business: Nexus cannot tell which ads strategy covers it; a person decides')
    expect(strategyRefusal(facts({ markets: { IT: market({ strategy: null }) } }))).toBe('there is no ads strategy for IT: nothing runs alone there; a person decides')
    expect(strategyRefusal(facts())).toBeNull()
  })

  it('C2 — the strategy holds this kind below auto at a scope it lands on: refused, naming the row; auto or silent: inside', () => {
    const held = (level: 'off' | 'ask' | 'confirm' | 'auto') => facts({ scopes: { 'IT|adGroup:g1': scope({ limits: { claudeLevel: level }, sources: { claudeLevel: source('TEST-P1 (IT)', 'product', 4, 'TEST-P1') } }) } })
    expect(aloneRefusal(held('ask'))).toBe('the ads strategy lets Claude only ask for bid changes at ad group "Test group" (IT) (ads strategy: TEST-P1 (IT), product, v4, from TEST-P1); a person decides')
    expect(aloneRefusal(held('off'))).toMatch(/^the ads strategy turns bid changes off for Claude at/)
    expect(aloneRefusal(held('confirm'))).toMatch(/go no further than confirm in Claude for bid changes/)
    expect(aloneRefusal(held('auto'))).toBeNull()
    expect(aloneRefusal(facts())).toBeNull() // the strategy says nothing about bids here: it does not narrow
    expect(aloneRefusal({ ...held('ask'), action: null })).toBeNull() // a kind the strategy has no level for
  })

  it('C3 — a protected term or product it meets', () => {
    const f = facts({ protectedHit: [{ entity: 'target:t1', why: 'target "test jacket": the ads strategy protects a product it advertises (ads strategy: Helmets (IT), category, v3), so lowering its bid waits for a person' }, { entity: 'target:t2', why: 'x' }] })
    expect(protectedRefusal(f)).toBe('target "test jacket": the ads strategy protects a product it advertises (ads strategy: Helmets (IT), category, v3), so lowering its bid waits for a person (and 1 more item); a person decides')
    expect(protectedRefusal(facts())).toBeNull()
  })

  it('rows — any row outside its own scope\'s strategy refuses the whole request, naming the first', () => {
    const f = facts({ thisOver: { items: 40, rowsOutsideStrategy: 2, firstOutside: { entity: 'target:t9', why: 'target "x": the new bid EUR 1.25 is above the highest bid EUR 1.20 (ads strategy: Helmets (IT), category, v3)' } } })
    expect(outsideRefusal(f)).toBe('2 of 40 items are outside the ads strategy — target "x": the new bid EUR 1.25 is above the highest bid EUR 1.20 (ads strategy: Helmets (IT), category, v3); a person decides')
    expect(outsideRefusal(facts())).toBeNull()
  })

  it('C4 — what an enabled rule or schedule also moves, unless allowEngineOwned', () => {
    const f = facts({ engineOwned: [{ campaignId: 'c1', label: 'the campaign of target "test jacket"', by: ['schedule "Evening push"'] }] })
    expect(engineOwnedRefusal(f, BASE)).toBe('the campaign of target "test jacket" is also moved by schedule "Evening push"; Claude does not change what an engine moves without a person (allowEngineOwned is off)')
    expect(engineOwnedRefusal(f, { ...BASE, allowEngineOwned: true })).toBeNull()
  })

  it('C5 — writes a day: today + this within the strategy\'s number; none set: no daily number for writes', () => {
    const src = source('Test market (IT)', 'market', 5)
    const f = (today: number, max: number | null) => facts({ today: { IT: { writes: today, raises: 0, budgetIncreaseCents: 0 } }, markets: { IT: market({ maxWritesPerDay: max, sources: { maxWritesPerDay: src } }) } })
    expect(dailyRefusal(f(9, 10))).toBeNull()
    expect(dailyRefusal(f(10, 10))).toBe('IT: 10 writes ran by rule in the last 24 hours and this adds 1, more than the 10 a day the ads strategy allows (ads strategy: Test market (IT), market, v5); a person decides')
    expect(dailyRefusal(f(500, null))).toBeNull()
  })

  it('C5 — raises and budget increases a day: not set in the strategy means a person decides each one', () => {
    expect(dailyRefusal(facts({ thisOver: RAISE }))).toBe('IT: the ads strategy sets no number of raises Claude may run by rule in a day, so a raise waits for a person')
    const raises = (today: number, max: number) => facts({ thisOver: RAISE, today: { IT: { writes: 0, raises: today, budgetIncreaseCents: 0 } }, markets: { IT: market({ maxRaisesPerDay: max }) } })
    expect(dailyRefusal(raises(4, 5))).toBeNull()
    expect(dailyRefusal(raises(5, 5))).toMatch(/^IT: 5 raises ran by rule in the last 24 hours and this adds 1, more than the 5 a day/)
    const budget = { ...RAISE, budgetIncreaseCents: 500, byMarket: { IT: { items: 1, writes: 1, raises: 1, budgetIncreaseCents: 500, addedDailyCents: 500 } } }
    expect(dailyRefusal(facts({ thisOver: budget, markets: { IT: market({ maxRaisesPerDay: 10 }) } }))).toBe('IT: the ads strategy sets no daily budget increase Claude may run by rule, so a budget increase waits for a person')
    const increase = (today: number) => facts({ thisOver: budget, today: { IT: { writes: 0, raises: 0, budgetIncreaseCents: today } }, markets: { IT: market({ maxRaisesPerDay: 10, maxBudgetIncreasePerDayCents: 1000 }) } })
    expect(dailyRefusal(increase(500))).toBeNull()
    expect(dailyRefusal(increase(501))).toBe('IT: budgets rose EUR 5.01 by rule in the last 24 hours and this adds EUR 5.00, more than the EUR 10.00 a day the ads strategy allows; a person decides')
    // A lowering adds no raise and no budget: no daily number holds it.
    expect(dailyRefusal(facts())).toBeNull()
  })

  it('C6 — the same entity changed by rule as often as the tool allows in 24 hours (no back and forth)', () => {
    const f = (runs: number) => facts({ perEntityToday: { maxChangesByRule: runs, entity: runs ? 'target:t1' : null } })
    expect(perEntityRefusal(f(0), BASE)).toBeNull()
    expect(perEntityRefusal(f(1), BASE)).toBe('Claude already changed target "test jacket" 1 time by rule in the last 24 hours, and this tool\'s limits allow 1 a day; a person decides')
    expect(perEntityRefusal(f(1), { ...BASE, maxChangesPerEntityPerDay: 2 })).toBeNull()
    expect(perEntityRefusal(f(0), { ...BASE, maxChangesPerEntityPerDay: 0 })).toMatch(/let no entity be changed by rule/)
  })

  it('C7 — items: the tool\'s limit and the market\'s most actions per run, the smaller binding', () => {
    const many = { items: 51, byMarket: { IT: { items: 51, writes: 51, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 } } }
    expect(itemsRefusal(facts({ thisOver: many }), BASE)).toBe('it changes 51 items, more than the 50 this tool\'s limits allow in one request run by rule; a person decides')
    const run = facts({ thisOver: { ...many, items: 30, byMarket: { IT: { ...many.byMarket.IT, items: 30 } } }, markets: { IT: market({ maxActionsPerRun: 25, sources: { maxActionsPerRun: source('Test market (IT)', 'market', 2) } }) } })
    expect(itemsRefusal(run, BASE)).toBe('it changes 30 items in IT, more than the 25 actions per run the ads strategy allows (ads strategy: Test market (IT), market, v2); a person decides')
    expect(itemsRefusal(facts(), BASE)).toBeNull()
    expect(itemsRefusal(facts(), { ...BASE, maxItems: 0 })).toMatch(/more than the 0 this tool's limits allow/)
  })

  it('steps — the tool\'s own raise and cut limits, when it holds them; 0 raise = every raise waits for a person', () => {
    expect(stepRefusal(facts({ thisOver: RAISE }), BASE)).toBe('its largest raise is 10 %, more than the 0 % this tool\'s limits let run without a person (0: every raise waits for a person)')
    expect(stepRefusal(facts({ thisOver: RAISE }), { ...BASE, maxRaisePct: 15 })).toBeNull()
    expect(stepRefusal(facts(), { ...BASE, maxCutPct: 5 })).toMatch(/^its largest cut is 10 %, more than the 5 %/)
    expect(stepRefusal(facts({ thisOver: { largestRaisePoints: 12 } }), STEP_POINT_LIMITS_DEFAULTS)).toMatch(/largest raise is 12 points/)
    expect(stepRefusal(facts({ thisOver: RAISE }), { maxItems: 5 })).toBeNull() // a tool without step limits
  })

  it('month — a change that can add spend keeps the month under its cap, saying how the upper bound is made', () => {
    const p = projection({ afterCents: 100_100, capCents: 100_000, capFrom: 'ads strategy: Test market (IT), market, v2' })
    expect(monthRefusal(facts({ monthProjection: { IT: p } }))).toBe(
      'IT: this month could reach EUR 1001.00 with this change — EUR 100.00 spent through 2026-10-04, every enabled campaign\'s daily budget (EUR 30.00 together) for the 27 days not reported yet, +EUR 5.00 a day from today for 26 days — above the monthly cap EUR 1000.00 (ads strategy: Test market (IT), market, v2); a person decides',
    )
    expect(monthRefusal(facts({ monthProjection: { IT: { ...p, afterCents: 100_000 } } }))).toBeNull()
    expect(monthRefusal(facts({ monthProjection: { IT: { ...p, capCents: null, capFrom: null } } }))).toBeNull()
    expect(monthRefusal(facts())).toBeNull()
  })

  it('runs in order: no strategy before what the strategy allows, before protection, … before the month', () => {
    const all = facts({
      markets: { IT: market({ strategy: null }) },
      scopes: { 'IT|adGroup:g1': scope({ limits: { claudeLevel: 'ask' }, sources: { claudeLevel: source('x') } }) },
      protectedHit: [{ entity: 'target:t1', why: 'protected' }],
    })
    expect(commonRefusal({ limitFacts: all }, BASE)).toMatch(/^there is no ads strategy for IT/)
    expect(commonRefusal({ limitFacts: { ...all, markets: { IT: market() } } }, BASE)).toMatch(/^the ads strategy lets Claude only ask/)
    expect(commonRefusal({ limitFacts: { ...all, markets: { IT: market() }, scopes: { 'IT|adGroup:g1': scope() } } }, BASE)).toBe('protected; a person decides')
  })
})

const STEP_POINT_LIMITS_DEFAULTS = adKitLimits({ maxItems: 50 }, STEP_POINT_LIMITS).parse({}) as Record<string, unknown>

function projection(over: Partial<MonthProjection> = {}): MonthProjection {
  return {
    month: '2026-10', currency: 'EUR', spentCents: 10_000, spendThrough: '2026-10-04', uncoveredDays: 27, daysLeft: 26, budgetsCents: 3_000,
    projectedCents: 91_000, addedDailyCents: 500, afterCents: 104_000, capCents: null, capFrom: null, ...over,
  }
}

describe('the month — an upper bound from budgets (spend data is a day or two late)', () => {
  const today = new Date('2026-10-06T15:00:00Z')

  it('report spend + every enabled budget for each day not reported yet, + what the change adds from today', () => {
    const p = projectMonth({ today, spentCents: 10_000, spendThrough: '2026-10-04', budgetsCents: 3_000, addedDailyCents: 500, cap: { cents: 100_000, from: 'the budget plan 2026-10' }, currency: 'EUR' })
    expect(p).toEqual(projection({ capCents: 100_000, capFrom: 'the budget plan 2026-10' }))
  })

  it('no report this month yet: every day of the month counts a full budget; last month\'s report covers nothing of this one', () => {
    expect(projectMonth({ today, spentCents: 0, spendThrough: null, budgetsCents: 1_000, addedDailyCents: 0, cap: null, currency: 'GBP' }))
      .toMatchObject({ uncoveredDays: 31, projectedCents: 31_000, afterCents: 31_000, spendThrough: null, currency: 'GBP', capCents: null })
    expect(projectMonth({ today, spentCents: 0, spendThrough: '2026-09-30', budgetsCents: 1_000, addedDailyCents: 0, cap: null, currency: 'EUR' }))
      .toMatchObject({ uncoveredDays: 31, spendThrough: null })
  })

  it('a budget that stops spending lowers the bound, never below what is spent', () => {
    expect(projectMonth({ today, spentCents: 10_000, spendThrough: '2026-10-04', budgetsCents: 3_000, addedDailyCents: -1_000, cap: null, currency: 'EUR' }).afterCents).toBe(91_000 - 26_000)
    expect(projectMonth({ today, spentCents: 10_000, spendThrough: '2026-10-04', budgetsCents: 0, addedDailyCents: -1_000, cap: null, currency: 'EUR' }).afterCents).toBe(10_000)
  })
})

describe('the shared limits', () => {
  it('defaults: a bulk tool 50 items, one change per entity a day, never what an engine moves, no raise, any cut', () => {
    expect(adKitLimits({ maxItems: 50 }, STEP_PCT_LIMITS).parse({})).toEqual({ maxItems: 50, maxChangesPerEntityPerDay: 1, allowEngineOwned: false, maxRaisePct: 0, maxCutPct: 100 })
    expect(adKitLimits({ maxItems: 0 }).parse({})).toEqual({ maxItems: 0, maxChangesPerEntityPerDay: 1, allowEngineOwned: false })
    expect(adKitLimits({ maxItems: 50 }, STEP_POINT_LIMITS).parse({})).toMatchObject({ maxRaisePoints: 0, maxCutPoints: 100 })
    expect(() => adKitLimits({ maxItems: 50 }).parse({ maxItems: 251 })).toThrow()
  })

  it('named so tightening is a free brake and anything else needs the code (limitsTighten)', () => {
    const tool = { limits: adKitLimits({ maxItems: 50 }, STEP_PCT_LIMITS) }
    const d = tool.limits.parse({}) as Record<string, unknown>
    expect(limitsTighten(tool, d, { ...d, maxItems: 10 })).toBe(true)
    expect(limitsTighten(tool, d, { ...d, maxChangesPerEntityPerDay: 0 })).toBe(true)
    expect(limitsTighten(tool, d, { ...d, maxCutPct: 20 })).toBe(true)
    expect(limitsTighten(tool, { ...d, allowEngineOwned: true }, d)).toBe(true)
    expect(limitsTighten(tool, d, { ...d, maxRaisePct: 15 })).toBe(false)
    expect(limitsTighten(tool, d, { ...d, allowEngineOwned: true })).toBe(false)
    expect(limitsTighten(tool, d, { ...d, maxItems: 100 })).toBe(false)
  })

  it('every money number of the facts sits under a key the money filter strips', () => {
    for (const key of ['minBidCents', 'maxBidCents', 'stopBidCents', 'negateMinSpendCents', 'highestNewBidCents', 'budgetIncreaseCents', 'addedDailyCents', 'maxBudgetIncreasePerDayCents', 'spentCents', 'budgetsCents', 'projectedCents', 'afterCents', 'capCents']) {
      expect(LIMIT_FACTS_MONEY[key], key).toBe('financials.adspend.view')
    }
  })
})

describe('the note — each limit, its value, this change\'s value and its source', () => {
  it('says the strategy where it lands, today against the daily limits, the items, the engines, the month', () => {
    const f = facts({
      thisOver: { ...RAISE, highestNewBidCents: 55, largestRaisePct: 10 },
      markets: { IT: market({ maxActionsPerRun: 40, sources: { maxActionsPerRun: source('Test market (IT)', 'market', 2) } }) },
      scopes: {
        'IT|adGroup:g1': scope({ limits: { maxBidCents: 120, maxChangePct: 15, protect: true, claudeLevel: 'auto' }, sources: { maxBidCents: source('Helmets (IT)', 'category', 3, 'TEST-P2'), maxChangePct: source('Test market (IT)', 'market', 2), protect: source('Helmets (IT)', 'category', 3, 'TEST-P2'), claudeLevel: source('Test market (IT)', 'market', 2) } }),
        'IT|adGroup:g2': scope({ label: 'ad group "Second" (IT)', limits: { maxChangePct: 15 }, sources: { maxChangePct: source('Test market (IT)', 'market', 2) } }),
      },
      today: { IT: { writes: 12, raises: 3, budgetIncreaseCents: 0 } },
      perEntityToday: { maxChangesByRule: 0, entity: null },
      engineOwned: [{ campaignId: 'c1', label: 'the campaign of target "test jacket"', by: ['rule "Night cut"'] }],
      monthProjection: { IT: projection({ capCents: 200_000, capFrom: 'the budget plan 2026-10' }) },
    })
    const note = limitsNote(f, BASE)
    expect(note).toContain('IT: ads strategy version abc123def456.')
    expect(note).toContain('IT, run by rule in the last 24 hours: 12 writes, 3 raises, budgets +EUR 0.00; this change: 1 write, 1 raise, budgets +EUR 0.00. Daily limits: writes not set (the business\'s cap of runs by rule applies); raises not set in the ads strategy (a raise waits for a person); budget increase not set in the ads strategy (an increase waits for a person).')
    expect(note).toContain('IT: most actions per run 40 (ads strategy: Test market (IT), market, v2); this change: 1.')
    expect(note).toContain('Highest bid EUR 1.20 (ads strategy: Helmets (IT), category, v3, from TEST-P2) — at ad group "Test group" (IT).')
    expect(note).toContain('Largest bid change 15 % (ads strategy: Test market (IT), market, v2) — at ad group "Test group" (IT), ad group "Second" (IT).')
    expect(note).toContain('Protected (ads strategy: Helmets (IT), category, v3, from TEST-P2) — at ad group "Test group" (IT).')
    expect(note).toContain('What Claude may do alone for bid changes: auto (ads strategy: Test market (IT), market, v2) — at ad group "Test group" (IT).')
    expect(note).toContain('This change: highest new bid EUR 0.55; largest raise 10 % (at most 0, Claude\'s limits for this tool); largest cut 0 % (at most 100, Claude\'s limits for this tool).')
    expect(note).toContain('Items: 1 (at most 50, Claude\'s limits for this tool); outside the ads strategy: 0.')
    expect(note).toContain('Changed by rule in the last 24 hours: none of these (at most 1 per item, Claude\'s limits for this tool).')
    expect(note).toContain('The campaign of target "test jacket" is also moved by rule "Night cut" (allowEngineOwned: off).')
    expect(note.at(-1)).toBe('IT, this month at most EUR 1040.00 with this change (EUR 100.00 spent through 2026-10-04, every enabled campaign\'s daily budget (EUR 30.00 together) for the 27 days not reported yet, +EUR 5.00 a day from today for 26 days); cap EUR 2000.00 (the budget plan 2026-10).')
  })

  it('a market without a strategy, and an entity Nexus cannot place, are said plainly', () => {
    const note = limitsNote(facts({ markets: { IT: market({ strategy: null }) }, unplaced: [{ entity: 'target:x', why: 'target x was not found in this business' }] }))
    expect(note).toContain('IT: no ads strategy — nothing runs alone there.')
    expect(note).toContain('Not placed: target x was not found in this business.')
  })
})
