/**
 * ACR.3 — the coverage ladder, pinned. The order of the guards IS the policy:
 * caps outrank coverage, waste outranks share, and a controller with no setpoint
 * or no measurement holds still.
 */
import { describe, it, expect } from 'vitest'
import { decideBidStep } from './ads-coverage-engine.service.js'

const base = {
  currentBidCents: 40,
  share: 0.01, // 1%
  targetSharePct: 3,
  acos30d: 0.25,
  familyAcosCapPct: 40,
  maxCpcCents: 80,
  familyDailyCapBreached: false,
  spend30dCents: 500,
  sales30dCents: 2_000,
}

describe('the share ladder', () => {
  it('steps up when share is below target and every cap has room', () => {
    const d = decideBidStep(base)
    expect(d.action).toBe('up')
    expect(d.nextBidCents).toBe(45) // 40 × 1.12
    expect(d.reason).toContain('below target')
  })

  it('decays when the target is held — the point is the cheapest bid that still holds', () => {
    const d = decideBidStep({ ...base, share: 0.05 }) // 5% vs 3% target
    expect(d.action).toBe('down')
    expect(d.nextBidCents).toBe(38) // 40 × 0.94, rounded
    expect(d.reason).toContain('decaying')
  })

  it('never steps past the term ceiling', () => {
    const d = decideBidStep({ ...base, currentBidCents: 78 })
    expect(d.nextBidCents).toBeLessThanOrEqual(80)
  })

  it('holds at the ceiling rather than pretending to climb', () => {
    const d = decideBidStep({ ...base, currentBidCents: 80 })
    expect(d.action).toBe('hold')
    expect(d.reason).toContain('ceiling')
  })

  it('never decays below the 5¢ floor', () => {
    const d = decideBidStep({ ...base, share: 0.05, currentBidCents: 5 })
    expect(d.action).toBe('hold')
    expect(d.nextBidCents).toBe(5)
  })
})

describe('caps outrank coverage — the order of the guards is the policy', () => {
  it('ACOS over the family cap steps DOWN even when share is short', () => {
    const d = decideBidStep({ ...base, acos30d: 0.55 }) // 55% vs 40% cap
    expect(d.action).toBe('down')
    expect(d.reason).toContain('over the family cap')
  })

  it('a spent family daily cap blocks ups but is stated, not silent', () => {
    const d = decideBidStep({ ...base, familyDailyCapBreached: true })
    expect(d.action).toBe('hold')
    expect(d.reason).toContain('daily cap is spent')
  })

  it('real spend with zero sales steps down regardless of the share gap', () => {
    const d = decideBidStep({ ...base, sales30dCents: 0, spend30dCents: 2_500, acos30d: null })
    expect(d.action).toBe('down')
    expect(d.reason).toContain('no sales')
  })
})

describe('a controller with no setpoint or no measurement holds still', () => {
  it('no target share set → hold, with the reason', () => {
    const d = decideBidStep({ ...base, targetSharePct: null })
    expect(d.action).toBe('hold')
    expect(d.reason).toContain('no target share')
  })

  it('unmeasured week → hold — no ground truth, no movement', () => {
    const d = decideBidStep({ ...base, share: null })
    expect(d.action).toBe('hold')
    expect(d.reason).toContain('unmeasured')
  })

  it('a term with no ceiling still gets one — never unbounded (the ACR.1.4 rule)', () => {
    const d = decideBidStep({ ...base, maxCpcCents: null, currentBidCents: 115 })
    expect(d.nextBidCents).toBeLessThanOrEqual(120) // the default ceiling
  })
})
