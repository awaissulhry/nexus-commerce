/**
 * C.6 — Safety scaffolding around the AmazonPublishAdapter.
 *
 * The adapter (apps/api/src/services/listing-wizard/amazon-publish.adapter.ts)
 * has been wired to real SP-API since E.8. Until C.6 the only thing
 * stopping accidental real publishes was the absence of LWA env vars
 * — a fragile guard that disappears the moment Awa configures eBay.
 *
 * This module is the layered defence:
 *
 *   1. Feature flag (NEXUS_ENABLE_AMAZON_PUBLISH=false default)
 *      Master switch. Off → adapter short-circuits with `gated`.
 *   2. Mode resolver (AMAZON_PUBLISH_MODE=dry-run|sandbox|live)
 *      Controls whether real HTTP happens and which host it targets.
 *   3. Per-(seller, marketplace) rate limiter
 *      Token bucket on top of SP-API's own 5/sec gate inside the
 *      client. Belt-and-braces so a wizard with 50 children doesn't
 *      burst the channel.
 *   4. Per-(seller, marketplace) circuit breaker
 *      3 consecutive failures in a 5-min window opens the circuit
 *      for 10 min. Prevents cascading failures from a misconfigured
 *      account from filling the audit log with noise.
 *
 * Single-process design. Same justification as listing-events.service.ts
 * — Xavia's Railway scale is one API instance. If we ever scale out,
 * the rate-limiter and circuit state move to Redis without changing
 * the public API.
 */

import { logger } from '../utils/logger.js'

export type AmazonPublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'

/** Read the master feature flag. Default false. */
export function isAmazonPublishEnabled(): boolean {
  const raw = process.env.NEXUS_ENABLE_AMAZON_PUBLISH
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/**
 * Resolve the effective mode. The flag gate takes precedence — when
 * disabled, mode is `gated` regardless of AMAZON_PUBLISH_MODE so the
 * adapter has a single boolean to check.
 */
export function getAmazonPublishMode(): AmazonPublishMode {
  if (!isAmazonPublishEnabled()) return 'gated'
  const raw = (process.env.AMAZON_PUBLISH_MODE ?? 'dry-run').toLowerCase()
  if (raw === 'live' || raw === 'production') return 'live'
  if (raw === 'sandbox') return 'sandbox'
  // Anything else (including 'dry-run', empty, typos) → dry-run.
  // We default-safe rather than default-loud.
  return 'dry-run'
}

// ── Rate limiter ──────────────────────────────────────────────────────
//
// Token bucket per (sellerId, marketplaceId). Conservative starting
// point: 2 req/sec sustained, burst of 20. SP-API's documented limits
// for putListingsItem are 5 req/sec / burst 10 — we run cooler so a
// wizard with 50 children + retries doesn't trip the upstream gate.
// The `RateLimiter` utility's AMAZON config (2/sec / 40 burst) is
// shared across all SP-API endpoints; we narrow per-key here so two
// concurrent wizards on different marketplaces don't compete.

interface RateBucket {
  tokens: number
  lastRefillAt: number
}

const RATE_TOKENS_PER_SECOND = 2
const RATE_BURST_SIZE = 20
const RATE_MAX_WAIT_MS = 30_000

const rateBuckets = new Map<string, RateBucket>()

function rateBucketKey(sellerId: string, marketplaceId: string): string {
  return `${sellerId}:${marketplaceId}`
}

function refillBucket(bucket: RateBucket): void {
  const now = Date.now()
  const elapsedMs = now - bucket.lastRefillAt
  if (elapsedMs <= 0) return
  const toAdd = (elapsedMs / 1000) * RATE_TOKENS_PER_SECOND
  bucket.tokens = Math.min(RATE_BURST_SIZE, bucket.tokens + toAdd)
  bucket.lastRefillAt = now
}

export interface AcquireResult {
  ok: boolean
  /** Wait time we actually applied (0 when token was immediately available). */
  waitedMs: number
  error?: string
}

/**
 * Wait (up to maxWaitMs) for a token. Returns ok=true once acquired,
 * ok=false if the bucket can't refill fast enough within the window.
 */
export async function acquireAmazonPublishToken(
  sellerId: string,
  marketplaceId: string,
  maxWaitMs: number = RATE_MAX_WAIT_MS,
): Promise<AcquireResult> {
  const key = rateBucketKey(sellerId, marketplaceId)
  let bucket = rateBuckets.get(key)
  if (!bucket) {
    bucket = { tokens: RATE_BURST_SIZE, lastRefillAt: Date.now() }
    rateBuckets.set(key, bucket)
  }

  const start = Date.now()
  refillBucket(bucket)
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, waitedMs: 0 }
  }

  // Compute the time until we'd have one full token.
  const tokensNeeded = 1 - bucket.tokens
  const waitMs = Math.ceil((tokensNeeded / RATE_TOKENS_PER_SECOND) * 1000)
  if (waitMs > maxWaitMs) {
    return {
      ok: false,
      waitedMs: 0,
      error: `Amazon publish rate-limited (would need ${waitMs}ms wait, cap ${maxWaitMs}ms)`,
    }
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs))
  refillBucket(bucket)
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, waitedMs: Date.now() - start }
  }
  // Should be unreachable given the wait math, but stay defensive.
  return {
    ok: false,
    waitedMs: Date.now() - start,
    error: 'Amazon publish rate limiter could not acquire token after waiting',
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────
//
// 3 failures inside FAILURE_WINDOW_MS opens the circuit for OPEN_MS.
// Half-open after that — first attempt is allowed; success closes,
// failure re-opens for another OPEN_MS round.

type CircuitState = 'closed' | 'open' | 'half-open'

interface Circuit {
  state: CircuitState
  failureTimestamps: number[]
  openedAt?: number
}

const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 5 * 60_000 // 5 min
const OPEN_MS = 10 * 60_000 // 10 min

const circuits = new Map<string, Circuit>()

function circuitKey(sellerId: string, marketplaceId: string): string {
  return `${sellerId}:${marketplaceId}`
}

function getCircuit(sellerId: string, marketplaceId: string): Circuit {
  const key = circuitKey(sellerId, marketplaceId)
  let c = circuits.get(key)
  if (!c) {
    c = { state: 'closed', failureTimestamps: [] }
    circuits.set(key, c)
  }
  return c
}

export interface CircuitCheck {
  ok: boolean
  state: CircuitState
  error?: string
}

/**
 * Check whether we may attempt a publish. Idempotent — does not
 * mutate state on the closed path; transitions open → half-open
 * once OPEN_MS has elapsed.
 */
export function checkAmazonCircuit(
  sellerId: string,
  marketplaceId: string,
): CircuitCheck {
  const c = getCircuit(sellerId, marketplaceId)
  if (c.state === 'open') {
    const openedAt = c.openedAt ?? 0
    if (Date.now() - openedAt >= OPEN_MS) {
      c.state = 'half-open'
      logger.info('Amazon publish circuit transitioning to half-open', {
        sellerId,
        marketplaceId,
      })
    } else {
      const remainingSec = Math.ceil((openedAt + OPEN_MS - Date.now()) / 1000)
      return {
        ok: false,
        state: 'open',
        error: `Amazon publish circuit open after ${FAILURE_THRESHOLD} consecutive failures. Retry in ${remainingSec}s.`,
      }
    }
  }
  return { ok: true, state: c.state }
}

/**
 * Record a publish outcome. Closed circuit stays closed on success;
 * accumulates timestamps on failure and opens once we hit the
 * threshold inside the window. Half-open closes on success and re-
 * opens on any failure.
 */
export function recordAmazonOutcome(
  sellerId: string,
  marketplaceId: string,
  success: boolean,
): void {
  const c = getCircuit(sellerId, marketplaceId)
  const now = Date.now()

  if (success) {
    if (c.state === 'half-open') {
      logger.info('Amazon publish circuit closing (half-open success)', {
        sellerId,
        marketplaceId,
      })
    }
    c.state = 'closed'
    c.failureTimestamps = []
    c.openedAt = undefined
    return
  }

  // Failure path
  c.failureTimestamps = [
    ...c.failureTimestamps.filter((t) => now - t <= FAILURE_WINDOW_MS),
    now,
  ]

  if (c.state === 'half-open') {
    c.state = 'open'
    c.openedAt = now
    logger.warn('Amazon publish circuit re-opening (half-open failure)', {
      sellerId,
      marketplaceId,
    })
    return
  }

  if (c.failureTimestamps.length >= FAILURE_THRESHOLD) {
    c.state = 'open'
    c.openedAt = now
    logger.warn('Amazon publish circuit opening', {
      sellerId,
      marketplaceId,
      failures: c.failureTimestamps.length,
      windowMs: FAILURE_WINDOW_MS,
    })
  }
}

/** Returns current circuit state for all tracked Amazon seller+marketplace keys. */
export function getAllAmazonCircuitStates(): Record<string, {
  state: CircuitState
  failureCount: number
  openedAt: string | null
  lastError?: string
}> {
  const result: ReturnType<typeof getAllAmazonCircuitStates> = {}
  for (const [key, c] of circuits.entries()) {
    result[key] = {
      state: c.state,
      failureCount: c.failureTimestamps.length,
      openedAt: c.openedAt ? new Date(c.openedAt).toISOString() : null,
    }
  }
  return result
}

/** Force-close all Amazon circuits (operator manual reset). */
export function resetAllAmazonCircuits(): void {
  for (const c of circuits.values()) {
    c.state = 'closed'
    c.failureTimestamps = []
    c.openedAt = undefined
  }
}

/** Test-only — wipe all in-memory state. Not exported in prod paths. */
export function __resetAmazonPublishGateForTests(): void {
  rateBuckets.clear()
  circuits.clear()
}
