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
import { decide, LOWERING_LAYERS, UNLOWERED_LAYERS, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import type { ShareFacts } from './share.js'

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

describe('batch 2 fix — the money brain\'s brake in the bid decision (hold raises, step down, floor)', () => {
  const BY = 'the money brake of product p-jacket (cut_bids: projected 102 % of its monthly budget, above 100 %)'

  it('hold raises: a raise waits with the brake named; a cut still goes', () => {
    const hold = 'the money brake of product p-jacket (hold_raises: projected 97 % of its monthly budget, above 95 %): no raises'
    const up = decide(example(10, { raiseCap: hold }))
    expect(up).toMatchObject({ action: 'hold', bidCents: 10 })
    expect(up.why).toMatch(/^goal: raise held — the money brake of product p-jacket \(hold_raises: projected 97 % .*\): no raises; 10¢ → \d+¢ waits/)
    const down = decide(example(40, { raiseCap: hold }))
    expect(down).toMatchObject({ action: 'write', layer: 'goal' })
    expect(down.bidCents).toBeLessThan(40)
  })

  it('step down: every keyword one step a data day (an in-band one too), the step recorded; a rerun on the same data day holds', () => {
    const first = decide(example(20, { overrides: { money: { stepPct: 10, by: BY } } }))
    expect(first).toMatchObject({ action: 'write', layer: 'money', bidCents: 18, step: { dataDay: '2026-09-29', fromCents: 20, toCents: 18 } })
    expect(first.why).toBe(`money: ${BY}: bids step down 10 % a day — 20¢ → 18¢`)
    const again = decide(example(18, { lastStep: first.step, overrides: { money: { stepPct: 10, by: BY } } }))
    expect(again).toMatchObject({ action: 'hold', layer: 'money', bidCents: 18 })
    expect(again.why).toMatch(/this data day's step, taken once/)
    // The next data day: one more step.
    expect(decide(example(18, { dataDay: '2026-09-30', lastStep: first.step, overrides: { money: { stepPct: 10, by: BY } } })).bidCents).toBe(16)
  })

  it('step down never below the limits; a goal that asks lower goes lower', () => {
    expect(decide(example(5, { overrides: { money: { stepPct: 10, by: BY } } })).bidCents).toBe(5) // the 5¢ engine floor
    const high = decide(example(60, { overrides: { money: { stepPct: 10, by: BY } } }))
    expect(high.bidCents).toBe(Math.min(54, high.goalBidCents!))
    expect(high.why).toMatch(/the goal asks lower/)
  })

  it('the override order holds: the Owner\'s pin holds against it; a lower floor (Min-bid hour, stock) wins; after a Min-bid hour the step is from the bid before, not the floor', () => {
    expect(decide(example(20, { overrides: { pin: { by: 'bids pinned by the Owner' }, money: { stepPct: 10, by: BY } } }))).toMatchObject({ action: 'hold', layer: 'pin', bidCents: 20 })
    expect(decide(example(20, { overrides: { minBidHour: { floorCents: 2 }, money: { stepPct: 10, by: BY } } }))).toMatchObject({ layer: 'min_bid_hour', bidCents: 2 })
    expect(decide(example(20, { overrides: { stock: { notBuyable: true, stopBidCents: 2, by: 'out of stock' }, money: { stepPct: 10, by: BY } } }))).toMatchObject({ layer: 'stock', bidCents: 2 })
    const after = decide(example(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 20 }, overrides: { money: { stepPct: 10, by: BY } } }))
    expect(after).toMatchObject({ action: 'write', layer: 'money', bidCents: 18, step: { fromCents: 20, toCents: 18 } })
  })

  it('floor (stop_weakest): one of the weakest campaigns takes the stop bid as a STOP — named — and is given back when it lifts', () => {
    const by = 'the money brake of product p-jacket (stop_weakest: projected 108 % of its monthly budget, above 105 %): one of its weakest campaigns stops until back on pace'
    const d = decide(example(20, { overrides: { stop: { bidCents: 3, by } } }))
    expect(d).toMatchObject({ action: 'write', layer: 'stop', bidCents: 3 })
    expect(d.why).toBe(`stop: stop by ${by} → 3¢`)
    expect(decide(example(3, { restore: { layer: 'stop', heldCents: 3, beforeCents: 20 } })).layer).toBe('restore')
  })

  it('OBSERVE (no brake in the facts): every decision exactly as before', () => {
    for (const c of [5, 10, 14, 19, 33, 60]) expect(decide(example(c, { overrides: {} }))).toEqual(decide(example(c)))
  })
})

/**
 * Lane 5 (2026-10-10) — the share layer: a target top-of-search impression share (D1 = A: raise below, lower above, hold
 * within ±5 points; the band top still cuts). In the worked example the band holds 15–22¢ and its top's bid is 22¢.
 */
describe('UNLOWERED_LAYERS — the bid a give-back returns to (integration review fix)', () => {
  it('a share move is an unlowered decision (a floor after it gives back its bid), and no layer is both', () => {
    expect(UNLOWERED_LAYERS).toContain('share')
    expect(UNLOWERED_LAYERS.filter((l) => LOWERING_LAYERS.includes(l))).toEqual([])
  })
})

describe('Lane 5 — the target top-of-search impression share', () => {
  const BY = 'the Owner\'s keyword override (user:owner, 2026-10-09)'
  const share = (pct: number, extra: Partial<ShareFacts> = {}): ShareFacts => ({
    targetPct: 40, targetBy: BY, reading: { pct, grain: 'keyword', days: 2, impressions: 300, from: '2026-09-27', to: '2026-09-28' }, held: null, waiting: false, lastMove: null, ...extra,
  })
  const READ = 'top-of-search impression share 20% (computed by Nexus: the impression-weighted average of Amazon\'s daily shares, keyword grain, 2 reading days 2026-09-27 to 2026-09-28, 300 impressions)'
  const whys: string[] = []
  const run = (f: TargetFacts) => { const d = decide(f); whys.push(d.why); return d }

  it('no target: every decision exactly as before', () => {
    for (const c of [5, 10, 14, 19, 33, 60]) expect(decide(example(c, { share: null }))).toEqual(decide(example(c)))
  })

  it('below target − 5 points: one step up (≤ 10 %), even in band; the step recorded', () => {
    const d = run(example(16, { share: share(20) }))
    expect(d).toMatchObject({ action: 'write', layer: 'share', bidCents: 18, step: { dataDay: '2026-09-29', fromCents: 16, toCents: 18 } })
    expect(d.why).toBe(`share: target top-of-search impression share 40% (${BY}): ${READ} is below the target by more than 5 points → raise ≤10%: 16¢ → 18¢ (expected ACoS ${d.expectedAcos != null ? `${Math.round(d.expectedAcos * 1000) / 10}%` : ''} at 16¢, band 18%–28%)`)
  })

  it('held to the band top\'s bid; at it, it holds and names the next lever (the placement %, only with the Owner\'s approval)', () => {
    const near = run(example(21, { share: share(20) }))
    expect(near).toMatchObject({ action: 'write', layer: 'share', bidCents: 22 })
    expect(near.why).toMatch(/held to the bid where the expected ACoS meets the band top 28%, 22¢; the next lever is the top-of-search placement %, only with your approval of the painted hourly plan/)
    const at = run(example(22, { share: share(20) }))
    expect(at).toMatchObject({ action: 'hold', layer: 'share', bidCents: 22 })
    expect(at.why).toMatch(/but 22¢ is at or above its cap \(the bid where the expected ACoS meets the band top 28%, 22¢\) — no raise; the next lever is the top-of-search placement %/)
  })

  it('held to the top-of-search lane: its CPC ceiling ÷ ((1 + plan %) × dynamic bidding)', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, planPct: 100, maxCpcCents: 40 }]
    const d = run(example(19, { share: share(20), lanes }))
    expect(d).toMatchObject({ action: 'write', layer: 'share', bidCents: 20 })
    expect(d.why).toMatch(/held to the top-of-search CPC ceiling 40¢ ÷ \(1 \+ 100 % placement\), 20¢/)
  })

  it('above target + 5 points: one step down; within ±5 points: hold', () => {
    expect(run(example(16, { share: share(60) }))).toMatchObject({ action: 'write', layer: 'share', bidCents: 14, step: { fromCents: 16, toCents: 14 } })
    const hold = run(example(14, { share: share(42) }))
    expect(hold).toMatchObject({ action: 'hold', layer: 'share', bidCents: 14 })
    expect(hold.why).toMatch(/is within 5 points of the target — no change/)
  })

  it('the band top wins: an ACoS above it goes to the goal (which lowers), the share\'s note said', () => {
    const d = run(example(33, { share: share(20) }))
    expect(d).toMatchObject({ action: 'write', layer: 'goal', bidCents: 25 })
    expect(d.why).toMatch(/ · share: target top-of-search impression share 40% \(.+\): no share move — the band top wins \(expected ACoS .+ at 33¢, band 18%–28%\); top-of-search impression share 20%/)
  })

  it('a reading that does not count moves nothing: the goal decides as without a target, the why says why the share held', () => {
    const held = share(20, { held: 'the newest reading day 2026-09-20 is 9 days old (at most 4)' })
    const d = run(example(14, { share: held }))
    const plain = decide(example(14))
    expect(d).toMatchObject({ action: plain.action, layer: plain.layer, bidCents: plain.bidCents })
    expect(d.why).toBe(`${plain.why} · share: target top-of-search impression share 40% (${BY}): no share move — the newest reading day 2026-09-20 is 9 days old (at most 4); ${READ}`)
    const none = run(example(19, { share: share(20, { reading: null, held: 'no top-of-search impression share reading — none at keyword grain, nor at campaign grain on a day the campaign served this keyword alone, in the 14 days 2026-09-15 to 2026-09-28' }) }))
    expect(none).toMatchObject({ action: 'hold', layer: 'band' })
    expect(none.why).toMatch(/· share: .+: no share move — no top-of-search impression share reading/)
  })

  it('right after its own move it waits: no other layer moves the bid (the band top excepted)', () => {
    const waiting = share(20, { waiting: true, held: 'waits for 2 reading days after its share move on 2026-09-28 (16¢ → 18¢) (0 so far)', reading: null, lastMove: { moveDay: '2026-09-28', dataDay: '2026-09-27', readingTo: '2026-09-26', fromCents: 16, toCents: 18 } })
    const d = run(example(14, { share: waiting }))
    expect(d).toMatchObject({ action: 'hold', layer: 'share', bidCents: 14 })
    expect(d.why).toMatch(/^share: target top-of-search impression share 40% .+: waits for 2 reading days after its share move on 2026-09-28/)
    expect(run(example(33, { share: waiting }))).toMatchObject({ layer: 'goal', action: 'write' })
  })

  it('the overrides, the limits and the raise cap decide first', () => {
    expect(decide(example(16, { share: share(20), overrides: { pin: { by: 'a person' } } }))).toMatchObject({ layer: 'pin', action: 'hold' })
    expect(decide(example(90, { share: share(20) }))).toMatchObject({ layer: 'limit', bidCents: 80 })
    expect(decide(example(16, { share: share(20), brakes: ['campaign paused'] }))).toMatchObject({ layer: 'brake' })
    const capped = run(example(16, { share: share(20), raiseCap: 'the campaign is held by user:owner' }))
    expect(capped).toMatchObject({ action: 'hold', layer: 'share', bidCents: 16, step: null })
    expect(capped.why).toMatch(/^share: raise held — the campaign is held by user:owner; 16¢ → 18¢ waits/)
    // A lowering is never held by the raise cap.
    expect(decide(example(16, { share: share(60), raiseCap: 'held' }))).toMatchObject({ action: 'write', layer: 'share', bidCents: 14 })
  })

  it('no line it writes calls the share a rank or a position', () => {
    expect(whys.filter((w) => w.includes('share:')).length).toBeGreaterThan(8)
    for (const w of whys) expect(w).not.toMatch(/rank|position/i)
  })
})
