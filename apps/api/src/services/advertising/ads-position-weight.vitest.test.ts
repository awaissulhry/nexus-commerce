import { describe, it, expect } from 'vitest'
import {
  FALLBACK_REST_WEIGHT,
  resolveRestWeight,
  topMixOf,
  positionMultiplier,
  resolvePositionBasis,
  positionWeightedScore,
} from './ads-position-weight.js'

/**
 * ACR.2.2b. Every test here is about one hazard: a number meaning UNMEASURED being rendered as
 * a number meaning ZERO. On this board that mistake reads as "we never reach the top of the
 * page", which is a conclusion an operator would act on.
 */

describe('resolveRestWeight', () => {
  it("reproduces the account's measured ratio (IT/90d, 2026-08-05)", () => {
    // top 3.784% CTR, rest 0.482% CTR → rest is worth ~0.127 of a top slot.
    const r = resolveRestWeight({
      topImpressions: 37_712, topClicks: 1427,
      restImpressions: 377_052, restClicks: 1817,
    })
    expect(r.basis).toBe('measured')
    expect(r.restWeight).toBeCloseTo(0.127, 2)
  })

  it('falls back rather than computing 0 when the top slot has impressions but no clicks', () => {
    // The hazard: 0 clicks / 40k impressions is a real CTR of 0, and dividing by it would
    // declare every rest-of-search impression worthless on the strength of no evidence.
    const r = resolveRestWeight({
      topImpressions: 40_000, topClicks: 0,
      restImpressions: 10_000, restClicks: 50,
    })
    expect(r.basis).toBe('fallback')
    expect(r.restWeight).toBe(FALLBACK_REST_WEIGHT)
  })

  it('falls back when there is no placement traffic at all', () => {
    const r = resolveRestWeight({ topImpressions: 0, topClicks: 0, restImpressions: 0, restClicks: 0 })
    expect(r.basis).toBe('fallback')
    expect(r.topCtr).toBeNull()
    expect(r.restCtr).toBeNull()
  })

  it('clamps to 1 when rest out-converts top — an artefact, not a reason to prefer the bottom', () => {
    const r = resolveRestWeight({
      topImpressions: 1000, topClicks: 10,
      restImpressions: 1000, restClicks: 500,
    })
    expect(r.restWeight).toBe(1)
  })
})

describe('topMixOf', () => {
  it('is null, not 0, when we bought no search impressions', () => {
    expect(topMixOf(0, 0)).toBeNull()
  })
  it('is 0 when we bought impressions and none reached the top — a real measured zero', () => {
    expect(topMixOf(0, 5000)).toBe(0)
  })
  it('splits normally', () => {
    expect(topMixOf(5345, 33_694)).toBeCloseTo(0.1369, 4)
  })
})

describe('positionMultiplier', () => {
  it('is 1.0 when every impression is top-of-search', () => {
    expect(positionMultiplier(1, 0.127)).toBe(1)
  })
  it('collapses to the rest weight when none is', () => {
    expect(positionMultiplier(0, 0.127)).toBeCloseTo(0.127, 6)
  })
  it('is monotonic in top mix', () => {
    const a = positionMultiplier(0.1, 0.127)
    const b = positionMultiplier(0.5, 0.127)
    expect(b).toBeGreaterThan(a)
  })
})

describe('resolvePositionBasis', () => {
  it('an unmeasured week outranks every other reason', () => {
    expect(resolvePositionBasis({ share: null, hasHoldingCampaign: true, topMix: 0.5 }))
      .toBe('unmeasured-week')
  })
  it('a term no campaign holds is organic — position is unobservable, not zero', () => {
    expect(resolvePositionBasis({ share: 0.02, hasHoldingCampaign: false, topMix: null }))
      .toBe('no-holding-campaign')
  })
  it('held but with no paid impressions in the window is its own reason', () => {
    expect(resolvePositionBasis({ share: 0.02, hasHoldingCampaign: true, topMix: null }))
      .toBe('no-paid-impressions')
  })
  it('measured when share, a holding campaign and a top mix all exist', () => {
    expect(resolvePositionBasis({ share: 0.02, hasHoldingCampaign: true, topMix: 0.14 }))
      .toBe('measured')
  })
})

describe('positionWeightedScore', () => {
  it('reproduces the live head term (giacca moto estiva uomo, week 2026-07-19)', () => {
    // share 1.8804%, top mix 13.69%, rest weight 0.127 → 0.464%
    const s = positionWeightedScore({
      share: 0.018804408810381337, topMix: 0.13691436768359846,
      restWeight: 0.12728293687477046, basis: 'measured',
    })
    expect(s).toBeCloseTo(0.004640, 5)
  })

  it('is always below share while any impression sits off the top', () => {
    const share = 0.0188
    const s = positionWeightedScore({ share, topMix: 0.137, restWeight: 0.127, basis: 'measured' })!
    expect(s).toBeLessThan(share)
  })

  it.each([
    ['no-holding-campaign', 'no-holding-campaign'],
    ['no-paid-impressions', 'no-paid-impressions'],
    ['unmeasured-week', 'unmeasured-week'],
  ] as const)('returns null (never a fallback number) when basis is %s', (_label, basis) => {
    expect(positionWeightedScore({ share: 0.02, topMix: 0.5, restWeight: 0.127, basis }))
      .toBeNull()
  })

  it('does not silently score a term we do not bid as if it sat at the bottom of the page', () => {
    // The tempting bug: treat "no holding campaign" as topMix 0 and return share × restWeight.
    // That would print a confident 0.25% for a term whose page position we have never observed.
    const basis = resolvePositionBasis({ share: 0.02, hasHoldingCampaign: false, topMix: null })
    expect(positionWeightedScore({ share: 0.02, topMix: null, restWeight: 0.127, basis })).toBeNull()
  })
})
