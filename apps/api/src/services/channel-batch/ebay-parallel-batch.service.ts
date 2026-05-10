/**
 * W12.3 — eBay parallel-batch wrapper.
 *
 * eBay Inventory API has no native bulk-feed (Amazon
 * JSON_LISTINGS_FEED / Shopify bulkOperationRunMutation
 * equivalents); per-SKU PUTs are the only path. The bulk shape
 * we expose is therefore concurrency-limited parallel calls
 * with rate-limit-aware retry — same operator interface as
 * Amazon and Shopify, different mechanics under the hood.
 *
 * Design choices:
 *   - Concurrency capped at 8 by default. The Trading API
 *     allows ~5K req/day per app + per-token throttles by
 *     endpoint family; 8 in-flight strikes the balance between
 *     wall-clock and 429 risk.
 *   - 429 responses retry with exponential backoff (1s, 2s, 4s)
 *     up to 3 attempts. After that, the result is recorded as
 *     a failure and the batch continues — one bad SKU never
 *     blocks the rest.
 *   - Returns a per-operation result array so the W12.4 bulk-
 *     action handler can write per-BulkActionItem outcomes.
 *
 * Dry-run gate: NEXUS_EBAY_BATCH_DRYRUN=1 skips the HTTP layer
 * and returns synthesised success rows.
 */

import { logger } from '../../utils/logger.js'
import { EbayAuthService } from '../ebay-auth.service.js'

export type EbayBatchOperation =
  | { type: 'price'; sku: string; offerId: string; currency: string; value: string }
  | { type: 'stock'; sku: string; quantity: number }
  | { type: 'withdraw'; sku: string; offerId: string }

export interface EbayBatchSubmission {
  /** ChannelConnection id holding the eBay OAuth token. */
  connectionId: string
  operations: EbayBatchOperation[]
  /** Default 8. Caller can lower this for sensitive endpoints
   *  (Trading API status changes, Inventory API offer republish). */
  concurrency?: number
  /** Default 3. Set 0 to disable retries entirely. */
  maxRetries?: number
}

export interface EbayBatchOpResult {
  sku: string
  status: 'ok' | 'failed' | 'retried'
  attempts: number
  errorMessage: string | null
  httpStatus: number | null
}

export interface EbayBatchResult {
  connectionId: string
  total: number
  succeeded: number
  failed: number
  results: EbayBatchOpResult[]
  dryRun: boolean
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 3
const EBAY_API_BASE = 'https://api.ebay.com'

function isDryRunEnv(): boolean {
  return process.env.NEXUS_EBAY_BATCH_DRYRUN === '1'
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface OperationCall {
  method: 'PUT' | 'POST' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}

/** Translate the operator-facing op into the eBay HTTP call. */
function operationToCall(op: EbayBatchOperation): OperationCall {
  if (op.type === 'price') {
    return {
      method: 'PUT',
      path: `/sell/inventory/v1/offer/${encodeURIComponent(op.offerId)}`,
      body: {
        pricingSummary: {
          price: { currency: op.currency, value: op.value },
        },
      },
    }
  }
  if (op.type === 'stock') {
    return {
      method: 'PUT',
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(op.sku)}`,
      body: {
        availability: {
          shipToLocationAvailability: { quantity: op.quantity },
        },
      },
    }
  }
  // withdraw
  return {
    method: 'POST',
    path: `/sell/inventory/v1/offer/${encodeURIComponent(op.offerId)}/withdraw`,
  }
}

/** Single-operation HTTP with 429-aware retry. Returns the per-op
 *  result row; never throws (the worker never wedges on one bad SKU). */
async function runOne(
  op: EbayBatchOperation,
  accessToken: string,
  maxRetries: number,
): Promise<EbayBatchOpResult> {
  const call = operationToCall(op)
  let attempt = 0
  let lastErr: string | null = null
  let lastStatus: number | null = null
  while (attempt <= maxRetries) {
    attempt++
    try {
      const res = await fetch(`${EBAY_API_BASE}${call.path}`, {
        method: call.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: call.body ? JSON.stringify(call.body) : undefined,
      })
      if (res.ok) {
        return {
          sku: op.sku,
          status: attempt === 1 ? 'ok' : 'retried',
          attempts: attempt,
          errorMessage: null,
          httpStatus: res.status,
        }
      }
      lastStatus = res.status
      const txt = await res.text().catch(() => '')
      lastErr = txt.slice(0, 300)
      // 429 → retry with backoff. 4xx other → fail fast (unrecoverable).
      if (res.status === 429 && attempt <= maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1)
        logger.warn('[ebay-batch] 429 — backing off', {
          sku: op.sku,
          attempt,
          backoffMs,
        })
        await sleep(backoffMs)
        continue
      }
      // Non-429 4xx + 5xx with retries left → also retry once
      // (eBay periodically returns transient 502/503 on Inventory).
      if (res.status >= 500 && attempt <= maxRetries) {
        const backoffMs = 500 * Math.pow(2, attempt - 1)
        await sleep(backoffMs)
        continue
      }
      break
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      if (attempt <= maxRetries) {
        await sleep(500 * Math.pow(2, attempt - 1))
        continue
      }
      break
    }
  }
  return {
    sku: op.sku,
    status: 'failed',
    attempts: attempt,
    errorMessage: lastErr,
    httpStatus: lastStatus,
  }
}

/** Concurrency-limited fan-out. Workers pull from a shared queue
 *  index; no Promise.all all-at-once which would exceed the cap. */
async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<EbayBatchOpResult>,
  concurrency: number,
): Promise<EbayBatchOpResult[]> {
  const results: EbayBatchOpResult[] = new Array(items.length)
  let next = 0
  async function pump(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => pump()),
  )
  return results
}

export async function submitEbayParallelBatch(
  input: EbayBatchSubmission,
): Promise<EbayBatchResult> {
  if (!input.connectionId) {
    throw new Error('EbayBatch: connectionId required')
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error('EbayBatch: operations must be non-empty')
  }
  const concurrency = Math.max(1, Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, 32))
  const maxRetries = Math.max(0, input.maxRetries ?? DEFAULT_MAX_RETRIES)

  if (isDryRunEnv()) {
    logger.info('[ebay-batch] dryRun — operations not submitted', {
      total: input.operations.length,
      concurrency,
    })
    const results: EbayBatchOpResult[] = input.operations.map((op) => ({
      sku: op.sku,
      status: 'ok',
      attempts: 1,
      errorMessage: null,
      httpStatus: 200,
    }))
    return {
      connectionId: input.connectionId,
      total: results.length,
      succeeded: results.length,
      failed: 0,
      results,
      dryRun: true,
    }
  }

  const auth = new EbayAuthService()
  const accessToken = await auth.getValidToken(input.connectionId)

  const results = await runWithConcurrency(
    input.operations,
    (op) => runOne(op, accessToken, maxRetries),
    concurrency,
  )
  const succeeded = results.filter((r) => r.status !== 'failed').length
  const failed = results.length - succeeded
  return {
    connectionId: input.connectionId,
    total: results.length,
    succeeded,
    failed,
    results,
    dryRun: false,
  }
}
