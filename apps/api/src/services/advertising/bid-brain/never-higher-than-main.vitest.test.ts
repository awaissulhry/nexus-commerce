/**
 * Final review 10-10 — with the per-hour plan ceiling (Owner decision A) a bid is never higher than before it (origin/main,
 * where the keyword bid held the day's lowest ceiling all day), except:
 *   (a) the goal's give-back after a floor, inside every hold
 *   (b) a higher hour's ceiling, up to the brain's own bid, when nothing holds
 *   (s) the share layer, up to this hour's ceiling (Owner decision A, expected)
 * Each row: the reviewer's case (scratchpad rev2/m1–m5), the bid origin/main decided for it, and the exception it may use.
 * The fixes behind it: an override's hold (a freeze, the money brake after its step, low stock cover on a tick with no
 * evidence) never becomes the plan's raise (1); every brake bites from min(the bid, this hour's ceiling), from the bid that
 * stands (2); the give-back keeps the hour's lanes, so the share layer's top-of-search lane cap holds (3).
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import type { Lane } from './recipe.js'

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
const lanes = (cap: number, placementPct = 0): Lane[] => [{ lane: 'TOP_OF_SEARCH', planPct: placementPct, maxCpcCents: cap, baseCeilingCents: cap, dynamic: 1 }]
const share = { targetPct: 60, targetBy: 'Owner', reading: { pct: 30, grain: 'keyword', days: 3, impressions: 900, from: '2026-09-28', to: '2026-09-30' }, held: null, waiting: false, lastMove: null } as unknown as NonNullable<TargetFacts['share']>
function medium(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: MEDIUM, listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 }, hourWords: 'the plan at 14:00–16:00', ...extra,
  }
}
function strong(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return { ...medium(current), chain: STRONG, goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 80 }, phase: 'PROFIT' }, limits: { maxBidCents: 200, maxChangePct: 25 }, share, ...extra }
}
/** The plan held the brain's own 16¢ at 12¢ an hour ago; this hour allows 40¢. */
const HELD = { cents: 12, fromCents: 16, beforeCents: 16 }

type Row = { name: string; facts: TargetFacts; main: number; allow?: { why: 'a' | 'b' | 's'; upTo: number } }
const rows: Row[] = [
  // m4 — an override's hold at a higher hour (1)
  { name: 'm4 freeze (auto-undo), run with evidence', facts: medium(12, { lanes: lanes(40), planHeld: HELD, overrides: { freeze: { by: 'auto-undo' } } }), main: 12 },
  { name: 'm4 freeze (auto-undo), tick', facts: medium(12, { chain: [], lanes: lanes(40), planHeld: HELD, overrides: { freeze: { by: 'auto-undo' } } }), main: 12 },
  { name: 'm4 money brake 10 %, run with evidence', facts: medium(12, { lanes: lanes(40), planHeld: HELD, overrides: { money: { stepPct: 10, by: 'money brake' } } }), main: 11 },
  { name: 'm4 money brake 10 %, tick', facts: medium(12, { chain: [], lanes: lanes(40), planHeld: HELD, overrides: { money: { stepPct: 10, by: 'money brake' } } }), main: 11 },
  { name: 'm4 nothing holds, run with evidence', facts: medium(12, { lanes: lanes(40), planHeld: HELD }), main: 12, allow: { why: 'b', upTo: 16 } },
  { name: 'm4 nothing holds, tick', facts: medium(12, { chain: [], lanes: lanes(40), planHeld: HELD }), main: 12, allow: { why: 'b', upTo: 16 } },
  // m5 — low stock cover and the money brake after its step
  { name: 'm5 low stock ×0.7 at a 12¢ hour, run with evidence', facts: medium(12, { lanes: lanes(12), planHeld: HELD, overrides: { stock: { coverFactor: 0.7, by: 'low stock' } } }), main: 8 },
  { name: 'm5 low stock ×0.7 at a 40¢ hour, tick with no evidence', facts: medium(12, { chain: [], lanes: lanes(40), planHeld: HELD, overrides: { stock: { coverFactor: 0.7, by: 'low stock' } } }), main: 12 },
  // On origin/main this day's step was clamped by the day's 12¢ ceiling (16¢ → 12¢) and then held: 12¢.
  { name: 'm5 money brake, this data day\'s step taken (16¢ → 14¢), 40¢ hour, tick', facts: medium(12, { chain: [], lanes: lanes(40), planHeld: { cents: 12, fromCents: 12, beforeCents: 14 }, lastStep: { dataDay: DAY, fromCents: 16, toCents: 14 }, overrides: { money: { stepPct: 10, by: 'money brake' } } }), main: 12 },
  // (2) — low stock cover bites under the hour's ceiling
  { name: 'low stock ×0.9 at a 10¢ hour, from 16¢', facts: medium(16, { lanes: lanes(10), overrides: { stock: { coverFactor: 0.9, by: 'low stock' } } }), main: 9 },
  // m2 / m3 — the share layer (3)
  { name: 'm2 share raise, 60¢ hour and day', facts: strong(28, { lanes: lanes(60, 100) }), main: 30 },
  { name: 'm2 share raise, 60¢ hour (day\'s lowest 20¢)', facts: strong(10, { lanes: lanes(60, 100) }), main: 10, allow: { why: 's', upTo: 60 } },
  { name: 'm2 give-back on a full run (share, 100 % top of search: its lane cap)', facts: strong(2, { lanes: lanes(60, 100), restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 28, foundCents: 28 } }), main: 30 },
  { name: 'm3 share at 40¢, a 150¢ hour (day\'s lowest 40¢)', facts: strong(40, { lanes: lanes(150) }), main: 40, allow: { why: 's', upTo: 150 } },
  { name: 'm3 share at 60¢, a 150¢ hour', facts: strong(60, { lanes: lanes(150) }), main: 40, allow: { why: 's', upTo: 150 } },
]

describe('never higher than origin/main, except (a) the goal\'s give-back within every hold and (b) a higher hour up to the own bid when nothing holds', () => {
  it.each(rows)('$name', ({ facts, main, allow }) => {
    const d = decide(facts)
    expect(d.bidCents).toBeLessThanOrEqual(allow ? Math.max(main, allow.upTo) : main)
    if (allow?.why === 'b') expect(d.layer).toBe('plan_hour')
  })

  it('m2 — the give-back on the tick that lifts the floor: the goal\'s (share) bid decided with evidence (a), never above it', () => {
    const restore = { layer: 'min_bid_hour' as const, heldCents: 2, beforeCents: 28, foundCents: 28 }
    const floor = decide(strong(28, { lanes: lanes(60, 100), overrides: { minBidHour: { floorCents: 2 } } }))
    expect(floor.giveBack?.cents).toBe(30)
    const tick = decide(strong(2, { chain: [], share: undefined, lanes: lanes(60, 100), restore: { ...restore, giveBack: floor.giveBack } }))
    expect([tick.layer, tick.bidCents]).toEqual(['restore', 30]) // origin/main: 28¢ (no goal on that tick); (a) up to 30¢
  })

  // m1 — a day of alternating 12¢ and 40¢ hours, five days, each brake against origin/main's bids tick by tick.
  const sim = (overrides: TargetFacts['overrides']) => {
    let cur = 12
    let planHeld: TargetFacts['planHeld'] = HELD
    let lastStep: TargetFacts['lastStep'] = null
    const bids: number[] = []
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
      for (const cap of [12, 40]) {
        const d = decide(medium(cur, { dataDay: day, lanes: lanes(cap), planHeld, lastStep, overrides }))
        lastStep = d.step ?? (lastStep && lastStep.dataDay === day ? lastStep : null)
        planHeld = d.beforeHour != null ? { cents: d.bidCents, fromCents: d.currentCents, beforeCents: d.beforeHour } : null
        if (d.action === 'write') cur = d.bidCents
        bids.push(cur)
      }
    }
    return bids
  }
  it.each([
    ['m1 money brake 10 % a day', { money: { stepPct: 10, by: 'money brake' } }, [11, 11, 10, 10, 9, 9, 8, 8, 7, 7]],
    ['m1 intraday spend brake ×0.85', { intraday: { factor: 0.85, by: 'spend brake' } }, [10, 8, 6, 5, 5, 5, 5, 5, 5, 5]],
    ['m1 low stock cover ×0.9', { stock: { coverFactor: 0.9, by: 'low stock' } }, [11, 11, 11, 11, 11, 11, 11, 11, 11, 11]],
  ] as Array<[string, TargetFacts['overrides'], number[]]>)('%s: tick by tick, never above origin/main', (_name, overrides, main) => {
    const bids = sim(overrides)
    bids.forEach((b, i) => expect(b, `tick ${i}`).toBeLessThanOrEqual(main[i]))
  })
})
