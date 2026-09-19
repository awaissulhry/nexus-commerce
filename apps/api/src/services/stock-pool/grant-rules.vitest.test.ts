/**
 * Shared stock — the pure rules of a lending permission. The database suite (stock-pool-rules) drives
 * every (side, from, to) through the real guard and compares it with `canTransition`; this file pins
 * the words and the URL-segment checks.
 */
import { describe, expect, it } from 'vitest'
import { borrowerTarget, canTransition, expectVersion, idList, isBorrowerDecision, isLenderAction, lenderTarget, transitionRefusal } from './grant-rules.js'

describe('grant rules', () => {
  it('the lender pauses, resumes and ends; the borrower accepts, declines and leaves', () => {
    expect([lenderTarget('pause'), lenderTarget('resume'), lenderTarget('end')]).toEqual(['paused', 'active', 'revoked'])
    expect([borrowerTarget('accept'), borrowerTarget('decline'), borrowerTarget('leave')]).toEqual(['active', 'declined', 'revoked'])
    expect(canTransition('owner', 'pending', 'active')).toBe(false) // consent cannot be skipped
    expect(canTransition('borrower', 'active', 'paused')).toBe(false) // a borrower leaves; it does not pause
    expect(canTransition('owner', 'revoked', 'active')).toBe(false) // an end is final: offer again
  })

  it('URL segments are checked as own properties (the AE.2 toString lesson)', () => {
    for (const probe of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isLenderAction(probe)).toBe(false)
      expect(isBorrowerDecision(probe)).toBe(false)
    }
    expect(isLenderAction('pause')).toBe(true)
    expect(isBorrowerDecision('leave')).toBe(true)
    expect(isLenderAction('accept')).toBe(false)
  })

  it('every refusal is a sentence a person can act on', () => {
    expect(transitionRefusal('owner', 'resume', 'pending')).toMatch(/waits for the other business to accept/)
    expect(transitionRefusal('borrower', 'leave', 'pending')).toMatch(/declined, not left/)
    expect(transitionRefusal('owner', 'pause', 'revoked')).toMatch(/has ended/)
  })

  it('a change names the version it read, and lists are distinct and bounded', () => {
    expect(() => expectVersion(undefined)).toThrow(/version you are looking at/)
    expect(expectVersion(3)).toBe(3)
    expect(idList([' a', 'a', 'b'], 'products')).toEqual(['a', 'b'])
    expect(() => idList([], 'products')).toThrow(/one or more products/)
    expect(() => idList(['a', 'b', 'c'], 'warehouses', 2)).toThrow(/at most 2 warehouses/)
  })
})
