/**
 * SC.1 — session validation cache.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * `validateSession` ran a `userSession.findUnique` against Neon on EVERY request, because the
 * global `rbacHook` calls it before any handler. Measured from a browser on 2026-08-31:
 *
 *     GET /                      119 ms   (network + TLS only, no session lookup)
 *     GET /api/connections       731 ms   (trivial handler + the session lookup)
 *     GET /api/products?n=1     1283 ms
 *
 * ~600 ms of every authenticated request was the auth preamble, not the work. Redis was already
 * deployed and the auth path never touched it. This closes that.
 *
 * ── Structure copied deliberately from `services/advertising/ads-cache.ts` ──────────────────
 *
 * Two tiers, and the reasons are that file's hard-won ones, not invented here:
 *   • L1, in-process Map — always available, no network, and still correct when Redis is down.
 *   • L2, Redis — shared between API instances. EVERY op is time-boxed, because ioredis
 *     offline-queues commands, so a bare `await` PENDS FOREVER when Redis is unreachable. That
 *     is what previously hung the ads endpoints; a hang in the auth path would hang the entire
 *     API, so the timeout here is not optional.
 *
 * 🔴 The cache is an accelerator, never an authority. Any miss, timeout or Redis outage falls
 * through to the database and the request is answered correctly, only slower.
 *
 * ── Staleness is bounded from both ends ─────────────────────────────────────────────────────
 *
 * A cached session must never outlive the operator's intent. Two mechanisms, together:
 *
 *   1. Explicit invalidation. Every revocation path drops the exact keys it revokes, so
 *      "Deactivate — their sessions end immediately" stays literally true, and so does a
 *      permission change (`bumpUserPermissionVersion`), preserving the immediate propagation
 *      that `rbac.ts` §3.5 was designed for.
 *   2. A deliberately SHORT L1 TTL. Explicit invalidation reaches shared Redis, but it cannot
 *      reach another instance's in-process Map. L1 therefore expires in seconds, which bounds
 *      cross-instance staleness without needing any coordination.
 */

import { redis } from '../queue.js'
import { logger } from '../../utils/logger.js'
import type { ValidatedSession } from './session.js'

const PREFIX = 'sesscache:'

/** Shared tier: long enough to matter, short enough that a missed invalidation self-heals. */
const REDIS_TTL_SEC = 60
/** Local tier: the ONLY window an invalidation on another instance cannot close. Keep it small. */
const MEM_TTL_MS = 5_000
const MEM_MAX = 500

/** ioredis offline-queues when down — an un-timed await never settles. See the header. */
const REDIS_OP_TIMEOUT_MS = 150

// ── L1 ──────────────────────────────────────────────────────────────────────────────────────
interface MemEntry {
  val: ValidatedSession
  exp: number
}
const mem = new Map<string, MemEntry>()

function memGet(key: string): ValidatedSession | undefined {
  const e = mem.get(key)
  if (!e) return undefined
  if (Date.now() > e.exp) {
    mem.delete(key)
    return undefined
  }
  mem.delete(key)
  mem.set(key, e) // LRU refresh
  return e.val
}

function memSet(key: string, val: ValidatedSession): void {
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value
    if (oldest) mem.delete(oldest)
  }
  mem.set(key, { val, exp: Date.now() + MEM_TTL_MS })
}

// ── L2 ──────────────────────────────────────────────────────────────────────────────────────
function withTimeout<R>(p: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis-timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Trips after repeated failures so a dead Redis costs one timeout, not one per request. */
let failures = 0
let openUntil = 0
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 30_000

function breakerOpen(): boolean {
  return Date.now() < openUntil
}
function noteFailure(): void {
  if (++failures >= BREAKER_THRESHOLD) {
    openUntil = Date.now() + BREAKER_COOLDOWN_MS
    failures = 0
    logger.warn('[session-cache] redis unreachable — bypassing L2 for 30s')
  }
}
function noteSuccess(): void {
  failures = 0
}

/**
 * JSON loses `Date`. `SessionUser.twoFactorEnabledAt` is `Date | null`, so a naive round trip
 * would hand callers a string where the uncached path hands them a Date — the cached and
 * uncached objects must be indistinguishable or this becomes a source of type-shaped bugs that
 * only appear under cache hits.
 */
function revive(raw: unknown): ValidatedSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as ValidatedSession
  if (!s.sessionId || !s.user?.id) return null
  const t = s.user.twoFactorEnabledAt as unknown
  s.user.twoFactorEnabledAt = t ? new Date(t as string) : null
  return s
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────

/** Look up a validated session by its TOKEN HASH. Never keyed by the raw token. */
export async function getCachedSession(hash: string): Promise<ValidatedSession | null> {
  const key = PREFIX + hash
  const local = memGet(key)
  if (local) return local
  if (breakerOpen()) return null
  try {
    const conn = redis.connection as unknown as { get(k: string): Promise<string | null> }
    const raw = await withTimeout(conn.get(key), REDIS_OP_TIMEOUT_MS)
    noteSuccess()
    if (!raw) return null
    const parsed = revive(JSON.parse(raw))
    if (parsed) memSet(key, parsed)
    return parsed
  } catch {
    noteFailure()
    return null
  }
}

export async function setCachedSession(hash: string, session: ValidatedSession): Promise<void> {
  const key = PREFIX + hash
  memSet(key, session)
  if (breakerOpen()) return
  try {
    const conn = redis.connection as unknown as {
      setex(k: string, ttl: number, v: string): Promise<unknown>
    }
    await withTimeout(conn.setex(key, REDIS_TTL_SEC, JSON.stringify(session)), REDIS_OP_TIMEOUT_MS)
    noteSuccess()
  } catch {
    noteFailure()
  }
}

/**
 * Drop cached sessions by token hash. Call from every revocation path.
 *
 * Failure is swallowed: the database write that accompanies it is the real revocation, and the
 * TTLs above cap how long a failed drop can matter. Never let a cache problem fail a logout.
 */
export async function dropCachedSessions(hashes: readonly string[]): Promise<void> {
  if (hashes.length === 0) return
  const keys = hashes.map((h) => PREFIX + h)
  for (const k of keys) mem.delete(k)
  if (breakerOpen()) return
  try {
    const conn = redis.connection as unknown as { del(...k: string[]): Promise<unknown> }
    await withTimeout(conn.del(...keys), REDIS_OP_TIMEOUT_MS)
    noteSuccess()
  } catch {
    noteFailure()
  }
}

/** Test seam — the L2 round trip in isolation, which is where Date survival is decided. */
export function __reviveForTest(raw: unknown): ValidatedSession | null {
  return revive(raw)
}

/** Test seam — drops L1 only. */
export function __clearSessionMemCache(): void {
  mem.clear()
}
