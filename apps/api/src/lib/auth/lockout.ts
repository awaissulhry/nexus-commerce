/**
 * Phase S1 (auth core) — login rate-limit + progressive lockout.
 *
 * Two independent guards, both durable + cross-replica (no in-memory-
 * only counters — the global @fastify/rate-limit is per-instance and
 * inadequate for a login endpoint, per S0 finding F7):
 *
 *   • Per-account lockout — failedLoginCount + lockedUntil on
 *     UserProfile. After MAX_ACCOUNT_FAILURES consecutive failures the
 *     account locks with exponential backoff, capped at LOCK_MAX_MS.
 *   • Per-IP throttle — counts recent failed LoginEvent rows from the
 *     (truncated) IP; over IP_MAX_FAILURES in IP_WINDOW_MS → 429.
 *
 * Both reset on a successful login. Lockout never reveals whether the
 * account exists (the login route returns a uniform error).
 */

import prisma from '../../db.js'

export const MAX_ACCOUNT_FAILURES = 5
const LOCK_BASE_MS = 60_000 // 1 min for the first lock
const LOCK_MAX_MS = 60 * 60_000 // cap at 1 hour

export const IP_WINDOW_MS = 15 * 60_000
export const IP_MAX_FAILURES = 20

/** Lock duration after `failCount` total consecutive failures. */
export function computeLockMs(failCount: number): number {
  if (failCount < MAX_ACCOUNT_FAILURES) return 0
  const over = failCount - MAX_ACCOUNT_FAILURES // 0,1,2,…
  return Math.min(LOCK_BASE_MS * 2 ** over, LOCK_MAX_MS)
}

export interface LockState {
  locked: boolean
  until: Date | null
}

export function accountLockState(user: {
  lockedUntil: Date | null
}): LockState {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return { locked: true, until: user.lockedUntil }
  }
  return { locked: false, until: null }
}

/**
 * Record a failed login for an account. Increments the counter and,
 * once the threshold is crossed, sets lockedUntil with backoff.
 */
export async function registerLoginFailure(userId: string): Promise<LockState> {
  const updated = await (prisma as any).userProfile.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  })
  const lockMs = computeLockMs(updated.failedLoginCount)
  if (lockMs > 0) {
    const until = new Date(Date.now() + lockMs)
    await (prisma as any).userProfile.update({
      where: { id: userId },
      data: { lockedUntil: until },
    })
    return { locked: true, until }
  }
  return { locked: false, until: null }
}

/** Clear failure state after a successful login. */
export async function clearLoginFailures(userId: string): Promise<void> {
  await (prisma as any).userProfile.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })
}

/**
 * Count recent failed logins from a (truncated) IP. Used to throttle
 * distributed guessing that rotates target accounts.
 */
export async function ipRecentFailureCount(
  ipTruncated: string | null,
): Promise<number> {
  if (!ipTruncated) return 0
  const since = new Date(Date.now() - IP_WINDOW_MS)
  return (prisma as any).loginEvent.count({
    where: {
      ipAddress: ipTruncated,
      outcome: { not: 'success' },
      createdAt: { gte: since },
    },
  })
}
