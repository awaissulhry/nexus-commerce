/** FS4 — the login-lockout state machine (5 fails → 15-minute lock, user-keyed). */
import { describe, expect, it } from "vitest";
import { LOCK_MS, MAX_FAILS, isLocked, onLoginFailure, onLoginSuccess, remainingLockMinutes } from "@/lib/auth/lockout";

const NOW = Date.parse("2026-07-17T10:00:00.000Z");
const fresh = { failedLoginCount: 0, lockedUntil: null };

describe("onLoginFailure", () => {
  it("counts failures without locking below the threshold", () => {
    let state: { failedLoginCount: number; lockedUntil: Date | null } = fresh;
    for (let i = 1; i < MAX_FAILS; i++) {
      const next = onLoginFailure(state, NOW);
      expect(next.failedLoginCount).toBe(i);
      expect(next.lockedUntil).toBeNull();
      expect(next.justLocked).toBe(false);
      state = next;
    }
  });

  it("the 5th consecutive failure locks for exactly 15 minutes, once", () => {
    const next = onLoginFailure({ failedLoginCount: MAX_FAILS - 1, lockedUntil: null }, NOW);
    expect(next.justLocked).toBe(true);
    expect(next.lockedUntil?.getTime()).toBe(NOW + LOCK_MS);
    expect(isLocked(next.lockedUntil, NOW)).toBe(true);
    expect(isLocked(next.lockedUntil, NOW + LOCK_MS + 1)).toBe(false);
  });

  it("a failure AFTER an expired lock starts a fresh count (no instant re-lock)", () => {
    const expiredLock = { failedLoginCount: MAX_FAILS, lockedUntil: new Date(NOW - 1) };
    const next = onLoginFailure(expiredLock, NOW);
    expect(next.failedLoginCount).toBe(1);
    expect(next.lockedUntil).toBeNull();
    expect(next.justLocked).toBe(false);
  });
});

describe("onLoginSuccess", () => {
  it("resets the counter and the lock", () => {
    expect(onLoginSuccess()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe("isLocked / remainingLockMinutes", () => {
  it("an unexpired lock refuses; expiry releases", () => {
    expect(isLocked(new Date(NOW + 1), NOW)).toBe(true);
    expect(isLocked(new Date(NOW), NOW)).toBe(false);
    expect(isLocked(null, NOW)).toBe(false);
  });

  it("remaining minutes round UP and never read zero", () => {
    expect(remainingLockMinutes(new Date(NOW + LOCK_MS), NOW)).toBe(15);
    expect(remainingLockMinutes(new Date(NOW + 61_000), NOW)).toBe(2);
    expect(remainingLockMinutes(new Date(NOW + 20_000), NOW)).toBe(1);
  });
});
