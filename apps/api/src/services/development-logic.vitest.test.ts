/**
 * PD.11 — verifier cases for the development-pipeline rules.
 */

import { describe, it, expect } from 'vitest'
import { eurToCents, requiredCertsBlocking, pickCheapest } from './development-logic.js'

describe('eurToCents', () => {
  it('parses a euro amount to integer cents', () => {
    expect(eurToCents('42.50')).toBe(4250)
    expect(eurToCents(10)).toBe(1000)
  })
  it('returns null for empty / null / non-numeric', () => {
    expect(eurToCents('')).toBeNull()
    expect(eurToCents(null)).toBeNull()
    expect(eurToCents(undefined)).toBeNull()
    expect(eurToCents('abc')).toBeNull()
  })
  it('rounds to the nearest cent', () => {
    expect(eurToCents('1.99')).toBe(199)
    expect(eurToCents('1.01')).toBe(101)
    expect(eurToCents('0.4')).toBe(40)
  })
})

describe('requiredCertsBlocking (launch gate)', () => {
  it('counts required, non-approved certs', () => {
    expect(requiredCertsBlocking([
      { required: true, status: 'APPROVED' },
      { required: true, status: 'PENDING' },
      { required: true, status: 'IN_PROGRESS' },
    ])).toBe(2)
  })
  it('ignores non-required certs', () => {
    expect(requiredCertsBlocking([
      { required: false, status: 'PENDING' },
      { required: true, status: 'APPROVED' },
    ])).toBe(0)
  })
  it('is 0 when all required are approved (launchable)', () => {
    expect(requiredCertsBlocking([
      { required: true, status: 'APPROVED' },
      { required: false, status: 'REJECTED' },
    ])).toBe(0)
  })
  it('is 0 for an empty cert list', () => {
    expect(requiredCertsBlocking([])).toBe(0)
  })
})

describe('pickCheapest (sourcing)', () => {
  it('picks the lowest quoted cost', () => {
    const c = pickCheapest([
      { id: 'a', quotedCostCents: 5000 },
      { id: 'b', quotedCostCents: 3000 },
      { id: 'c', quotedCostCents: null },
    ])
    expect(c?.id).toBe('b')
  })
  it('returns null when no candidate has a quote', () => {
    expect(pickCheapest([{ id: 'a', quotedCostCents: null }])).toBeNull()
    expect(pickCheapest([])).toBeNull()
  })
})
