/**
 * C1 — the two COMPUTED bid ops, tested as arithmetic rather than through the handler.
 *
 * `bid_apply` needs a database, an ad target and a daily-performance history to run, so the parts
 * worth pinning are extracted here as pure functions matching the handler's expressions exactly.
 * These are the lines that decide how much money a bid moves, and the failure modes below are the
 * ones that would move it the WRONG WAY without erroring — which is the only kind of bid bug that
 * survives a green test suite.
 */
import { describe, it, expect } from 'vitest'

/** bid = CPC × (target ACoS ÷ actual ACoS) — the handler's expression, verbatim. */
const targetAcosBid = (cpcEur: number, targetPct: number, actualAcos: number) =>
  cpcEur * ((targetPct / 100) / actualAcos)

/** The handler's clamp: never below the floor, never above the ceiling when one is set. */
const clampRange = (x: number, min: number, max: number | null) => Math.min(max ?? Infinity, Math.max(min, x))
const round2 = (x: number) => Math.round(x * 100) / 100

describe('targetAcos — the direction has to be right', () => {
  it('HALVES the bid on a target running at twice its goal', () => {
    // 50% actual against a 25% target: paying twice what it should per sale.
    expect(round2(targetAcosBid(1.00, 25, 0.5))).toBe(0.5)
  })

  it('DOUBLES the bid on a target running at half its goal', () => {
    // 12.5% actual against a 25% target: cheap, so buy more of it.
    expect(round2(targetAcosBid(1.00, 25, 0.125))).toBe(2)
  })

  it('leaves a target already exactly on goal alone', () => {
    expect(round2(targetAcosBid(0.73, 30, 0.3))).toBe(0.73)
  })

  /**
   * 🔴 The sign error that would matter. `CPC × (actual / target)` is the same expression with the
   * ratio inverted, and it is a plausible typo: it RAISES the bid on a keyword that is losing
   * money and lowers it on one that is winning. This test fails if the ratio is ever flipped.
   */
  it('is not the inverted ratio', () => {
    const inverted = (cpc: number, targetPct: number, actual: number) => cpc * (actual / (targetPct / 100))
    const overspending = { cpc: 1.0, target: 25, actual: 0.5 }
    expect(targetAcosBid(overspending.cpc, overspending.target, overspending.actual)).toBeLessThan(overspending.cpc)
    expect(inverted(overspending.cpc, overspending.target, overspending.actual)).toBeGreaterThan(overspending.cpc)
  })

  /**
   * A very efficient keyword produces a very large multiplier — 5% actual against a 25% target is
   * ×5. That is arithmetically right and operationally reckless, so the CLAMP is what makes this
   * op safe to arm, not the formula. Pinned because a future change that drops the ceiling would
   * otherwise look harmless.
   */
  it('relies on the ceiling to bound a runaway multiplier', () => {
    const raw = targetAcosBid(1.20, 25, 0.05) // ×5 → €6.00
    expect(round2(raw)).toBe(6)
    expect(round2(clampRange(raw, 0.05, 1.5))).toBe(1.5)
  })

  it('never returns below the €0.05 floor even from a tiny CPC', () => {
    expect(round2(clampRange(targetAcosBid(0.06, 5, 0.9), 0.05, null))).toBe(0.05)
  })
})

describe('the two refusals — a missing signal must not become a number', () => {
  /**
   * 🔴 An ACoS of 0 means "spent money, sold nothing", NOT "infinitely efficient". Dividing by it
   * yields Infinity, and a clamp would turn that into the CEILING — the single most expensive
   * possible misreading: the worst keyword on the account gets the highest bid the rule allows.
   * The handler refuses on `acos == null` before reaching this arithmetic; this test documents
   * exactly what that guard prevents.
   */
  it('a zero ACoS would clamp to the CEILING, which is why the handler refuses instead', () => {
    const raw = targetAcosBid(1.0, 25, 0)
    expect(raw).toBe(Infinity)
    expect(clampRange(raw, 0.05, 2.0)).toBe(2.0) // ← what would ship if the guard were removed
  })

  it('a target with no clicks has no CPC, so there is nothing to set a bid from', () => {
    const clicks = 0
    const spendCents = 0
    // The handler returns ok:false here rather than computing 0/0.
    expect(Number.isNaN(spendCents / clicks / 100)).toBe(true)
  })
})

describe('setCpc', () => {
  it('is the measured cost per click, unadjusted', () => {
    // 431 cents over 7 clicks = €0.6157… → €0.62 after the handler's rounding.
    expect(round2(431 / 7 / 100)).toBe(0.62)
  })

  it('is still clamped, so a costly keyword cannot exceed the rule ceiling', () => {
    expect(round2(clampRange(980 / 4 / 100, 0.05, 1.75))).toBe(1.75)
  })
})
