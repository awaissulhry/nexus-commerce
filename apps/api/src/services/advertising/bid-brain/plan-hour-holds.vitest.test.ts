/**
 * Re-review 10-10 — the per-hour plan ceiling and the brain's holds (A–D and the minors), each with the reviewer's numbers.
 *
 *   A   low stock cover never lifts a bid above the hour's ceiling: only a brake and a pin pass the hour, and the ceiling
 *       never raises a bid (a floor below it stays the floor)
 *   B   a floor does not let a raise through: the give-back measures from the bid that STOOD (the floor found it), not from
 *       the brain's own bid the plan held it below — a HELD campaign gets 12¢ back, not 16¢; above it, a forward move
 *   C   a held raise does not ratchet the brain's own bid: the memory never rises above the own bid it had (25¢ stays 25¢
 *       over held full runs, not 31 → 39 → 49 → 61 → 76¢ and one write 15 → 60¢ when the hold lifts)
 *   D   an intraday brake only lowers (NEXUS_BID_BRAIN_INTRADAY=on): decided from the brain's own bid, it never lifts the bid
 *       the plan holds lower (12¢ stays 12¢, not own 16¢ × 0.9 = 14¢), nor a give-back above the bid that stood
 *   dead zone  it holds small raises only: a ceiling below the bid always pulls it down (16¢ under 15¢, 60¢ under 58¢)
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import type { Lane } from './recipe.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** A goal bid of about 16¢ at aim 20 % (overrides.vitest.test.ts's rates). */
const CHAIN = [
  { level: 'target' as const, evidence: ev(1, 0, 0, 30) },
  { level: 'product' as const, evidence: ev(2300, 20, 162_300, 69_000) },
  { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
]
const DAY = '2026-10-01'
const lanes = (c: number): Lane[] => [{ lane: 'TOP_OF_SEARCH', planPct: 100, maxCpcCents: c, baseCeilingCents: c, dynamic: 1 }]
function facts(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: CHAIN, listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 }, hourWords: 'the plan at 14:00–16:00', ...extra,
  }
}

describe('A — low stock cover under the hour\'s ceiling', () => {
  it('16¢ under a 10¢ ceiling with cover ×0.9: 9¢ (the factor bites under the ceiling, final review 2), not 14¢', () => {
    const d = decide(facts(16, { lanes: lanes(10), overrides: { stock: { coverFactor: 0.9, by: 'low stock' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'stock', 9])
    expect(decide(facts(30, { lanes: lanes(10), overrides: { stock: { coverFactor: 0.8, by: 'low stock' } } })).bidCents).toBe(8)
    // Held at the plan's 10¢ (own 16¢): the cover bites from the ceiling (9¢), never lifts it to 14¢.
    expect(decide(facts(10, { lanes: lanes(10), planHeld: { cents: 10, fromCents: 16, beforeCents: 16 }, overrides: { stock: { coverFactor: 0.9, by: 'low stock' } } })).bidCents).toBe(9)
  })
  it('the ceiling never raises a bid: a 3¢ stop under a ceiling below the 5¢ engine floor stays 3¢', () => {
    const d = decide(facts(20, { lanes: lanes(2), overrides: { stop: { bidCents: 3, by: 'a test stop' } } }))
    expect([d.layer, d.bidCents]).toEqual(['stop', 3])
  })
})

describe('B — the give-back measures from the bid that stood', () => {
  // Evening: the plan held the brain's own 16¢ at 12¢; the night floor found 12¢; morning, the hour allows 40¢.
  const restore = { layer: 'min_bid_hour' as const, heldCents: 2, beforeCents: 16, foundCents: 12 }
  it('a HELD campaign (auto-undo\'s hold): back to the 12¢ that stood, on the tick and on a full run; 16¢ remembered', () => {
    for (const chain of [[], CHAIN]) {
      const d = decide(facts(2, { chain, lanes: lanes(40), raiseCap: 'the campaign is held by auto-undo until 2026-10-20', restore }))
      expect([d.action, d.layer, d.bidCents, d.restoreBeforeCents, d.beforeHour]).toEqual(['write', 'restore', 12, 12, 16])
    }
  })
  it('no hold: back to the brain\'s own 16¢ — a raise above the 12¢ that stood, so a forward move', () => {
    const d = decide(facts(2, { chain: [], lanes: lanes(40), restore }))
    expect([d.layer, d.bidCents, d.restoreBeforeCents]).toEqual(['restore', 16, 12])
  })
})

describe('C — a held raise does not ratchet the brain\'s own bid', () => {
  /** A strong keyword: its goal is far above today's bid. */
  const STRONG = [
    { level: 'target' as const, evidence: ev(400, 20, 162_300, 2_000) },
    { level: 'product' as const, evidence: ev(2300, 60, 500_000, 20_000) },
    { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
  ]
  it('25¢ own, held at 15¢: full runs under a HELD campaign keep 25¢; when the hold lifts the plan gives back 25¢', () => {
    let cur = 20
    let planHeld: TargetFacts['planHeld'] = null
    let lastStep: TargetFacts['lastStep'] = null
    const run = (day: string, cap: number, raiseCap: string | null, evidence: boolean) => {
      const d = decide(facts(cur, { dataDay: day, chain: evidence ? STRONG : [], lanes: lanes(cap), ...(raiseCap ? { raiseCap } : {}), planHeld, lastStep }))
      lastStep = d.step ?? (lastStep && lastStep.dataDay === d.dataDay ? lastStep : null)
      planHeld = d.beforeHour != null ? { cents: d.bidCents, fromCents: d.currentCents, beforeCents: d.beforeHour } : null
      if (d.action === 'write') cur = d.bidCents
      return d
    }
    expect(run('2026-10-01', 15, null, true)).toMatchObject({ bidCents: 15, beforeHour: 25 })
    for (const day of ['2026-10-02', '2026-10-02', '2026-10-02', '2026-10-03']) {
      expect(run(day, 60, 'the campaign is held by auto-undo until 2026-10-20', true)).toMatchObject({ action: 'hold', bidCents: 15, beforeHour: 25 })
    }
    expect(run('2026-10-03', 60, null, false)).toMatchObject({ action: 'write', layer: 'plan_hour', bidCents: 25 })
  })
})

describe('D — an intraday brake only lowers', () => {
  const held = { cents: 12, fromCents: 16, beforeCents: 16 }
  it('the plan holds 12¢ (own 16¢), a spend brake ×0.9: it bites from the 12¢ that stands (10¢), HELD or not — never 14¢', () => {
    for (const raiseCap of [undefined, 'the campaign is held by auto-undo until 2026-10-20']) {
      const d = decide(facts(12, { chain: [], lanes: lanes(40), planHeld: held, ...(raiseCap ? { raiseCap } : {}), overrides: { intraday: { factor: 0.9, by: 'intraday spend: cut' } } }))
      expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'intraday', 10])
    }
  })
  it('after the night floor the brake gives back at most the bid that stood (12¢), not own 16¢ × 0.9', () => {
    const d = decide(facts(2, { chain: [], lanes: lanes(40), restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 16, foundCents: 12 }, overrides: { intraday: { factor: 0.9, by: 'intraday spend: cut' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'intraday', 12])
  })
  it('a brake that lowers still lowers', () => {
    const d = decide(facts(16, { chain: [], lanes: lanes(40), overrides: { intraday: { factor: 0.9, by: 'intraday spend: cut' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'intraday', 14])
  })
})

describe('the dead zone never leaves a bid above the ceiling', () => {
  it('16¢ under a 15¢ ceiling, 60¢ under 58¢: pulled down, however small the move', () => {
    expect(decide(facts(16, { chain: [], lanes: lanes(15) }))).toMatchObject({ action: 'write', layer: 'plan_hour', bidCents: 15 })
    expect(decide(facts(60, { chain: [], lanes: lanes(58) }))).toMatchObject({ action: 'write', layer: 'plan_hour', bidCents: 58 })
  })
  it('a small raise back toward the own bid still waits', () => {
    expect(decide(facts(15, { chain: [], lanes: lanes(40), planHeld: { cents: 15, fromCents: 16, beforeCents: 16 } }))).toMatchObject({ action: 'hold', bidCents: 15 })
  })
})

describe('D — the money brake\'s step down only lowers too', () => {
  it('the plan holds 12¢ (own 16¢): the money brake steps 10 % from the 12¢ that stands (11¢), never 16¢ → 14¢', () => {
    const d = decide(facts(12, { chain: [], lanes: lanes(40), planHeld: { cents: 12, fromCents: 16, beforeCents: 16 }, overrides: { money: { stepPct: 10, by: 'the money brake (cut_bids)' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'money', 11])
  })
  it('a money step that lowers still lowers', () => {
    expect(decide(facts(20, { chain: [], overrides: { money: { stepPct: 10, by: 'the money brake (cut_bids)' } } }))).toMatchObject({ action: 'write', layer: 'money', bidCents: 18 })
  })
})

