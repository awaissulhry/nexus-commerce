/**
 * MCP.5 — a fresh 2FA code for one sensitive act: connecting Claude to a business.
 *
 * `verifyTotp` on its own accepts the same code again for about 90 seconds and counts no wrong
 * guesses. A step-up adds both:
 *   · each code is used once per person, for as long as it would stay valid (replay);
 *   · 5 wrong codes in 15 minutes lock the step-up for the rest of that window.
 * Shared by every API replica through the app's Redis while it is connected (lib/queue.ts hands
 * it over); held per process otherwise — the same fail-open as the tool and gateway limits.
 */

import { verifyTotp } from './mfa.js'

const USED_MS = 120_000
const FAILURE_WINDOW_MS = 15 * 60_000
export const STEP_UP_MAX_FAILURES = 5

export type StepUpVerdict = 'ok' | 'invalid' | 'reused' | 'locked'

export interface StepUpRedis {
  status?: string
  get(key: string): Promise<string | null>
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<'OK' | null>
  incr(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<unknown>
}

let sharedRedis: (() => StepUpRedis | null) | null = null
const memory = new Map<string, { value: number; expiresAt: number }>()

export function registerStepUpRedis(get: () => StepUpRedis | null): void {
  sharedRedis = get
}

function readyRedis(): StepUpRedis | null {
  const client = sharedRedis?.() ?? null
  return client && client.status === 'ready' ? client : null
}

function memoryGet(key: string, now: number): number {
  const entry = memory.get(key)
  if (!entry || entry.expiresAt <= now) {
    memory.delete(key)
    return 0
  }
  return entry.value
}

async function failures(key: string): Promise<number> {
  const redis = readyRedis()
  if (redis) {
    try {
      return Number((await redis.get(key)) ?? 0)
    } catch { /* fall back to this process */ }
  }
  return memoryGet(key, Date.now())
}

async function addFailure(key: string): Promise<number> {
  const redis = readyRedis()
  if (redis) {
    try {
      const count = await redis.incr(key)
      if (count === 1) await redis.pexpire(key, FAILURE_WINDOW_MS)
      return count
    } catch { /* fall back to this process */ }
  }
  const now = Date.now()
  const count = memoryGet(key, now) + 1
  memory.set(key, { value: count, expiresAt: memory.get(key)?.expiresAt ?? now + FAILURE_WINDOW_MS })
  return count
}

/** Claim a code once. False when it was already used. */
async function claimOnce(key: string): Promise<boolean> {
  const redis = readyRedis()
  if (redis) {
    try {
      return (await redis.set(key, '1', 'PX', USED_MS, 'NX')) === 'OK'
    } catch { /* fall back to this process */ }
  }
  const now = Date.now()
  if (memoryGet(key, now) > 0) return false
  memory.set(key, { value: 1, expiresAt: now + USED_MS })
  return true
}

/** Check a fresh 6-digit code against the person's TOTP secret, once, with a failure limit. */
export async function verifyStepUpCode(userId: string, secret: string | null, code: unknown): Promise<StepUpVerdict> {
  const failureKey = `auth:step-up:fail:${userId}`
  if ((await failures(failureKey)) >= STEP_UP_MAX_FAILURES) return 'locked'
  const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : ''
  if (!secret || !/^\d{6}$/.test(digits) || !verifyTotp(secret, digits)) {
    const count = await addFailure(failureKey)
    return count >= STEP_UP_MAX_FAILURES ? 'locked' : 'invalid'
  }
  return (await claimOnce(`auth:step-up:used:${userId}:${digits}`)) ? 'ok' : 'reused'
}

export const __stepUpTest = {
  reset() {
    memory.clear()
    sharedRedis = null
  },
}
