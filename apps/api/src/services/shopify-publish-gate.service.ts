/**
 * P3.0 — Safety scaffolding around Shopify outbound sync.
 *
 * Mirrors amazon-publish-gate.service.ts and ebay-publish-gate.service.ts
 * with the same token-bucket rate limiter and circuit-breaker pattern so
 * all three channels have consistent protection.
 *
 * Shopify REST Admin API limits: 2 req/sec sustained, 40 request burst.
 * We run slightly cooler (2/sec, 20 burst) to leave headroom for webhook
 * and read traffic from the same access token.
 *
 * Circuit breaker: 3 consecutive failures in 5 min → open 10 min.
 */

import { logger } from '../utils/logger.js'

// ── Rate limiter ─────────────────────────────────────────────────────────

interface RateBucket {
  tokens: number
  lastRefillAt: number
}

const RATE_TOKENS_PER_SECOND = 2
const RATE_BURST_SIZE = 20
const RATE_MAX_WAIT_MS = 30_000

const rateBuckets = new Map<string, RateBucket>()

function refillBucket(bucket: RateBucket): void {
  const now = Date.now()
  const elapsed = now - bucket.lastRefillAt
  if (elapsed <= 0) return
  bucket.tokens = Math.min(RATE_BURST_SIZE, bucket.tokens + (elapsed / 1000) * RATE_TOKENS_PER_SECOND)
  bucket.lastRefillAt = now
}

export interface AcquireResult {
  ok: boolean
  waitedMs: number
  error?: string
}

export async function acquireShopifyPublishToken(
  shopDomain: string,
  maxWaitMs: number = RATE_MAX_WAIT_MS,
): Promise<AcquireResult> {
  let bucket = rateBuckets.get(shopDomain)
  if (!bucket) {
    bucket = { tokens: RATE_BURST_SIZE, lastRefillAt: Date.now() }
    rateBuckets.set(shopDomain, bucket)
  }

  const start = Date.now()
  refillBucket(bucket)

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, waitedMs: 0 }
  }

  const tokensNeeded = 1 - bucket.tokens
  const waitMs = Math.ceil((tokensNeeded / RATE_TOKENS_PER_SECOND) * 1000)
  if (waitMs > maxWaitMs) {
    return {
      ok: false,
      waitedMs: 0,
      error: `Shopify publish rate-limited (would need ${waitMs}ms wait, cap ${maxWaitMs}ms)`,
    }
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs))
  refillBucket(bucket)
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, waitedMs: Date.now() - start }
  }
  return {
    ok: false,
    waitedMs: Date.now() - start,
    error: 'Shopify publish rate limiter could not acquire token after waiting',
  }
}

// ── Circuit breaker ──────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open'

interface Circuit {
  state: CircuitState
  failureTimestamps: number[]
  openedAt?: number
  lastError?: string
}

const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 5 * 60_000 // 5 min
const OPEN_MS = 10 * 60_000 // 10 min

const circuits = new Map<string, Circuit>()

function getCircuit(shopDomain: string): Circuit {
  let c = circuits.get(shopDomain)
  if (!c) {
    c = { state: 'closed', failureTimestamps: [] }
    circuits.set(shopDomain, c)
  }
  return c
}

export interface CircuitCheck {
  ok: boolean
  state: CircuitState
  error?: string
}

export function checkShopifyCircuit(shopDomain: string): CircuitCheck {
  const c = getCircuit(shopDomain)
  if (c.state === 'open') {
    const openedAt = c.openedAt ?? 0
    if (Date.now() - openedAt >= OPEN_MS) {
      c.state = 'half-open'
      logger.info('Shopify publish circuit transitioning to half-open', { shopDomain })
    } else {
      const remainingSec = Math.ceil((openedAt + OPEN_MS - Date.now()) / 1000)
      return {
        ok: false,
        state: 'open',
        error: `Shopify publish circuit open after ${FAILURE_THRESHOLD} failures. Retry in ${remainingSec}s.`,
      }
    }
  }
  return { ok: true, state: c.state }
}

export function recordShopifyOutcome(shopDomain: string, success: boolean, errorMsg?: string): void {
  const c = getCircuit(shopDomain)
  const now = Date.now()

  if (success) {
    if (c.state === 'half-open') {
      logger.info('Shopify publish circuit closing (half-open success)', { shopDomain })
    }
    c.state = 'closed'
    c.failureTimestamps = []
    c.openedAt = undefined
    c.lastError = undefined
    return
  }

  c.lastError = errorMsg
  c.failureTimestamps = [
    ...c.failureTimestamps.filter((t) => now - t <= FAILURE_WINDOW_MS),
    now,
  ]

  if (c.state === 'half-open') {
    c.state = 'open'
    c.openedAt = now
    logger.warn('Shopify publish circuit re-opening (half-open failure)', { shopDomain })
    return
  }

  if (c.failureTimestamps.length >= FAILURE_THRESHOLD) {
    c.state = 'open'
    c.openedAt = now
    logger.warn('Shopify publish circuit opening', {
      shopDomain,
      failures: c.failureTimestamps.length,
    })
  }
}

/** Returns current circuit state for all known shop domains (for the dashboard). */
export function getAllShopifyCircuitStates(): Record<string, {
  state: CircuitState
  failureCount: number
  openedAt: string | null
  lastError: string | null
}> {
  const result: ReturnType<typeof getAllShopifyCircuitStates> = {}
  for (const [domain, c] of circuits.entries()) {
    result[domain] = {
      state: c.state,
      failureCount: c.failureTimestamps.length,
      openedAt: c.openedAt ? new Date(c.openedAt).toISOString() : null,
      lastError: c.lastError ?? null,
    }
  }
  return result
}

/** Force-close all Shopify circuits (operator manual reset). */
export function resetAllShopifyCircuits(): void {
  for (const c of circuits.values()) {
    c.state = 'closed'
    c.failureTimestamps = []
    c.openedAt = undefined
    c.lastError = undefined
  }
}

export function __resetShopifyPublishGateForTests(): void {
  rateBuckets.clear()
  circuits.clear()
}
