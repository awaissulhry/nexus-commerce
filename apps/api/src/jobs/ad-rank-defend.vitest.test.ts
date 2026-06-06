import { describe, it, expect } from 'vitest'
import { effectiveSpec, applyTargetOverrides } from './ad-rank-defend.job.js'
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

// RTC — per-scope override merge (pure). Effective = global ⊕ product ⊕ campaign,
// most-specific (later map) wins, only the fields the override provides.
describe('RTC applyTargetOverrides — per-scope merge', () => {
  it('passes through when no override matches the spec key', () => {
    expect(applyTargetOverrides(ownTop, { 'defend-top': { biasPct: 70 } })).toEqual(ownTop)
  })
  it('applies only the provided fields, leaving the rest', () => {
    const e = applyTargetOverrides(ownTop, { 'own-top': { biasPct: 130, maxCpcCents: 80 } })
    expect(e.biasPct).toBe(130)
    expect(e.maxCpcCents).toBe(80)
    expect(e.targetISPct).toBe(70)
  })
  it('campaign override (later map) wins over product', () => {
    expect(applyTargetOverrides(ownTop, { 'own-top': { biasPct: 120 } }, { 'own-top': { biasPct: 200 } }).biasPct).toBe(200)
  })
  it('ignores null/undefined maps and treats 0 as a real override', () => {
    expect(applyTargetOverrides(ownTop, null, undefined).biasPct).toBe(100)
    expect(applyTargetOverrides(ownTop, { 'own-top': { biasPct: 0 } }).biasPct).toBe(0)
  })
})
