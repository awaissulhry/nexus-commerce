/**
 * ADX A2 — evidence packing.
 *
 * The point of these two helpers is that a stored `evidence` value should never lie:
 * an empty object must not look like captured reasoning, and a decision resting on
 * thin data should be identifiable as such by query rather than by reading it.
 */
import { describe, it, expect } from 'vitest'
import { packEvidence, isThinEvidence, inBrainCycle, brainCycleStamp } from './ads-evidence.js'

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

describe('AB-14 — a product cycle\'s change set rides in the evidence of every write its step makes', () => {
  const stamp = { changeSetId: 'cyc-IT-2026-10-02-prod-1', step: 'money' }

  it('inside a step: stamped on the evidence, and on a write that had none', async () => {
    await inBrainCycle(stamp, async () => {
      expect(brainCycleStamp()).toEqual(stamp)
      await Promise.resolve() // across awaits, as a write path goes
      expect(packEvidence({ metric: 'dailyBudget', observed: 10 })).toEqual({ metric: 'dailyBudget', observed: 10, cycle: stamp })
      expect(packEvidence(null)).toEqual({ cycle: stamp })
    })
  })

  it('a stamp the caller set is kept; outside a step nothing changes', async () => {
    const own = { changeSetId: 'cyc-DE-2026-10-02-prod-2', step: 'bids' }
    await inBrainCycle(stamp, async () => expect(packEvidence({ note: 'x', cycle: own })).toEqual({ note: 'x', cycle: own }))
    expect(brainCycleStamp()).toBeNull()
    expect(packEvidence(null)).toBeNull()
    expect(packEvidence({ note: 'x' })).toEqual({ note: 'x' })
  })

  it('two steps at once keep their own change sets', async () => {
    const seen: string[] = []
    await Promise.all([
      inBrainCycle({ changeSetId: 'a', step: 'state' }, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(`a:${packEvidence(null)?.cycle?.changeSetId}`) }),
      inBrainCycle({ changeSetId: 'b', step: 'state' }, async () => { seen.push(`b:${packEvidence(null)?.cycle?.changeSetId}`) }),
    ])
    expect(seen.sort()).toEqual(['a:a', 'b:b'])
  })
})
