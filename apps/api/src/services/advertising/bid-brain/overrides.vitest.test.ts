/**
 * BID BRAIN BB-8 — the overrides as inputs, read from their sources, and the bids going back when a stop lifts (pure).
 *
 *   stock      every product out of stock or without the Buy Box → STOCK at the stop bid; every product short of cover →
 *              STOCK, the goal bid × 0.5–1 (0.5 with none left, 1 at the product's own line); a retail-guard floor
 *              already in force keeps its own words
 *   playbook   a campaign a playbook built and has not started, or a slot its phase floors → PHASE at the floor, said
 *              in the why; a stopped playbook → STOP
 *   holds      an auto-undo BidHold freezes (no raise, lowering allowed); every other hold pins
 *   goal       a LAUNCH product's day reaches the ramp; break-even caps the band top (goal.ts)
 *   restore    no override applies any more, the last decision lowered the bid and it still sits there → back to the
 *              bid before the stop, decided as if the stop never happened; with no bid before, the goal bid; with
 *              neither, it stays and says why; a bid someone moved since is decided as usual
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import { buildFacts, playbookOverride, stockFactOf, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type TargetRow } from './facts.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** The design's §7 rates (synthetic counts): CR 0.87 %, AOV 81.15 → a goal bid of about 16¢ at aim 20 %. */
const PRODUCT = ev(2300, 20, 162_300, 69_000)

function example(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1',
    currentCents: current,
    dataDay: '2026-10-01',
    chain: [
      { level: 'target', evidence: ev(1, 0, 0, 30) },
      { level: 'product', evidence: PRODUCT },
      { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) },
    ],
    listPriceCents: 8990,
    parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    ...extra,
  }
}

describe('stock from its source', () => {
  const p = (units: number, daysOfCover: number | null, lowBelowDays: number | null, hasBuyBox: boolean | null = true) => ({ units, daysOfCover, lowBelowDays, hasBuyBox })
  it('every product out of stock → not buyable at the stop bid', () => {
    expect(stockFactOf({ risk: 'out-of-stock', products: [p(0, 0, 20), p(0, 0, 20)] }, 3)).toEqual({ kind: 'notBuyable', stopBidCents: 3, by: 'out of stock (2 products)' })
  })
  it('every product without the Buy Box → not buyable, whatever its stock', () => {
    expect(stockFactOf({ risk: 'ok', products: [p(40, 60, 20, false)] }, 2)).toEqual({ kind: 'notBuyable', stopBidCents: 2, by: 'no Buy Box (1 product)' })
  })
  it('every product short → the shortest cover against its own line: 0.5 + 0.5 × cover ÷ line', () => {
    expect(stockFactOf({ risk: 'low-stock', products: [p(4, 5, 20), p(9, 15, 20)] }, 2)).toEqual({ kind: 'lowCover', factor: 0.63, by: 'low stock: 5 days of cover against a 20-day line' })
  })
  it('a mixed, shared, ok or empty ad group says nothing (never lowered as a whole)', () => {
    for (const risk of ['mixed', 'shared', 'ok', 'unknown']) expect(stockFactOf({ risk, products: [p(0, 0, 20), p(30, 40, 20)] }, 2)).toBeNull()
    expect(stockFactOf({ risk: 'out-of-stock', products: [] }, 2)).toBeNull()
  })
  it('the brain lowers by it: not buyable → the stop bid; low cover → the goal bid × the factor', () => {
    const out = decide(example(16, { overrides: { stock: { notBuyable: true, stopBidCents: 3, by: 'out of stock (2 products)' } } }))
    expect([out.action, out.layer, out.bidCents]).toEqual(['write', 'stock', 3])
    expect(out.why).toBe('stock: not buyable (out of stock (2 products)) → 3¢')
    const low = decide(example(16, { overrides: { stock: { coverFactor: 0.63, by: 'low stock: 5 days' } } }))
    expect([low.action, low.layer, low.bidCents]).toEqual(['write', 'stock', 10])
  })
})

describe('the playbook', () => {
  it('built and not started → PHASE at the floor, named; a phase floor → PHASE; a stopped playbook → STOP', () => {
    expect(playbookOverride({ kind: 'notStarted', floorCents: 2, label: 'GALE IT' })).toEqual({ phase: { notStarted: true, floorCents: 2, by: 'the playbook GALE IT has not started' } })
    expect(playbookOverride({ kind: 'phaseFloor', floorCents: 4, label: 'GALE IT' })).toEqual({ phase: { floorCents: 4, by: 'the phase of playbook GALE IT floors this slot' } })
    expect(playbookOverride({ kind: 'stopped', floorCents: 2, label: 'GALE IT' })).toEqual({ stop: { bidCents: 2, by: 'a playbook STOP (GALE IT)' } })
    const d = decide(example(16, { overrides: playbookOverride({ kind: 'phaseFloor', floorCents: 4, label: 'GALE IT' }) }))
    expect([d.action, d.layer, d.bidCents, d.why]).toEqual(['write', 'phase', 4, 'phase: the phase of playbook GALE IT floors this slot → 4¢'])
  })
})

describe('the bids going back when a stop lifts', () => {
  const lowered = { layer: 'stop' as const, heldCents: 2, beforeCents: 19 }
  it('back to the bid before the stop when it still lies in the band (as if the stop never happened)', () => {
    const d = decide(example(2, { restore: lowered }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 19])
    expect(d.step).toEqual({ dataDay: '2026-10-01', fromCents: 19, toCents: 19 })
    expect(d.why).toMatch(/^restore: the stop layer no longer applies → back to 19¢ from the 2¢ it held \(the bid before it: 19¢; in band: /)
  })
  it('a bid before it outside the band: one step from it toward the goal, never from the floor', () => {
    const d = decide(example(2, { restore: { ...lowered, beforeCents: 33 } }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 25])
    expect(d.step).toEqual({ dataDay: '2026-10-01', fromCents: 33, toCents: 25 })
    // A rerun on the same data day, now at 25¢, anchors on 33¢ as the goal path does (no second step).
    const again = decide(example(25, { lastStep: d.step }))
    expect([again.action, again.bidCents]).toEqual(['hold', 25])
  })
  it('a Min-bid hour that ended gives back the same way', () => {
    const d = decide(example(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 17 } }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 17])
  })
  it('no bid before it: the goal bid itself, unstepped, inside the limits', () => {
    const d = decide(example(2, { restore: { ...lowered, beforeCents: null } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 16])
    expect(d.why).toMatch(/→ the goal bid 16¢ \(no bid before it is known; /)
  })
  it('no bid before it and no goal: it stays, and says why', () => {
    const d = decide(example(2, { restore: { ...lowered, beforeCents: null }, goal: { target: null } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['hold', 'restore', 2])
    expect(d.why).toMatch(/there is no bid to give back .* it stays at 2¢ until a target or a bid is set/)
  })
  it('an override still in force decides first; a bid someone moved since is decided as usual', () => {
    expect(decide(example(2, { restore: lowered, overrides: { stop: { bidCents: 2, by: 'automation:budget' } } })).layer).toBe('stop')
    expect(decide(example(30, { restore: lowered })).layer).toBe('goal')
  })
  it('a freeze or a pin does not count as a stop to give back', () => {
    expect(decide(example(2, { restore: { layer: 'freeze', heldCents: 2, beforeCents: 19 } })).layer).not.toBe('restore')
  })
})

// ── The facts builder ────────────────────────────────────────────────────────────────────────────

const campaign = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra,
})
const group = (id: string, campaignId: string, extra: Partial<AdGroupRow> = {}): AdGroupRow => ({
  id, campaignId, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: ['famA'], ...extra,
})
const target = (id: string, adGroupId: string): TargetRow => ({ id, adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: id, bidCents: 20, suppressedFromBidCents: null })
const market = (extra: Partial<MarketRows> = {}): MarketRows => ({
  market: 'IT', dataDay: '2026-10-01',
  campaigns: new Map([['c1', campaign('c1')]]),
  adGroups: new Map([['g1', group('g1', 'c1')]]),
  targets: [target('t1', 'g1'), target('t2', 'g1')],
  evidence: new Map([['t1', ev(50, 1, 8000, 1250)], ['t2', ev(40)]]),
  prices: new Map([['famA', 8990]]),
  ...extra,
})
const run = (extra: Partial<RunRows> = {}): RunRows => ({
  marketBrakes: [],
  strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'LAUNCH', minBidCents: null, maxBidCents: 80, maxChangePct: 25, stopBidCents: 3, launchDay: 7 }]]),
  accountDefaultPct: null, personHeld: new Set(), holds: [], enrollments: new Map(), lastSteps: new Map(), ...extra,
})

describe('the facts builder reads the sources', () => {
  it('stock of the ad group → STOCK on each of its keywords; a retail-guard floor already in force keeps its words', () => {
    const stock = new Map([['g1', { kind: 'notBuyable' as const, stopBidCents: 3, by: 'out of stock (1 product)' }]])
    expect(buildFacts(market(), run({ stock }))[0].overrides?.stock).toEqual({ notBuyable: true, stopBidCents: 3, by: 'out of stock (1 product)' })
    const guarded = market({ campaigns: new Map([['c1', campaign('c1', { bidsSuppressedAt: new Date('2026-10-02T00:00:00Z'), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'automation:retail-guard' })]]) })
    expect(buildFacts(guarded, run({ stock }))[0].overrides?.stock).toEqual({ notBuyable: true, stopBidCents: 2, by: 'automation:retail-guard' })
  })

  it('the playbook: its PHASE floor on every keyword; a stopped one is a STOP unless a stop is already in force', () => {
    const notStarted = new Map([['c1', { kind: 'notStarted' as const, floorCents: 2, label: 'GALE IT' }]])
    expect(buildFacts(market(), run({ playbook: notStarted }))[0].overrides).toMatchObject({ phase: { notStarted: true, floorCents: 2 } })
    const stopped = new Map([['c1', { kind: 'stopped' as const, floorCents: 2, label: 'GALE IT' }]])
    expect(buildFacts(market(), run({ playbook: stopped }))[0].overrides?.stop).toEqual({ bidCents: 2, by: 'a playbook STOP (GALE IT)' })
  })

  it('an auto-undo hold freezes; a person’s hold pins and wins over it', () => {
    const undo = { campaignId: 'c1', targetId: null, kind: 'AUTO_UNDO', by: 'auto-undo', until: new Date('2026-10-05T00:00:00Z') }
    const facts = buildFacts(market(), run({ holds: [undo] }))
    expect(facts[0].overrides?.freeze).toEqual({ by: 'auto-undo until 2026-10-05' })
    expect(facts[0].overrides?.pin).toBeUndefined()
    const person = { campaignId: 'c1', targetId: 't1', kind: 'PERSON', by: 'user:u1', until: null }
    const both = buildFacts(market(), run({ holds: [undo, person] }))
    expect(both[0].overrides?.pin).toEqual({ by: 'person hold by user:u1', until: null })
  })

  it('a LAUNCH row’s day and the ad group’s break-even reach the goal; the keyword the brain lowered carries its restore', () => {
    const lowered = new Map([['t2', { layer: 'stop' as const, heldCents: 2, beforeCents: 18 }]])
    const facts = buildFacts(market(), run({ breakEven: new Map([['g1', 0.31]]), lowered }))
    expect(facts[0].goal).toMatchObject({ phase: 'LAUNCH', launchDay: 7, breakEvenAcos: 0.31 })
    expect(facts[0].restore).toBeNull()
    expect(facts[1].restore).toEqual({ layer: 'stop', heldCents: 2, beforeCents: 18 })
  })

  it('without any of it, nothing changes (no override, no restore, no break-even)', () => {
    const f = buildFacts(market(), run({ strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 80, maxChangePct: 25 }]]) }))[0]
    expect(f.overrides).toEqual({})
    expect(f.restore).toBeNull()
    expect(f.goal).toEqual({ target: { kind: 'ACOS', pct: 20 }, acosFallbackPct: 20, band: null, phase: 'PROFIT', breakEvenAcos: null })
  })
})

describe('a give-back that found no bid to go back to', () => {
  it('is tried again: once a goal is set, the keyword goes back to it', () => {
    const waiting = { layer: 'restore' as const, heldCents: 2, beforeCents: null }
    expect(decide(example(2, { restore: waiting, goal: { target: null } })).layer).toBe('restore')
    const d = decide(example(2, { restore: waiting }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 16])
    expect(d.why).toMatch(/^restore: the stop that lowered it no longer applies → the goal bid 16¢/)
  })
})
