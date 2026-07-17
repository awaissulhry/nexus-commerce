/**
 * FS4 — the login-lockout state machine, pure (the schema's dormant
 * `failedLoginCount`/`lockedUntil` become real). 5 consecutive failures →
 * a 15-minute lock (HTTP 423 with the remaining minutes); success resets the
 * counter; a failure AFTER an expired lock starts a fresh count of 1 (each
 * lock window buys a full set of attempts — the alternative re-locks forever
 * on every single wrong password). Rate-limited by USER, not IP (single-site
 * reality, F0-ARCHITECTURE §RBAC). The login route is the only driver; this
 * module stays pure so the machine is unit-testable end to end.
 */

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;

export type LockState = { failedLoginCount: number; lockedUntil: Date | null };

/** An unexpired lock is the only thing that refuses a login attempt outright. */
export function isLocked(lockedUntil: Date | null, nowMs: number): boolean {
  return lockedUntil != null && lockedUntil.getTime() > nowMs;
}

/** Whole minutes left on a lock, rounded UP (a 20-second remainder reads "1 minute"). */
export function remainingLockMinutes(lockedUntil: Date, nowMs: number): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - nowMs) / 60_000));
}

/**
 * One failed password. An expired lock resets the baseline to zero before
 * counting, so post-lock attempts get a fresh window. `justLocked` fires
 * exactly once — on the failure that crosses the threshold (the audit hook).
 */
export function onLoginFailure(state: LockState, nowMs: number): LockState & { justLocked: boolean } {
  const expired = state.lockedUntil != null && state.lockedUntil.getTime() <= nowMs;
  const failedLoginCount = (expired ? 0 : state.failedLoginCount) + 1;
  const justLocked = failedLoginCount >= MAX_FAILS;
  return {
    failedLoginCount,
    lockedUntil: justLocked ? new Date(nowMs + LOCK_MS) : null,
    justLocked,
  };
}

/** A verified password clears everything. */
export function onLoginSuccess(): LockState {
  return { failedLoginCount: 0, lockedUntil: null };
}
