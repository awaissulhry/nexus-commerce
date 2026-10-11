/**
 * KAPI-B (2026-10-10, Bid page "keyword Auto + goal + max bid") — a person's own max for one keyword (brain settings
 * maxBidCents, ref target:<AdTarget.id>; facts.ts limits.keywordMaxCents) is never exceeded by the brain, on any tick and
 * in any layer: decide.ts holdToKeywordMax after every layer, and the hard ceilings before `no_goal` (hardCeilingOf), so a
 * new max acts on the next 15-minute tick — a run with no evidence — not only on the next run with evidence.
 *
 * The table: each row a layer that could set or remember a bid above the max (a goal raise, a give-back from a floor or
 * from a memo decided during it, auto-undo's pin, a stop / phase / Min-bid / stock floor set high, a freeze, the money and
 * intraday brakes, the plan's hour giving the brain's own bid back, the share layer, a rule's floor, a lowest bid above
 * the max, a raise cap), each decided on a run with evidence AND on a tick with none. A brake and a pin write nothing.
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decide, hardCeilingOf, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import { KEYWORD_MAX_WORDS, type Lane } from './recipe.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** A goal bid of about 16¢ at aim 20 %. */
const MEDIUM = [
  { level: 'target' as const, evidence: ev(1, 0, 0, 30) },
  { level: 'product' as const, evidence: ev(2300, 20, 162_300, 69_000) },
  { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
]
/** A strong keyword: its band-top bid far above today's. */
const STRONG = [
  { level: 'target' as const, evidence: ev(400, 20, 162_300, 2_000) },
  { level: 'product' as const, evidence: ev(2300, 60, 500_000, 20_000) },
  { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
]
const DAY = '2026-10-01'
const MAX = 20
const lanes = (cap: number, placementPct = 0): Lane[] => [{ lane: 'TOP_OF_SEARCH', planPct: placementPct, maxCpcCents: cap, baseCeilingCents: cap, dynamic: 1 }]
const share = { targetPct: 60, targetBy: 'Owner', reading: { pct: 30, grain: 'keyword', days: 3, impressions: 900, from: '2026-09-28', to: '2026-09-30' }, held: null, waiting: false, lastMove: null } as unknown as NonNullable<TargetFacts['share']>

function medium(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: MEDIUM, listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 200, maxChangePct: 25, keywordMaxCents: MAX }, ...extra,
  }
}
function strong(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return { ...medium(current), chain: STRONG, goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 80 }, phase: 'PROFIT' }, ...extra }
}
const giveBack = { dataDay: DAY, fromCents: 40, cents: 40, goalBidCents: 40, step: { dataDay: DAY, fromCents: 40, toCents: 40 }, why: 'the goal from 40¢' }

type Row = { name: string; facts: TargetFacts }
const rows: Row[] = [
  { name: 'goal raise from below the max (a strong keyword)', facts: strong(18) },
  { name: 'goal raise, 100 % largest change', facts: strong(18, { limits: { maxBidCents: 500, maxChangePct: 100, keywordMaxCents: MAX } }) },
  { name: 'today\'s bid above the max', facts: medium(30) },
  { name: 'in band above the max', facts: medium(30, { goal: { target: { kind: 'ACOS', pct: 60 }, band: { loPct: 10, hiPct: 90 }, phase: 'PROFIT' } }) },
  { name: 'give-back after a Min-bid hour, the bid before 40¢', facts: strong(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 40, foundCents: 40 } }) },
  { name: 'give-back after a stop from a memo decided during it at 40¢', facts: medium(2, { restore: { layer: 'stop', heldCents: 2, beforeCents: 40, foundCents: 40, giveBack } }) },
  { name: 'give-back under auto-undo\'s pin to the bid the floor found, 40¢', facts: medium(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 40, foundCents: 40 }, overrides: { pin: { by: 'auto-undo', soft: true } } }) },
  { name: 'a give-back that found no bid before: the goal bid itself', facts: strong(2, { restore: { layer: 'restore', heldCents: 2, beforeCents: null } }) },
  { name: 'a stop whose stop bid is set above the max', facts: medium(40, { overrides: { stop: { bidCents: 35, by: 'a test stop' } } }) },
  { name: 'a phase floor above the max', facts: medium(10, { overrides: { phase: { floorCents: 35, by: 'the launch phase' } } }) },
  { name: 'a Min-bid hour floor above the max', facts: medium(40, { overrides: { minBidHour: { floorCents: 30 } } }) },
  { name: 'not buyable at a stop bid above the max', facts: medium(40, { overrides: { stock: { notBuyable: true, stopBidCents: 30, by: 'out of stock' } } }) },
  { name: 'low stock cover on a strong keyword', facts: strong(40, { overrides: { stock: { coverFactor: 0.9, by: 'low stock' } } }) },
  { name: 'low stock cover lifting a floor, the bid before 40¢', facts: medium(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 40, foundCents: 40 }, overrides: { stock: { coverFactor: 0.9, by: 'low stock' } } }) },
  { name: 'auto-undo freeze at 30¢', facts: medium(30, { overrides: { freeze: { by: 'auto-undo' } } }) },
  { name: 'the money brake from 40¢', facts: medium(40, { overrides: { money: { stepPct: 10, by: 'the money brake' } } }) },
  { name: 'the intraday spend cut from 40¢', facts: medium(40, { overrides: { intraday: { factor: 0.9, by: 'the intraday spend brake' } } }) },
  { name: 'the intraday CPC cap above the max', facts: medium(40, { overrides: { intraday: { capCents: 30, by: 'the CPC spike brake' } } }) },
  { name: 'the plan\'s hour gives the brain\'s own 40¢ back (a 60¢ hour)', facts: medium(12, { lanes: lanes(60), hourWords: 'the plan at 14:00–16:00', planHeld: { cents: 12, fromCents: 40, beforeCents: 40 } }) },
  { name: 'the plan\'s hour above the max, nothing held', facts: strong(18, { lanes: lanes(150), hourWords: 'the plan at 14:00–16:00' }) },
  { name: 'the share layer raises (60 % target over a 30 % reading)', facts: strong(18, { share, lanes: lanes(150, 100) }) },
  { name: 'a rule\'s floor above the max', facts: medium(10, { directives: [{ kind: 'FLOOR', cents: 50, source: 'rule "floor"' }] }) },
  { name: 'a rule\'s share floor above the max', facts: strong(10, { directives: [{ kind: 'SHARE_FLOOR', cents: 50, source: 'rule "share"' }] }) },
  { name: 'the campaign\'s lowest bid above the max (the max wins: it spends less)', facts: medium(10, { limits: { maxBidCents: 200, maxChangePct: 25, campaignMinCents: 30, keywordMaxCents: MAX } }) },
  { name: 'a HELD campaign (raise cap) at 30¢', facts: strong(30, { raiseCap: 'the campaign is held' }) },
  { name: 'a Min-bid hour decided with evidence: its give-back memo', facts: strong(40, { overrides: { minBidHour: { floorCents: 2 } } }) },
]

const ALL = rows.flatMap((r) => [
  { ...r, name: `${r.name} — run with evidence` },
  { ...r, name: `${r.name} — tick with no evidence`, facts: { ...r.facts, chain: [] } },
])

describe('a person\'s keyword max is never exceeded by the brain, on any tick and any layer', () => {
  it.each(ALL)('$name', ({ facts }) => {
    const d = decide(facts)
    expect(d.bidCents).toBeLessThanOrEqual(MAX)
    if (d.action === 'write') expect(d.bidCents).toBeLessThanOrEqual(MAX)
    if (d.giveBack) expect(d.giveBack.cents).toBeLessThanOrEqual(MAX)
    if (d.giveBack?.step) expect(d.giveBack.step.toCents).toBeLessThanOrEqual(MAX)
    if (d.beforeHour != null) expect(d.beforeHour).toBeLessThanOrEqual(MAX)
    if (d.step) expect(d.step.toCents).toBeLessThanOrEqual(MAX)
  })

  it.each([
    { name: 'a pin (a person holds it)', facts: medium(40, { overrides: { pin: { by: 'a person' } } }), layer: 'pin' },
    { name: 'a brake (a paused campaign)', facts: medium(40, { brakes: ['campaign paused'] }), layer: 'brake' },
  ])('$name: nothing is written, the bid stays as he set it', ({ facts, layer }) => {
    for (const f of [facts, { ...facts, chain: [] }]) {
      const d = decide(f)
      expect(d.layer).toBe(layer)
      expect(d.action).not.toBe('write')
      expect(d.bidCents).toBe(40)
    }
  })

  it('a new max acts on the next tick: no evidence, today\'s 30¢ comes down to the max, named', () => {
    const d = decide(medium(30, { chain: [] }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'limit', MAX])
    expect(d.why).toBe(`limit: 30¢ is above ${KEYWORD_MAX_WORDS} (${MAX}¢) → ${MAX}¢ (no goal: no evidence to pool)`)
  })

  it('a hold above the max becomes the write down to it, named; a write above it keeps its layer and says the max held it', () => {
    const band = decide(medium(30, { goal: { target: { kind: 'ACOS', pct: 60 }, band: { loPct: 10, hiPct: 90 }, phase: 'PROFIT' } }))
    expect([band.action, band.layer, band.bidCents]).toEqual(['write', 'limit', MAX])
    const raise = decide(strong(18))
    expect(raise.layer).toBe('goal')
    // The goal's own clamp names it (limitRange): "held to Your max for this keyword".
    expect(raise.bidCents).toBe(MAX)
    expect(raise.why).toMatch(new RegExp(`held to ${KEYWORD_MAX_WORDS}; 18¢ → ${MAX}¢$`))
    // A floor above the max keeps its layer (its memory stays the floor's: the give-back after it).
    const phase = decide(medium(10, { overrides: { phase: { floorCents: 35, by: 'the launch phase' } } }))
    expect([phase.layer, phase.bidCents]).toEqual(['phase', MAX])
  })

  it('with no max of its own every decision is exactly what it was', () => {
    const plain = (f: TargetFacts): TargetFacts => ({ ...f, limits: { ...f.limits, keywordMaxCents: undefined } })
    for (const r of rows) {
      const { keywordMaxCents: _drop, ...limits } = r.facts.limits
      expect(decide(plain(r.facts))).toEqual(decide({ ...r.facts, limits }))
    }
  })
})

describe('the hard ceilings before no_goal (hardCeilingOf)', () => {
  it('the lowest of the strategy\'s and campaign\'s highest bid, the keyword\'s max and a rule\'s ceiling; null with none', () => {
    expect(hardCeilingOf({ limits: {} })).toBeNull()
    expect(hardCeilingOf({ limits: { maxBidCents: 80, campaignMaxCents: 60 } })).toEqual({ cents: 60, from: 'the campaign\'s highest bid' })
    expect(hardCeilingOf({ limits: { maxBidCents: 80, keywordMaxCents: 30 } })).toEqual({ cents: 30, from: KEYWORD_MAX_WORDS })
    expect(hardCeilingOf({ limits: { maxBidCents: 80 }, directives: [{ kind: 'CEILING', cents: 25, source: 'rule "cap"' }, { kind: 'FLOOR', cents: 5, source: 'rule "floor"' }] })).toEqual({ cents: 25, from: 'the ceiling of rule "cap"' })
  })

  it('a tick with no evidence brings a bid above the strategy\'s highest bid down; a bid under every ceiling is left alone', () => {
    const tick = (current: number) => decide({ ...medium(current, { chain: [] }), limits: { maxBidCents: 30, maxChangePct: 25 } })
    expect([tick(45).action, tick(45).layer, tick(45).bidCents]).toEqual(['write', 'limit', 30])
    expect(tick(45).why).toMatch(/^limit: 45¢ is above the strategy highest bid \(30¢\) → 30¢ \(no goal: no evidence to pool\)$/)
    expect([tick(25).action, tick(25).layer, tick(25).bidCents]).toEqual(['hold', 'no_goal', 25])
  })

  it('a ceiling under the lowest bid never cuts on a tick: the lowest bid wins, as on the goal path (no flip-flop)', () => {
    const ruleCap = [{ kind: 'CEILING' as const, cents: 8, source: 'rule "to floor"' }]
    const tick = (current: number) => decide({ ...medium(current, { chain: [] }), limits: { minBidCents: 20, maxChangePct: 25 }, directives: ruleCap })
    expect([tick(20).action, tick(20).layer, tick(20).bidCents]).toEqual(['hold', 'no_goal', 20])
    // Above the lowest bid it comes down to the lowest bid, never under it.
    expect([tick(30).action, tick(30).layer, tick(30).bidCents]).toEqual(['write', 'limit', 20])
    expect(tick(30).why).toMatch(/→ 20¢, held at the strategy lowest bid \(20¢\)/)
  })
})

describe('a person\'s own goal for the keyword (goalOwn): the aim, named in the why', () => {
  it('aims at his goal with the default band, and the why names it as his', () => {
    const f = strong(18, { goal: { target: { kind: 'ACOS', pct: 30 }, band: null, phase: null }, goalOwn: 'user:owner, 2026-10-10', limits: { maxBidCents: 200, maxChangePct: 25 } })
    const d = decide(f)
    expect(d.goal).toMatchObject({ aim: 0.3, lo: 0.27, hi: 0.345 })
    expect(d.why).toMatch(/aim 30% \(default band 27%–34\.5%\) \(Your goal for this keyword, user:owner, 2026-10-10\)/)
  })
})

describe('KAPI-B — a cut to the max is marked for the live writer (maxCut)', () => {
  it('a freeze at 30¢ cut to the max carries maxCut; a raise held to the max does not', () => {
    expect(decide(medium(30, { overrides: { freeze: { by: 'auto-undo' } } })).maxCut).toBe(true)
    expect(decide(strong(18)).maxCut).toBeUndefined()
    // The cut decideBid makes itself is a lowering limit write (the live writer's safety without the mark).
    expect(decide(medium(30)).layer).toBe('limit')
  })
})
