/**
 * ALA Phase 4 — listing-issues mirror pure helpers. The DB upsert/resolve path
 * is integration-tested separately; here we lock the fingerprint + severity
 * normalisation that drive dedup and lifecycle.
 */
import { describe, it, expect } from 'vitest'
import { fingerprintIssue, normalizeSeverity } from './listing-issues.service.js'

describe('fingerprintIssue', () => {
  it('is stable regardless of attributeNames order', () => {
    expect(fingerprintIssue('90220', ['color', 'size'])).toBe(fingerprintIssue('90220', ['size', 'color']))
  })
  it('distinguishes same code on different attributes', () => {
    expect(fingerprintIssue('90220', ['color'])).not.toBe(fingerprintIssue('90220', ['size']))
  })
  it('handles missing/empty attributeNames', () => {
    expect(fingerprintIssue('5000')).toBe('5000::')
    expect(fingerprintIssue('5000', [])).toBe('5000::')
  })
})

describe('normalizeSeverity', () => {
  it('passes through known severities (any case)', () => {
    expect(normalizeSeverity('error')).toBe('ERROR')
    expect(normalizeSeverity('WARNING')).toBe('WARNING')
    expect(normalizeSeverity('Info')).toBe('INFO')
  })
  it('defaults unknown/blank to ERROR (fail-safe)', () => {
    expect(normalizeSeverity(undefined)).toBe('ERROR')
    expect(normalizeSeverity('')).toBe('ERROR')
    expect(normalizeSeverity('CRITICAL')).toBe('ERROR')
  })
})
