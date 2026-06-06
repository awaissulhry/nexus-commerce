import { describe, it, expect } from 'vitest'
import { effectiveSpec } from './ad-rank-defend.job.js'
import type { RankTargetSpec } from '../services/advertising/rank-controller.js'

// RD.5 — family guardrail target transform (pure). OOS/lost-buybox → pause (stop
// wasting spend); family over its ACOS cap → drop all-out so a must-win window
// still respects a profit ceiling.
const allOut: RankTargetSpec = { key: 'own-top-allout', placement: 'PLACEMENT_TOP', targetISPct: 90, acosCapPct: null, maxCpcCents: null, biasPct: 150, pause: false, allOut: true }
const ownTop: RankTargetSpec = { key: 'own-top', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45, maxCpcCents: null, biasPct: 100, pause: false, allOut: false }

describe('RD.5 effectiveSpec — family guardrails', () => {
  it('passes through unchanged with no flags', () => {
    expect(effectiveSpec(ownTop, {})).toEqual(ownTop)
  })
  it('OOS / lost-buybox forces pause', () => {
    expect(effectiveSpec(ownTop, { oos: true }).pause).toBe(true)
    expect(effectiveSpec(allOut, { oos: true }).pause).toBe(true)
  })
  it('family over ACOS drops all-out and applies the family cap when target has none', () => {
    const e = effectiveSpec(allOut, { overAcos: true, familyAcosCapPct: 30 })
    expect(e.allOut).toBe(false)
    expect(e.acosCapPct).toBe(30)
  })
  it('family over ACOS keeps the target ACOS cap if it already has one', () => {
    const withCap: RankTargetSpec = { ...allOut, acosCapPct: 50 }
    expect(effectiveSpec(withCap, { overAcos: true, familyAcosCapPct: 30 }).acosCapPct).toBe(50)
  })
  it('over ACOS leaves a non-all-out target unchanged', () => {
    expect(effectiveSpec(ownTop, { overAcos: true, familyAcosCapPct: 30 })).toEqual(ownTop)
  })
  it('OOS wins over the ACOS path', () => {
    expect(effectiveSpec(allOut, { oos: true, overAcos: true, familyAcosCapPct: 30 }).pause).toBe(true)
  })
})
