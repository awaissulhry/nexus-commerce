/**
 * ADX G2 — bid-bound validation.
 *
 * The case that matters is the one-sided bulk update: "set max to 50" across a
 * selection is harmless until it lands on a campaign whose min is already 80, leaving
 * a campaign no engine can write to at all — every bid simultaneously below the floor
 * and above the ceiling. So a partial update is validated against what each campaign
 * ALREADY has, and a bulk update fails whole rather than half-applying.
 */
import { describe, it, expect } from 'vitest'
import { validateGuardrails, parseBound, MAX_BID_CENTS_CEILING } from './ads-guardrails.js'

const camp = (name: string, minBidCents: number | null, maxBidCents: number | null) =>
  ({ name, minBidCents, maxBidCents })

describe('parseBound', () => {
  it('undefined and null both mean "no value" — the caller distinguishes them', () => {
    expect(parseBound(undefined, 100)).toEqual({ value: null, error: null })
    expect(parseBound(null, 100)).toEqual({ value: null, error: null })
  })
  it('rejects negatives and non-numbers', () => {
    expect(parseBound(-1, 100).error).toBeTruthy()
    expect(parseBound('abc', 100).error).toBeTruthy()
  })
  it('rejects above the ceiling', () => {
    expect(parseBound(MAX_BID_CENTS_CEILING + 1, MAX_BID_CENTS_CEILING).error).toBeTruthy()
  })
  it('rounds to whole cents', () => {
    expect(parseBound(12.6, 100).value).toBe(13)
  })
  it('accepts zero — a legitimate floor', () => {
    expect(parseBound(0, 100)).toEqual({ value: 0, error: null })
  })
})

describe('validateGuardrails', () => {
  it('accepts a sane pair', () => {
    const r = validateGuardrails({ minBidCents: 5, maxBidCents: 200 }, [camp('A', null, null)])
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ minBidCents: 5, maxBidCents: 200 })
  })

  it('rejects min above max in the same request', () => {
    const r = validateGuardrails({ minBidCents: 300, maxBidCents: 200 }, [camp('A', null, null)])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('cannot exceed')
  })

  it('THE ONE-SIDED CASE: a max below an existing min is refused', () => {
    const r = validateGuardrails({ maxBidCents: 50 }, [camp('GALE BROAD DE', 80, null)])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('GALE BROAD DE')
  })

  it('a bulk update fails WHOLE if any single campaign would end up unwritable', () => {
    const r = validateGuardrails({ maxBidCents: 50 }, [
      camp('fine A', 10, null), camp('fine B', 20, null), camp('bad', 900, null),
    ])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('bad')
  })

  it('clearing a bound with null is allowed and recorded', () => {
    const r = validateGuardrails({ maxBidCents: null }, [camp('A', 80, 200)])
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ maxBidCents: null })
  })

  it('clearing the min lets an otherwise-conflicting max through', () => {
    const r = validateGuardrails({ minBidCents: null, maxBidCents: 50 }, [camp('A', 900, null)])
    expect(r.ok).toBe(true)
  })

  it('only supplied fields are written — an absent field is not cleared', () => {
    const r = validateGuardrails({ minBidCents: 5 }, [camp('A', null, 200)])
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ minBidCents: 5 })
    expect('maxBidCents' in r.data).toBe(false)
  })

  it('an empty patch is an error, not a silent no-op', () => {
    const r = validateGuardrails({}, [camp('A', null, null)])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no guardrail fields')
  })

  it('equal min and max is legal — pinning a bid exactly', () => {
    const r = validateGuardrails({ minBidCents: 50, maxBidCents: 50 }, [camp('A', null, null)])
    expect(r.ok).toBe(true)
  })
})
