/**
 * C.7 — Safety scaffolding around the EbayPublishAdapter.
 *
 * The adapter (apps/api/src/services/listing-wizard/ebay-publish.adapter.ts)
 * has been wired to real eBay Inventory API since DD.4 — three-step
 * flow PUT inventory_item → POST offer → POST publish. Until C.7 the
 * only thing stopping accidental real publishes was the absence of a
 * configured `ChannelConnection` with a valid OAuth grant — fragile
 * because the token is just a row toggle away from active.
 *
 * Mirrors amazon-publish-gate.service.ts; differences:
 *   - Identity key is the ChannelConnection.id (not env-var seller id)
 *   - Rate config follows eBay's published Inventory API limits
 *     (10 req/sec sustained, 100 burst — looser than Amazon's 5/sec)
 *   - Mode toggle controls the apiBase (api.ebay.com ↔
 *     api.sandbox.ebay.com) instead of swapping a host prefix
 *
 * Design parity with the Amazon gate matters: the layered defence is
 * the contract operators (and future readers) trust. Don't optimise
 * one channel's gate without bringing the other along, or the
 * dryRun → sandbox → canary → graduated rollout sequence diverges
 * between channels and we lose the operator's mental model.
 */

import { logger } from '../utils/logger.js'

export type EbayPublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'

/** Read the master feature flag. Default false. */
export function isEbayPublishEnabled(): boolean {
  const raw = process.env.NEXUS_ENABLE_EBAY_PUBLISH
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/**
 * Resolve the effective mode. The flag gate takes precedence — when
 * disabled, mode is `gated` regardless of EBAY_PUBLISH_MODE so the
 * adapter has a single boolean to check.
 */
export function getEbayPublishMode(): EbayPublishMode {
  if (!isEbayPublishEnabled()) return 'gated'
  const raw = (process.env.EBAY_PUBLISH_MODE ?? 'dry-run').toLowerCase()
  if (raw === 'live' || raw === 'production') return 'live'
  if (raw === 'sandbox') return 'sandbox'
  return 'dry-run'
}

/**
 * Resolve the eBay API base URL for the given mode. Lookup order:
 *   - 'sandbox' → fixed 'https://api.sandbox.ebay.com'
 *   - 'live' / fallback → EBAY_API_BASE env, then 'https://api.ebay.com'
 *
 * Returns an empty string for 'gated' / 'dry-run' to make accidental
 * fetch() with a falsy URL fail loudly rather than silently hit a
 * default — the caller should branch on mode and never reach here in
 * those modes.
 */
export function getEbayApiBaseForMode(mode: EbayPublishMode): string {
  if (mode === 'gated' || mode === 'dry-run') return ''
  if (mode === 'sandbox') return 'https://api.sandbox.ebay.com'
  return process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
}

// ── Rate limiter ──────────────────────────────────────────────────────
//
// Token bucket per (connectionId, marketplaceId). One token per
// PUBLISH ATTEMPT — the 3 internal HTTP calls (inventory PUT, offer
// POST, publish POST) share the token because they're sequential and
// tied to a single operator action. The bucket is per-marketplace so
// two concurrent multi-marketplace wizards don't compete.

interface RateBucket {
  tokens: number
  lastRefillAt: number
}

const RATE_TOKENS_PER_SECOND = 10
const RATE_BURST_SIZE = 100
const RATE_MAX_WAIT_MS = 30_000

const rateBuckets = new Map<string, RateBucket>()

function rateBucketKey(connectionId: string, marketplaceId: string): string {
  return `${connectionId}:${marketplaceId}`
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
export async function acquireEbayPublishToken(
  connectionId: string,
  marketplaceId: string,
  maxWaitMs: number = RATE_MAX_WAIT_MS,
): Promise<AcquireResult> {
  const key = rateBucketKey(connectionId, marketplaceId)
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

  const tokensNeeded = 1 - bucket.tokens
  const waitMs = Math.ceil((tokensNeeded / RATE_TOKENS_PER_SECOND) * 1000)
  if (waitMs > maxWaitMs) {
    return {
      ok: false,
      waitedMs: 0,
      error: `eBay publish rate-limited (would need ${waitMs}ms wait, cap ${maxWaitMs}ms)`,
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
    error: 'eBay publish rate limiter could not acquire token after waiting',
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open'

interface Circuit {
  state: CircuitState
  failureTimestamps: number[]
  openedAt?: number
}

const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 5 * 60_000
const OPEN_MS = 10 * 60_000

const circuits = new Map<string, Circuit>()

function circuitKey(connectionId: string, marketplaceId: string): string {
  return `${connectionId}:${marketplaceId}`
}

function getCircuit(connectionId: string, marketplaceId: string): Circuit {
  const key = circuitKey(connectionId, marketplaceId)
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

export function checkEbayCircuit(
  connectionId: string,
  marketplaceId: string,
): CircuitCheck {
  const c = getCircuit(connectionId, marketplaceId)
  if (c.state === 'open') {
    const openedAt = c.openedAt ?? 0
    if (Date.now() - openedAt >= OPEN_MS) {
      c.state = 'half-open'
      logger.info('eBay publish circuit transitioning to half-open', {
        connectionId,
        marketplaceId,
      })
    } else {
      const remainingSec = Math.ceil((openedAt + OPEN_MS - Date.now()) / 1000)
      return {
        ok: false,
        state: 'open',
        error: `eBay publish circuit open after ${FAILURE_THRESHOLD} consecutive failures. Retry in ${remainingSec}s.`,
      }
    }
  }
  return { ok: true, state: c.state }
}

export function recordEbayOutcome(
  connectionId: string,
  marketplaceId: string,
  success: boolean,
): void {
  const c = getCircuit(connectionId, marketplaceId)
  const now = Date.now()

  if (success) {
    if (c.state === 'half-open') {
      logger.info('eBay publish circuit closing (half-open success)', {
        connectionId,
        marketplaceId,
      })
    }
    c.state = 'closed'
    c.failureTimestamps = []
    c.openedAt = undefined
    return
  }

  c.failureTimestamps = [
    ...c.failureTimestamps.filter((t) => now - t <= FAILURE_WINDOW_MS),
    now,
  ]

  if (c.state === 'half-open') {
    c.state = 'open'
    c.openedAt = now
    logger.warn('eBay publish circuit re-opening (half-open failure)', {
      connectionId,
      marketplaceId,
    })
    return
  }

  if (c.failureTimestamps.length >= FAILURE_THRESHOLD) {
    c.state = 'open'
    c.openedAt = now
    logger.warn('eBay publish circuit opening', {
      connectionId,
      marketplaceId,
      failures: c.failureTimestamps.length,
      windowMs: FAILURE_WINDOW_MS,
    })
  }
}

/** Test-only — wipe all in-memory state. */
export function __resetEbayPublishGateForTests(): void {
  rateBuckets.clear()
  circuits.clear()
}
