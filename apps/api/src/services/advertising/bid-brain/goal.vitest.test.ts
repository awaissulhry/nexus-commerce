/**
 * BID BRAIN BB-1 — the goal resolver.
 *
 *   band     a set band with its aim (the pilot's, Owner 10-07: 18–28 % aiming at 20 %); a single target → −10 %/+15 %
 *   TACoS    × total ÷ ad sales, the ratio held to 1–5, the aim capped at break-even; no sales → the ACoS fallback
 *   profit   break-even caps the band top; LAUNCH may reach 1.5 × break-even
 *   phase    PROFIT keeps the aim, GROW the band top, LAUNCH ramps down to the top, CLEAR_STOCK = break-even + saving,
 *            DEFEND brand terms at the top
 *   season   up (D > 1.15 and V > 1.1) halfway to the top, down (D < 0.85) halfway to the bottom, unknown = neutral
 */
import { describe, expect, it } from 'vitest'
import { isGoal, resolveGoal, type Goal, type GoalInputs, type GoalRefusal } from './goal.js'

const ok = (input: GoalInputs): Goal => {
  const g = resolveGoal(input)
  if (!isGoal(g)) throw new Error((g as GoalRefusal).reason)
  return g
}

describe('band', () => {
  it('keeps a set band around its aim (18–28 % aiming at 20 %)', () => {
    const g = ok({ target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' })
    expect([g.aim, g.lo, g.hi, g.bandFrom]).toEqual([0.2, 0.18, 0.28, 'band'])
  })

  it('turns a single target into −10 % / +15 % around it (20 % → 18–23 %)', () => {
    const g = ok({ target: { kind: 'ACOS', pct: 20 } })
    expect([g.aim, g.lo, g.hi, g.bandFrom]).toEqual([0.2, 0.18, 0.23, 'single'])
  })

  it('aims at the middle of a band without a target, and refuses nothing at all', () => {
    expect(ok({ target: null, band: { loPct: 10, hiPct: 30 } }).aim).toBe(0.2)
    expect(resolveGoal({ target: null })).toEqual({ ok: false, reason: 'no target ACoS in the ads strategy' })
  })
})

describe('TACoS', () => {
  it('converts by total ÷ ad sales, the ratio held to 1–5', () => {
    const g = ok({ target: { kind: 'TACOS', pct: 8 }, sales: { totalCents: 250_000, adCents: 100_000 } })
    expect(g.aim).toBeCloseTo(0.2)
    expect(g.kind).toBe('TACOS')
    expect(ok({ target: { kind: 'TACOS', pct: 8 }, sales: { totalCents: 10_000_000, adCents: 100_000 } }).aim).toBeCloseTo(0.4)
    expect(ok({ target: { kind: 'TACOS', pct: 8 }, sales: { totalCents: 50_000, adCents: 100_000 } }).aim).toBeCloseTo(0.08)
  })

  it('is capped at break-even', () => {
    const g = ok({ target: { kind: 'TACOS', pct: 10 }, sales: { totalCents: 400_000, adCents: 100_000 }, breakEvenAcos: 0.3 })
    expect(g.hi).toBeCloseTo(0.3)
    expect(g.aim).toBeCloseTo(0.3)
  })

  it('falls back to the next ACoS target without sales data, or says why not', () => {
    const g = ok({ target: { kind: 'TACOS', pct: 8 }, acosFallbackPct: 25, sales: null })
    expect(g.aim).toBe(0.25)
    expect(g.notes.join()).toMatch(/without sales data/)
    expect(resolveGoal({ target: { kind: 'TACOS', pct: 8 } }).ok).toBe(false)
  })
})

describe('profit and phase', () => {
  const band = { target: { kind: 'ACOS' as const, pct: 20 }, band: { loPct: 18, hiPct: 28 } }

  it('caps the band top at break-even', () => {
    const g = ok({ ...band, breakEvenAcos: 0.25 })
    expect([g.aim, g.hi]).toEqual([0.2, 0.25])
    const tight = ok({ ...band, breakEvenAcos: 0.15 })
    expect([tight.aim, tight.lo, tight.hi]).toEqual([0.15, 0.15, 0.15])
  })

  it('GROW aims at the top; PROFIT keeps the aim', () => {
    expect(ok({ ...band, phase: 'GROW' }).aim).toBe(0.28)
    expect(ok({ ...band, phase: 'PROFIT' }).aim).toBe(0.2)
  })

  it('LAUNCH ramps from 1.5 × break-even down to the band top', () => {
    expect(ok({ ...band, phase: 'LAUNCH', breakEvenAcos: 0.3, launchDay: 0 }).aim).toBeCloseTo(0.45)
    expect(ok({ ...band, phase: 'LAUNCH', breakEvenAcos: 0.3, launchDay: 14 }).aim).toBeCloseTo((0.28 + 0.45) / 2)
    expect(ok({ ...band, phase: 'LAUNCH', breakEvenAcos: 0.3, launchDay: 40 }).aim).toBeCloseTo(0.28)
    expect(ok({ ...band, phase: 'LAUNCH' }).aim).toBe(0.28)
  })

  it('CLEAR_STOCK spends break-even plus the storage saving; DEFEND puts brand terms at the top', () => {
    expect(ok({ ...band, phase: 'CLEAR_STOCK', breakEvenAcos: 0.3, storageSavingAcos: 0.05 }).aim).toBeCloseTo(0.35)
    expect(ok({ ...band, phase: 'DEFEND', brandTerm: true }).aim).toBe(0.28)
    expect(ok({ ...band, phase: 'DEFEND' }).aim).toBe(0.2)
  })
})

describe('season', () => {
  const band = { target: { kind: 'ACOS' as const, pct: 20 }, band: { loPct: 18, hiPct: 28 } }
  it('moves halfway to the top on rising demand and sales, halfway to the bottom on falling demand', () => {
    expect(ok({ ...band, season: { demand: 1.2, velocity: 1.2 } }).aim).toBeCloseTo(0.24)
    expect(ok({ ...band, season: { demand: 1.2, velocity: 1 } }).aim).toBe(0.2)
    expect(ok({ ...band, season: { demand: 0.8, velocity: null } }).aim).toBeCloseTo(0.19)
  })

  it('is neutral and says so when demand is unknown (SQP stale)', () => {
    const g = ok({ ...band, season: { demand: null, velocity: 1.3 } })
    expect(g.aim).toBe(0.2)
    expect(g.notes).toContain('season: demand unknown')
  })
})
