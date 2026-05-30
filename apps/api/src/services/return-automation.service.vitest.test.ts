/**
 * RX.8 — verifier cases for the returns auto-approve decision.
 *
 * classifyAutoApprove is the single source of truth the guardrailed
 * automation engine (RX.4) uses to decide whether a REQUESTED return is
 * eligible for hands-off approval. These pin the gate ordering and the
 * boundary conditions so the "never auto-approve the wrong return"
 * contract can't silently regress.
 */

import { describe, it, expect } from 'vitest'
import { classifyAutoApprove } from './return-automation.service.js'

const base = {
  isFbaReturn: false,
  policyAutoApprove: true,
  hasDeliveryDate: true,
  inWindow: true,
  refundCents: 1000,
  highValueThresholdCents: null as number | null,
}

describe('classifyAutoApprove', () => {
  it('is eligible when every gate passes', () => {
    expect(classifyAutoApprove(base)).toBe('eligible')
  })

  it('skips FBA returns (Amazon-managed)', () => {
    expect(classifyAutoApprove({ ...base, isFbaReturn: true })).toBe('skip-fba')
  })

  it('skips when the policy is manual (autoApprove off)', () => {
    expect(classifyAutoApprove({ ...base, policyAutoApprove: false })).toBe('skip-policy-manual')
  })

  it('skips when there is no delivery date (window unverifiable)', () => {
    expect(classifyAutoApprove({ ...base, hasDeliveryDate: false })).toBe('skip-no-delivery')
  })

  it('skips when outside the return window', () => {
    expect(classifyAutoApprove({ ...base, inWindow: false })).toBe('skip-out-of-window')
  })

  it('skips at or above the high-value threshold', () => {
    expect(classifyAutoApprove({ ...base, refundCents: 20000, highValueThresholdCents: 15000 })).toBe('skip-high-value')
    expect(classifyAutoApprove({ ...base, refundCents: 15000, highValueThresholdCents: 15000 })).toBe('skip-high-value')
  })

  it('stays eligible just under the high-value threshold', () => {
    expect(classifyAutoApprove({ ...base, refundCents: 14999, highValueThresholdCents: 15000 })).toBe('eligible')
  })

  it('treats null refund as 0 for the high-value gate', () => {
    expect(classifyAutoApprove({ ...base, refundCents: null, highValueThresholdCents: 15000 })).toBe('eligible')
  })

  it('applies gates in priority order — FBA wins over every other skip', () => {
    expect(classifyAutoApprove({
      ...base,
      isFbaReturn: true,
      policyAutoApprove: false,
      hasDeliveryDate: false,
      inWindow: false,
    })).toBe('skip-fba')
  })

  it('policy-manual wins over window/high-value once FBA is ruled out', () => {
    expect(classifyAutoApprove({
      ...base,
      policyAutoApprove: false,
      inWindow: false,
      refundCents: 99999,
      highValueThresholdCents: 1,
    })).toBe('skip-policy-manual')
  })
})
