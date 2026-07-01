/**
 * Task 3 — eBay failure isolation unit tests.
 *
 * Tests the pure `ebayFailureDecision` helper that drives circuit-breaker and
 * retry decisions in `syncToEbay`'s `ebayFail` closure.
 *
 * Invariants under test:
 *   - Validation statuses (400/404/409/422) with isolation ON:
 *       record=false (don't trip circuit), retryable=false, code=EBAY_VALIDATION
 *   - Transient statuses (401/403/429/500/503/null) with isolation ON:
 *       record=true (trip circuit), retryable=true, code=EBAY_TRANSIENT
 *   - Any status with isolation OFF (kill-switch='0'):
 *       record=true (always trip), retryable=true, code unchanged
 */
import { describe, it, expect } from 'vitest'
import { ebayFailureDecision } from './outbound-sync.service.js'

// ── Isolation ON (default behavior) ──────────────────────────────────────────

describe('ebayFailureDecision — isolation ON', () => {
  const ON = true

  it('400 → EBAY_VALIDATION: does NOT record toward circuit, non-retryable', () => {
    expect(ebayFailureDecision(400, ON)).toEqual({
      record: false,
      retryable: false,
      code: 'EBAY_VALIDATION',
    })
  })

  it('404 (no offer / not found) → EBAY_VALIDATION: no circuit, non-retryable', () => {
    expect(ebayFailureDecision(404, ON)).toEqual({
      record: false,
      retryable: false,
      code: 'EBAY_VALIDATION',
    })
  })

  it('409 (conflict) → EBAY_VALIDATION: no circuit, non-retryable', () => {
    expect(ebayFailureDecision(409, ON)).toEqual({
      record: false,
      retryable: false,
      code: 'EBAY_VALIDATION',
    })
  })

  it('422 (unprocessable entity) → EBAY_VALIDATION: no circuit, non-retryable', () => {
    expect(ebayFailureDecision(422, ON)).toEqual({
      record: false,
      retryable: false,
      code: 'EBAY_VALIDATION',
    })
  })

  it('401 (auth) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(401, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('403 (forbidden) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(403, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('429 (rate-limited) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(429, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('500 (server error) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(500, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('503 (service unavailable) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(503, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('null (network/timeout) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(null, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })

  it('undefined (called without status) → EBAY_TRANSIENT: records toward circuit, retryable', () => {
    expect(ebayFailureDecision(undefined, ON)).toEqual({
      record: true,
      retryable: true,
      code: 'EBAY_TRANSIENT',
    })
  })
})

// ── Isolation OFF (kill-switch NEXUS_EBAY_FAILURE_ISOLATION='0') ──────────────

describe('ebayFailureDecision — isolation OFF (kill-switch)', () => {
  const OFF = false

  it('400 validation status: still records toward circuit (pre-Task-3 compat)', () => {
    const r = ebayFailureDecision(400, OFF)
    expect(r.record).toBe(true)
    expect(r.retryable).toBe(true)
    // code is still correct, just not acted upon differently
    expect(r.code).toBe('EBAY_VALIDATION')
  })

  it('404 validation status: still records toward circuit', () => {
    const r = ebayFailureDecision(404, OFF)
    expect(r.record).toBe(true)
    expect(r.retryable).toBe(true)
  })

  it('422 validation status: still records toward circuit', () => {
    const r = ebayFailureDecision(422, OFF)
    expect(r.record).toBe(true)
    expect(r.retryable).toBe(true)
  })

  it('500 transient: records toward circuit as before', () => {
    const r = ebayFailureDecision(500, OFF)
    expect(r.record).toBe(true)
    expect(r.retryable).toBe(true)
    expect(r.code).toBe('EBAY_TRANSIENT')
  })

  it('null: records toward circuit as before', () => {
    const r = ebayFailureDecision(null, OFF)
    expect(r.record).toBe(true)
    expect(r.retryable).toBe(true)
  })
})
