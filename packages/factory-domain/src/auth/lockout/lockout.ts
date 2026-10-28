/**
 * Account lockout (plan A1 §3.10; feature PLT-047), ported from Commerce (apps/api/src/lib/auth/lockout.ts): after five
 * wrong secrets in a row the account locks for one minute, and every further wrong one doubles the lock, up to an
 * hour. A wrong password, a wrong sign-in code and a wrong step-up code all count; a successful sign-in clears the
 * count. While locked, even the right password opens nothing, and the answer is the same as for a wrong password
 * (no oracle). Guessing across many accounts from one address is held by the rate limits of the sign-in routes.
 *
 * Pure: the count comes from the database (incremented there, atomically), the time comes in.
 */

export const LOCKOUT = Object.freeze({
  /** Wrong secrets in a row before the first lock. */
  maxFailures: 5,
  firstLockMs: 60_000,
  maxLockMs: 60 * 60_000,
})

export interface LockoutState {
  readonly failedAttempts: number
  readonly lockedUntil: Date | null
}

/** The state after a successful sign-in. */
export const UNLOCKED: LockoutState = Object.freeze({ failedAttempts: 0, lockedUntil: null })

/** How long the account locks once it has this many wrong secrets in a row (0 below the threshold). */
export function lockMsAfter(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < LOCKOUT.maxFailures) return 0
  const over = failedAttempts - LOCKOUT.maxFailures
  // 2 ** 30 minutes would overflow nothing, but the cap is reached at the seventh doubling anyway.
  return Math.min(LOCKOUT.firstLockMs * 2 ** Math.min(over, 30), LOCKOUT.maxLockMs)
}

/** The lock set by the latest wrong secret: until when, or null when the count is below the threshold. */
export function lockUntil(failedAttempts: number, now: Date): Date | null {
  const ms = lockMsAfter(failedAttempts)
  return ms === 0 ? null : new Date(now.getTime() + ms)
}

/** True while the account is locked. */
export function isLocked(state: Pick<LockoutState, 'lockedUntil'>, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()
}
