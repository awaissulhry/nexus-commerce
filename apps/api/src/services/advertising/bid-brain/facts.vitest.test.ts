/**
 * BID BRAIN BB-3 — the facts builder (pure): from one market's rows to what `decide` takes.
 *
 *   scope      only keywords of allowlisted campaigns are decided; every campaign of the market feeds the pools
 *   pools      target → keyword text in the family's other campaigns → ad group → family → market; a level with the
 *              same members as the one below is left out
 *   goal       the campaign's own target ACoS, else the strategy's as written (TACoS kept), else the account default
 *   overrides  a budget floor → STOP, a retail-guard floor → STOCK, a Min-bid window → MIN-BID HOUR; pinned bids, a
 *              BidHold or a person's 60-day bid → PIN; a HELD enrollment → FREEZE
 *   brakes     the market's brakes, a paused campaign or ad group
 */
import { describe, expect, it } from 'vitest'
import { buildFacts, floorOverride, goalTarget, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type TargetRow } from './facts.js'

const campaign = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra,
})
const group = (id: string, campaignId: string, families: string[], extra: Partial<AdGroupRow> = {}): AdGroupRow => ({
  id, campaignId, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families, ...extra,
})
const target = (id: string, adGroupId: string, text: string, bidCents = 30, suppressedFromBidCents: number | null = null): TargetRow => ({ id, adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, suppressedFromBidCents })
const ev = (clicks: number, orders = 0) => ({ clicks, orders, salesCents: orders * 8000, costCents: clicks * 25 })

function market(extra: Partial<MarketRows> = {}): MarketRows {
  return {
    market: 'IT',
    dataDay: '2026-09-29',
    campaigns: new Map([['c1', campaign('c1')], ['c2', campaign('c2', { allowlisted: false })]]),
    adGroups: new Map([['g1', group('g1', 'c1', ['famA'])], ['g2', group('g2', 'c2', ['famA'])], ['g3', group('g3', 'c2', ['famB'])]]),
    targets: [target('t1', 'g1', 'race jacket'), target('t2', 'g1', 'leather jacket'), target('t3', 'g2', 'Race Jacket '), target('t4', 'g3', 'boots')],
    evidence: new Map([['t1', ev(5)], ['t2', ev(40, 1)], ['t3', ev(60, 1)], ['t4', ev(500, 6)]]),
    prices: new Map([['famA', 8990]]),
    ...extra,
  }
}
const run = (extra: Partial<RunRows> = {}): RunRows => ({
  marketBrakes: [], strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 80, maxChangePct: 25 }]]),
  accountDefaultPct: null, personHeld: new Set(), holds: [], enrollments: new Map(), lastSteps: new Map(), ...extra,
})

describe('scope and pools', () => {
  it('decides only the allowlisted campaign’s keywords, pooling over every campaign of the market', () => {
    const facts = buildFacts(market(), run())
    expect(facts.map((f) => f.targetId)).toEqual(['t1', 't2'])
    const t1 = facts[0]
    expect(t1.chain.map((n) => n.level)).toEqual(['target', 'keyword', 'adGroup', 'product', 'market'])
    expect(t1.chain[1].evidence.clicks).toBe(65) // "race jacket" in g1 and g2 (same family, text normalised)
    expect(t1.chain[2].evidence.clicks).toBe(45) // g1
    expect(t1.chain[3].evidence.clicks).toBe(105) // famA: g1 + g2
    expect(t1.chain[4].evidence.clicks).toBe(605) // the market
    expect(t1.listPriceCents).toBe(8990)
    expect(t1.limits).toMatchObject({ maxBidCents: 80, maxChangePct: 25 })
    expect(t1.goal).toMatchObject({ target: { kind: 'ACOS', pct: 20 }, phase: 'PROFIT' })
  })

  it('leaves out a level with nothing more than the one below', () => {
    const m = market({ targets: [target('t1', 'g1', 'race jacket')], adGroups: new Map([['g1', group('g1', 'c1', ['famA'])]]) })
    expect(buildFacts(m, run())[0].chain.map((n) => n.level)).toEqual(['target', 'market'])
  })
})

describe('goal', () => {
  it('takes the campaign’s own target, else the strategy’s as written, else the account default', () => {
    expect(goalTarget(campaign('c', { ownTargetAcos: 0.25 }), undefined, 30).target).toEqual({ kind: 'ACOS', pct: 25 })
    expect(goalTarget(campaign('c'), { target: { kind: 'TACOS', pct: 8 }, acosPct: 22, band: null, goal: null, minBidCents: null, maxBidCents: null, maxChangePct: null }, 30))
      .toEqual({ target: { kind: 'TACOS', pct: 8 }, acosFallbackPct: 22 })
    expect(goalTarget(campaign('c'), undefined, 30).target).toEqual({ kind: 'ACOS', pct: 30 })
    expect(goalTarget(campaign('c', { ownTargetAcos: 9 }), undefined, null).target).toBeNull()
  })

  it('BB-5 — passes the band on, and gives a TACoS target the family’s sales against its ad sales', () => {
    const tacos = run({ strategy: new Map([['g1', { target: { kind: 'TACOS', pct: 10 }, acosPct: null, band: { loPct: 8, hiPct: 14 }, goal: null, minBidCents: null, maxBidCents: null, maxChangePct: null }]]), familySales: new Map([['famA', 600_000]]) })
    const m = market({ adSales30: new Map([['t1', 100_000], ['t2', 50_000], ['t3', 90_000], ['t4', 7_000]]) })
    const [t1] = buildFacts(m, tacos)
    expect(t1.goal).toMatchObject({ target: { kind: 'TACOS', pct: 10 }, band: { loPct: 8, hiPct: 14 }, sales: { totalCents: 600_000, adCents: 240_000 } })
    expect(buildFacts(market(), run())[0].goal.sales).toBeUndefined()
  })
})

describe('overrides and brakes', () => {
  it('reads a floor by who set it', () => {
    const at = new Date()
    expect(floorOverride('automation:budget-enforce', 2, at)).toEqual({ stop: { bidCents: 2, by: 'automation:budget-enforce' } })
    expect(floorOverride('automation:retail-guard', 3, at)).toEqual({ stock: { notBuyable: true, stopBidCents: 3, by: 'automation:retail-guard' } })
    expect(floorOverride('automation:rank-defend-x', null, at)).toEqual({ minBidHour: { floorCents: 2 } })
    expect(floorOverride('automation:budget-enforce', 2, null)).toBeNull()
    // A keyword floored on its own, its bid remembered: the stop holds it.
    const floored = market({ targets: [target('t1', 'g1', 'race jacket', 2, 50)] })
    expect(buildFacts(floored, run())[0].overrides?.stop).toEqual({ bidCents: 2, by: 'a stop (its 50¢ bid remembered)' })
  })

  it('pins pinned bids, a hold and a person’s bid; freezes a HELD enrollment; brakes a paused campaign', () => {
    const m = market({ campaigns: new Map([['c1', campaign('c1', { pinBids: true, pinnedBy: 'user:owner' })], ['c2', campaign('c2', { allowlisted: false })]]) })
    expect(buildFacts(m, run())[0].overrides?.pin).toEqual({ by: 'bids pinned by user:owner' })
    const held = buildFacts(market(), run({ holds: [{ campaignId: 'c1', targetId: 't2', kind: 'CLAUDE', by: 'claude:appr_1', until: new Date('2026-12-01T00:00:00Z') }] }))
    expect(held[0].overrides?.pin).toBeUndefined()
    expect(held[1].overrides?.pin).toEqual({ by: 'claude hold by claude:appr_1', until: '2026-12-01' })
    expect(buildFacts(market(), run({ personHeld: new Set(['t1']) }))[0].overrides?.pin?.by).toMatch(/a person/)
    expect(buildFacts(market(), run({ enrollments: new Map([['c1', { mode: 'HELD', heldBy: 'auto-undo', heldUntil: null }]]) }))[0].overrides?.freeze).toEqual({ by: 'auto-undo' })
    const paused = market({ campaigns: new Map([['c1', campaign('c1', { status: 'PAUSED' })], ['c2', campaign('c2', { allowlisted: false })]]) })
    expect(buildFacts(paused, run({ marketBrakes: ['halted: test'] }))[0].brakes).toEqual(['halted: test', 'campaign paused'])
  })
})
