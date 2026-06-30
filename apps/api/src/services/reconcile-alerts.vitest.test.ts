import { describe, it, expect } from 'vitest'
import { reconcileDriftExceeds, cumulativeDriftBreaches, staleConflictCutoff } from './reconcile-alerts.js'

describe('reconcileDriftExceeds', () => {
  it('flags abs drift over the threshold, ignores null', () => {
    expect(reconcileDriftExceeds(12, 5)).toBe(true)
    expect(reconcileDriftExceeds(-12, 5)).toBe(true)
    expect(reconcileDriftExceeds(3, 5)).toBe(false)
    expect(reconcileDriftExceeds(5, 5)).toBe(false) // strict >
    expect(reconcileDriftExceeds(null, 5)).toBe(false)
  })
})
describe('cumulativeDriftBreaches', () => {
  it('flags strictly over the unit threshold', () => {
    expect(cumulativeDriftBreaches(11, 10)).toBe(true)
    expect(cumulativeDriftBreaches(10, 10)).toBe(false)
  })
})
describe('staleConflictCutoff', () => {
  it('returns now minus N days', () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z')
    expect(staleConflictCutoff(now, 3).toISOString()).toBe('2026-06-28T00:00:00.000Z')
  })
})
