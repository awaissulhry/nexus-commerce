/**
 * ADX A2 — evidence packing.
 *
 * The point of these two helpers is that a stored `evidence` value should never lie:
 * an empty object must not look like captured reasoning, and a decision resting on
 * thin data should be identifiable as such by query rather than by reading it.
 */
import { describe, it, expect } from 'vitest'
import { packEvidence, isThinEvidence } from './ads-evidence.js'

describe('packEvidence', () => {
  it('returns null for nothing — {} would masquerade as captured evidence', () => {
    expect(packEvidence(null)).toBeNull()
    expect(packEvidence(undefined)).toBeNull()
    expect(packEvidence({})).toBeNull()
    expect(packEvidence({ note: undefined, observed: null, metric: '' })).toBeNull()
  })

  it('keeps only the fields that carry information', () => {
    expect(packEvidence({ metric: 'acos', observed: 0.42, threshold: undefined, note: '' }))
      .toEqual({ metric: 'acos', observed: 0.42 })
  })

  it('keeps a zero — 0% impression share is a real observation, not a missing one', () => {
    expect(packEvidence({ observed: 0 })).toEqual({ observed: 0 })
  })

  it('carries the full shape through', () => {
    const e = {
      targetKey: 'own-top', metric: 'topOfSearchImpressionShare', observed: 31,
      threshold: 45, windowDays: 14, sampleSize: 3, sampleUnit: 'days' as const,
      note: 'rank — Top 150→300%',
    }
    expect(packEvidence(e)).toEqual(e)
  })
})

describe('isThinEvidence', () => {
  it('flags a decision resting on fewer days than the minimum', () => {
    // The real case: AMS coverage is per-campaign, and some schedules hold 1-5 days
    // where the account has 56. Such a decision should be distinguishable by query.
    expect(isThinEvidence({ sampleSize: 3, sampleUnit: 'days' }, 7)).toBe(true)
  })

  it('does not flag a well-evidenced decision', () => {
    expect(isThinEvidence({ sampleSize: 30, sampleUnit: 'days' }, 7)).toBe(false)
  })

  it('flags a windowed observation that matched zero rows', () => {
    expect(isThinEvidence({ windowDays: 14, sampleSize: 0, sampleUnit: 'rows' })).toBe(true)
  })

  it('says nothing about evidence that never claimed a sample size', () => {
    expect(isThinEvidence({ metric: 'acos', observed: 0.4 })).toBe(false)
    expect(isThinEvidence(null)).toBe(false)
  })
})
