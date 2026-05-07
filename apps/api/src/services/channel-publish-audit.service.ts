/**
 * C.6 — ChannelPublishAttempt audit log writer.
 *
 * One helper, called from each publish adapter at every interesting
 * boundary (gated, rate-limited, circuit-open, dry-run, sandbox,
 * live, success, failed). Writes are best-effort and fire-and-forget
 * from the caller's perspective: we never block a publish on the
 * audit row landing, we never throw if Postgres is unhappy. The
 * compromise is that a Postgres outage will silently suppress the
 * audit trail — acceptable because the publish itself isn't blocked
 * and the operator's primary signal (success/failure of the wizard)
 * is unaffected.
 */

import { createHash } from 'node:crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'

export type PublishOutcome =
  | 'success'
  | 'failed'
  | 'gated'
  | 'rate-limited'
  | 'circuit-open'
  | 'timeout'

export interface AttemptInput {
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  marketplace: string
  sellerId: string
  sku: string
  productId?: string | null
  mode: PublishMode
  outcome: PublishOutcome
  errorMessage?: string | null
  errorCode?: string | null
  submissionId?: string | null
  /** Either the canonicalised attribute payload (we'll digest) or a
   *  pre-computed sha256 string. Letting callers pass the digest
   *  matters when the same attempt path computes it once for the
   *  request body and we want to reuse rather than re-hash. */
  payload?: unknown
  payloadDigest?: string
  durationMs?: number | null
}

/**
 * sha256 of the canonical JSON of `value`. Stable for object-key
 * order (we sort keys recursively before stringify) so logical
 * duplicates collide on digest.
 */
export function digestPayload(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']'
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalize((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  )
}

/**
 * Write one ChannelPublishAttempt row. Fire-and-forget — caller
 * doesn't await. Failures log a warn and swallow.
 */
export function writeAttemptLog(input: AttemptInput): void {
  const digest =
    input.payloadDigest ??
    (input.payload !== undefined ? digestPayload(input.payload) : 'no-payload')

  void (async () => {
    try {
      await (prisma as any).channelPublishAttempt.create({
        data: {
          channel: input.channel,
          marketplace: input.marketplace,
          sellerId: input.sellerId,
          sku: input.sku,
          productId: input.productId ?? null,
          mode: input.mode,
          outcome: input.outcome,
          errorMessage: input.errorMessage ?? null,
          errorCode: input.errorCode ?? null,
          submissionId: input.submissionId ?? null,
          payloadDigest: digest,
          durationMs: input.durationMs ?? null,
        },
      })
    } catch (err) {
      logger.warn('writeAttemptLog failed (audit row dropped)', {
        channel: input.channel,
        marketplace: input.marketplace,
        sku: input.sku,
        outcome: input.outcome,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}
