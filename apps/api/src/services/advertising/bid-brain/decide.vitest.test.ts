/**
 * BID BRAIN BB-1 — decide(facts): the recipe, the override order, idempotence and the design's worked example (§7).
 *
 *   §7         a product converting 0.87 % at an order value of about 81: aim 20 % in 18–28 % → goal bid ≈ 16¢; a bid whose
 *              expected ACoS is inside the band is left alone; outside it the brain steers back toward 16¢
 *   C3         one step per new data day toward the goal — 33 → 25 → 19 → 16¢ — and a rerun on the same evidence
 *              never compounds (33 → 25 → 19 → 14¢ in six hours was the bug)
 *   overrides  STOP ▸ PIN ▸ STOCK ▸ FREEZE ▸ PHASE ▸ MIN-BID HOUR; the lower bid wins, a pin is left alone unless a
 *              stop comes first; brakes before everything
 *   limits     strategy and campaign bounds, the 5¢ floor and a lane ceiling hold the bid; a floor above a ceiling
 *              loses and is named; placements stay inside the lane's CPC ceiling (C2)
 *   data       a thin keyword stays at its parent's bid until it has 2 orders; every decision says why
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** The §7 worked example's rates (counts are synthetic: the repo is public): CR 0.87 %, AOV 81.15, CPC 30¢. */
const PRODUCT = ev(2300, 20, 162_300, 69_000)

function example(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-giacca-moto-uomo',
    currentCents: current,
    dataDay: '2026-09-29',
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

describe('the worked example (design §7)', () => {
  it('asks a goal bid of about 16¢ and explains it', () => {
    const d = decide(example(14))
    expect(d.goalBidCents).toBe(16)
    expect(d.action).toBe('write')
    expect(d.layer).toBe('goal')
    expect(d.why).toMatch(/^goal: aim 20% \(band 18%–28%, PROFIT\); CR 0\.8\d% \(product, 2,300 clicks\) × AOV 8\d\.\d\d ÷ CPC\/bid 0\.88; goal bid 16¢/)
    expect(d.why).toMatch(/14¢ → 16¢$/)
  })

  it('leaves a bid alone whose expected ACoS is inside 18–28 % (15¢ … 22¢)', () => {
    for (const c of [15, 16, 19, 22]) {
      const d = decide(example(c))
      expect([c, d.action, d.layer, d.bidCents]).toEqual([c, 'hold', 'band', c])
      expect(d.why).toMatch(/^in band: expected ACoS/)
    }
  })

  it('steers from 33¢ one step per new data day: 33 → 25 → 19 → 16¢ (C3)', () => {
    let current = 33
    let lastStep: TargetFacts['lastStep'] = null
    const path = [current]
    for (const dataDay of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
      const d = decide(example(current, { dataDay, lastStep }))
      if (d.action === 'write') {
        lastStep = d.step
        current = d.bidCents
        path.push(current)
      }
    }
    expect(path).toEqual([33, 25, 19])
    // 19¢ is inside the band (23.6 %): no further move — the goal is 16¢ but the band leaves 19¢ alone.
    expect(decide(example(19)).layer).toBe('band')
  })

  it('never compounds on unchanged evidence: a rerun after its own step holds', () => {
    const first = decide(example(33))
    expect([first.action, first.bidCents]).toEqual(['write', 25])
    for (let i = 0; i < 5; i++) {
      const again = decide(example(25, { lastStep: first.step }))
      expect([again.action, again.layer, again.bidCents]).toEqual(['hold', 'goal', 25])
      expect(again.why).toMatch(/already moved for data day 2026-09-29/)
    }
  })

  it('is idempotent: the same facts give the same decision', () => {
    const facts = example(33)
    expect(decide(facts)).toEqual(decide(structuredClone(facts)))
  })
})

describe('override order', () => {
  it('runs brakes before everything', () => {
    const d = decide(example(33, { brakes: ['campaign paused'], overrides: { stop: { bidCents: 2, by: 'budget' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['brake', 'brake', 33])
    expect(d.why).toBe('brake: campaign paused — nothing written')
  })

  it('a stop beats a pin; a pin beats stock, freeze, phase and Min-bid hours', () => {
    const stop = decide(example(33, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' }, pin: { by: 'user:owner' } } }))
    expect([stop.action, stop.layer, stop.bidCents]).toEqual(['write', 'stop', 2])
    const pin = decide(example(33, { overrides: { pin: { by: 'user:owner', until: '2026-12-06' }, stock: { notBuyable: true, stopBidCents: 2, by: 'retail guard' }, minBidHour: { floorCents: 2 } } }))
    expect([pin.action, pin.layer, pin.bidCents]).toEqual(['hold', 'pin', 33])
    expect(pin.why).toBe('pin: held by user:owner until 2026-12-06 — left alone')
  })

  it('names the first layer and takes the lower bid when several apply', () => {
    const d = decide(example(33, { overrides: { stock: { coverFactor: 0.5, by: 'stock cover' }, minBidHour: { floorCents: 3 } } }))
    expect(d.layer).toBe('stock')
    expect(d.bidCents).toBe(3)
    expect(d.why).toMatch(/also: low stock cover/)
  })

  it('low cover scales the goal bid; not buyable stops; a freeze allows no raise but lowers', () => {
    expect(decide(example(33, { overrides: { stock: { coverFactor: 0.5, by: 'stock' } } })).bidCents).toBe(Math.round(25 * 0.5))
    expect(decide(example(33, { overrides: { stock: { notBuyable: true, stopBidCents: 2, by: 'retail guard' } } })).bidCents).toBe(2)
    expect(decide(example(10, { overrides: { freeze: { by: 'auto-undo' } } })).bidCents).toBe(10)
    expect(decide(example(33, { overrides: { freeze: { by: 'auto-undo' } } })).bidCents).toBe(25)
  })

  it('a playbook not started floors; a stop already in place holds', () => {
    expect(decide(example(33, { overrides: { phase: { notStarted: true, floorCents: 2 } } })).bidCents).toBe(2)
    const held = decide(example(2, { overrides: { stop: { bidCents: 2, by: 'budget' } } }))
    expect([held.action, held.layer]).toEqual(['hold', 'stop'])
  })
})

describe('limits and inputs', () => {
  it('holds the bid to the strategy highest bid, and brings a bid outside a limit back', () => {
    const d = decide(example(90, { limits: { maxBidCents: 80, maxChangePct: 25 } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'limit', 80])
    const low = decide(example(16, { limits: { minBidCents: 20 } }))
    expect([low.action, low.layer, low.bidCents]).toEqual(['write', 'limit', 20])
  })

  it('never writes below the 5¢ engine floor, and the base bid never exceeds a lane ceiling (C2)', () => {
    const tiny = decide(example(40, { goal: { target: { kind: 'ACOS', pct: 2 } }, limits: { maxChangePct: 100 } }))
    expect(tiny.bidCents).toBeGreaterThanOrEqual(5)
    const lane = decide(example(60, { goal: { target: { kind: 'ACOS', pct: 60 }, band: { loPct: 55, hiPct: 65 } }, limits: {}, lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: 45 }] }))
    expect(lane.bidCents).toBeLessThanOrEqual(45)
    expect(lane.placements[0]).toMatchObject({ lane: 'TOP_OF_SEARCH', planPct: 150, pct: 0 })
  })

  it('caps a placement so bid × (1 + p) stays inside the lane CPC ceiling', () => {
    const d = decide(example(14, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 55 }, { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: null }] }))
    const tos = d.placements.find((p) => p.lane === 'TOP_OF_SEARCH')!
    expect(d.bidCents * (1 + tos.pct / 100)).toBeLessThanOrEqual(55)
    expect(tos.held).toMatch(/CPC ceiling 55¢/)
    expect(d.placements.find((p) => p.lane === 'PRODUCT_PAGE')!.pct).toBe(50)
  })

  it('takes the lowest ceiling and the highest floor; a floor above a ceiling loses and is named', () => {
    const d = decide(example(14, { directives: [{ kind: 'CEILING', cents: 12, source: 'rule:A' }, { kind: 'FLOOR', cents: 15, source: 'rule:B' }] }))
    expect(d.bidCents).toBe(12)
    expect(d.clash).toBe('rule:B floor 15¢ is above rule:A ceiling 12¢ — the ceiling wins')
  })

  it('scales the goal bid by the hour factor', () => {
    expect(decide(example(5, { hourFactor: 0.5, limits: { maxChangePct: 100 } })).goalBidCents).toBe(8)
  })
})

describe('minimum data', () => {
  const rich = (orders: number, clicks = 120): TargetFacts => example(16, {
    chain: [
      { level: 'target', evidence: ev(clicks, orders, orders * 8000, clicks * 14) },
      { level: 'product', evidence: PRODUCT },
    ],
    limits: { maxChangePct: 100 },
  })

  it('holds a keyword with fewer than 2 orders at its parent’s bid', () => {
    // 1 order in 30 clicks reads above the product's rate, but one order earns no raise.
    const one = decide(rich(1, 30))
    expect(one.goalBidCents).toBeLessThanOrEqual(17)
    expect(one.why).toMatch(/held at the parent's bid \(one order of its own\)/)
  })

  it('lets a keyword with orders of its own rise above its parent, held where the cautious ACoS meets the band top', () => {
    const many = decide(rich(6))
    expect(many.goalBidCents!).toBeGreaterThan(17)
    expect(many.why).toMatch(/raise held where the cautious ACoS meets the band top/)
  })

  it('says why it holds without a goal or an order value', () => {
    const none = decide(example(20, { goal: { target: null } }))
    expect([none.action, none.layer]).toEqual(['hold', 'no_goal'])
    expect(none.why).toBe('no goal: no target ACoS in the ads strategy — left alone')
    const noValue = decide(example(20, { chain: [{ level: 'market', evidence: ev(50) }], listPriceCents: null }))
    expect(noValue.why).toMatch(/no order value known/)
  })
})
