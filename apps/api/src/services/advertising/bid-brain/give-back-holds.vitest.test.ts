/**
 * Review fix 10-10 (1) — the give-back after a floor obeys the holds of the tick that lifts it.
 *
 * A give-back is exempt from the raise cap (it puts back the bid the floor found), so the goal's raise it carries from the
 * run with evidence (`giveBack`, a step above the bid before) passed every hold of the lifting tick: a HELD campaign
 * (auto-undo's hold too), the spend guard, the money brake's hold, low stock cover (no goal on that tick, so nothing), a
 * rule's ceiling set since the run with evidence, an intraday brake. Now each binds: a raise cap or an intraday brake
 * gives back at most the bid before; a ceiling (the rule's, the intraday CPC cap) binds; low stock cover gives back the bid
 * before × its factor.
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { decide, type GiveBack, type TargetFacts } from './decide.js'

const DAY = '2026-10-01'
/** The run with evidence decided a give-back of 15¢ from the bid before, 12¢ (one goal step up). */
const memo: GiveBack = { dataDay: DAY, fromCents: 12, cents: 15, goalBidCents: 16, step: { dataDay: DAY, fromCents: 12, toCents: 15 }, why: 'goal: test raise' }
/** The 15-minute tick that lifts the night floor: no evidence, the bid at the 2¢ floor. */
function lifting(extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: 2, dataDay: DAY, chain: [], listPriceCents: 8990,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 12, foundCents: 12, giveBack: memo },
    ...extra,
  }
}

describe('the give-back obeys the lifting tick\'s holds', () => {
  it('no hold: the goal\'s 15¢ (the raise decided with evidence)', () => {
    expect(decide(lifting())).toMatchObject({ layer: 'restore', bidCents: 15 })
  })

  it('a HELD campaign (auto-undo\'s hold), the spend guard, the money brake\'s hold: back to the bid before, 12¢, and why', () => {
    for (const raiseCap of ['the campaign is held by auto-undo until 2026-10-20', 'this hour\'s spend heads above 1.5 × its usual', 'the money brake (hold_raises): no raises']) {
      const d = decide(lifting({ raiseCap }))
      expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 12])
      expect(d.why).toContain(`15¢ no raise above the bid before it: ${raiseCap}`)
      // The day's step was not taken: the next run with evidence may still take it.
      expect(d.step).toEqual({ dataDay: DAY, fromCents: 12, toCents: 12 })
    }
  })

  it('low stock cover ×0.5 on a tick with no goal: the bid before × the factor, 6¢ — not the whole bid back', () => {
    const d = decide(lifting({ overrides: { stock: { coverFactor: 0.5, by: 'low stock: 2 days of cover against a 14-day line' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'stock', 6])
    expect(d.why).toMatch(/the bid before it 12¢ ×0\.5 \(no goal this run\)/)
    // The next tick, still short: it stays (the bid before × the factor again, never cut again from 6¢).
    const next = decide(lifting({ currentCents: 6, overrides: { stock: { coverFactor: 0.5, by: 'low stock' } }, restore: { layer: 'stock', heldCents: 6, beforeCents: 12, foundCents: 12 } }))
    expect([next.action, next.bidCents]).toEqual(['hold', 6])
  })

  it('a rule\'s ceiling of 10¢ set since the run with evidence binds: 10¢', () => {
    const d = decide(lifting({ directives: [{ kind: 'CEILING', cents: 10, source: 'rule "lower bids on clicks without sales"' }] }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 10])
    expect(d.why).toContain('held to 10¢ by rule "lower bids on clicks without sales"')
  })

  it('an intraday CPC cap binds; an intraday spend brake gives back at most the bid before', () => {
    expect(decide(lifting({ overrides: { intraday: { capCents: 13, by: 'intraday CPC spike' } } })).bidCents).toBe(13)
    expect(decide(lifting({ overrides: { intraday: { factor: 0.9, by: 'intraday spend: cut' } } })).bidCents).toBeLessThanOrEqual(12)
  })

  it('under auto-undo\'s pin the bid before is the pinned one: a HELD campaign still gets the bid the floor found back', () => {
    // The newest decision the brain did not lower is the cut auto-undo put back (12¢); the floor found the pinned 15¢.
    const d = decide(lifting({ raiseCap: 'the campaign is held by auto-undo until 2026-10-20', overrides: { pin: { by: 'auto-undo pin by automation:auto-undo', soft: true } }, restore: { layer: 'stop', heldCents: 2, beforeCents: 12, foundCents: 15 } }))
    expect([d.action, d.layer, d.bidCents, d.restoreBeforeCents]).toEqual(['write', 'restore', 15, 15])
  })
})
