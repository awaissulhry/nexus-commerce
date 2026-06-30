import { describe, it, expect } from 'vitest'
import { classifyOpenOrderReconciliation } from './reservation-reconcile.js'

const DAY = 24 * 60 * 60 * 1000
const STALE = 90 * DAY

describe('classifyOpenOrderReconciliation', () => {
  it('releases a held reservation for a CANCELLED order', () => {
    expect(classifyOpenOrderReconciliation('CANCELLED', 1 * DAY, STALE)).toBe('release')
  })
  it('consumes for SHIPPED and DELIVERED (unit left — must decrement quantity)', () => {
    expect(classifyOpenOrderReconciliation('SHIPPED', 1 * DAY, STALE)).toBe('consume')
    expect(classifyOpenOrderReconciliation('DELIVERED', 1 * DAY, STALE)).toBe('consume')
  })
  it('only alerts (never auto-acts) for REFUNDED / RETURNED — ambiguous', () => {
    expect(classifyOpenOrderReconciliation('REFUNDED', 1 * DAY, STALE)).toBe('alert')
    expect(classifyOpenOrderReconciliation('RETURNED', 1 * DAY, STALE)).toBe('alert')
  })
  it('skips a fresh non-terminal order (hold is legitimate)', () => {
    expect(classifyOpenOrderReconciliation('PROCESSING', 2 * DAY, STALE)).toBe('skip')
    expect(classifyOpenOrderReconciliation('PENDING', 10 * DAY, STALE)).toBe('skip')
  })
  it('alerts (does NOT release) a stale non-terminal order past staleMs', () => {
    expect(classifyOpenOrderReconciliation('PROCESSING', 120 * DAY, STALE)).toBe('alert')
    expect(classifyOpenOrderReconciliation('ON_HOLD', 200 * DAY, STALE)).toBe('alert')
  })
  it('skips unknown statuses defensively', () => {
    expect(classifyOpenOrderReconciliation('SOME_NEW_STATUS', 1 * DAY, STALE)).toBe('skip')
  })
  it('pins the stale boundary to strict > (= staleMs still skips, +1ms alerts)', () => {
    expect(classifyOpenOrderReconciliation('PROCESSING', STALE, STALE)).toBe('skip')
    expect(classifyOpenOrderReconciliation('PROCESSING', STALE + 1, STALE)).toBe('alert')
  })
  it('covers the remaining NON_TERMINAL members (PARTIALLY_SHIPPED, AWAITING_PAYMENT)', () => {
    expect(classifyOpenOrderReconciliation('PARTIALLY_SHIPPED', 2 * DAY, STALE)).toBe('skip')
    expect(classifyOpenOrderReconciliation('PARTIALLY_SHIPPED', 120 * DAY, STALE)).toBe('alert')
    expect(classifyOpenOrderReconciliation('AWAITING_PAYMENT', 2 * DAY, STALE)).toBe('skip')
    expect(classifyOpenOrderReconciliation('AWAITING_PAYMENT', 120 * DAY, STALE)).toBe('alert')
  })
})
