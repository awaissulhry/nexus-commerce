import { describe, expect, it } from 'vitest'
import { isLocked, LOCKOUT, lockMsAfter, lockUntil, UNLOCKED } from './lockout'

// Ported from Commerce's apps/api/src/lib/auth/auth.vitest.test.ts ("progressive lockout math").
const NOW = new Date('2026-10-28T10:00:00.000Z')

describe('lockout', () => {
  it('does not lock below five wrong secrets in a row', () => {
    expect(LOCKOUT.maxFailures).toBe(5)
    for (const count of [0, 1, 4]) {
      expect(lockMsAfter(count)).toBe(0)
      expect(lockUntil(count, NOW)).toBeNull()
    }
  })

  it('locks for a minute at five, doubling with each further wrong secret', () => {
    expect(lockMsAfter(5)).toBe(60_000)
    expect(lockMsAfter(6)).toBe(120_000)
    expect(lockMsAfter(7)).toBe(240_000)
    expect(lockUntil(5, NOW)).toEqual(new Date('2026-10-28T10:01:00.000Z'))
  })

  it('caps the lock at one hour, however many wrong secrets follow', () => {
    expect(lockMsAfter(11)).toBe(60 * 60_000)
    expect(lockMsAfter(1_000)).toBe(60 * 60_000)
    expect(lockMsAfter(Number.MAX_SAFE_INTEGER)).toBe(60 * 60_000)
  })

  it('is locked until the lock passes, and a success clears the state', () => {
    const until = lockUntil(5, NOW)
    expect(isLocked({ lockedUntil: until }, NOW)).toBe(true)
    expect(isLocked({ lockedUntil: until }, new Date('2026-10-28T10:00:59.999Z'))).toBe(true)
    expect(isLocked({ lockedUntil: until }, new Date('2026-10-28T10:01:00.000Z'))).toBe(false)
    expect(isLocked({ lockedUntil: null }, NOW)).toBe(false)
    expect(UNLOCKED).toEqual({ failedAttempts: 0, lockedUntil: null })
  })

  it('treats a count that is not a whole number as no lock', () => {
    expect(lockMsAfter(Number.NaN)).toBe(0)
    expect(lockMsAfter(-3)).toBe(0)
    expect(lockMsAfter(5.5)).toBe(0)
  })
})
