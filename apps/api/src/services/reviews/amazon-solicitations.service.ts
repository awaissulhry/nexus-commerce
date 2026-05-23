/**
 * RV.3.2 — Single source of truth for the Amazon Solicitations API call.
 *
 * Until this file existed, two near-duplicate copies lived in:
 *   - apps/api/src/routes/orders-reviews.routes.ts        (sendAmazonSolicitation)
 *   - apps/api/src/jobs/review-request-mailer.job.ts      (fireAmazonSolicitation)
 *
 * Both wrap the same endpoint
 *   POST /solicitations/v1/orders/{orderId}/solicitations/productReviewAndSellerFeedback
 * but diverged on:
 *   - error classification (routes had ALREADY_SOLICITED + HTTP_xxx mapping,
 *     mailer had only raw message slice)
 *   - the marketplace ID map (routes covered 18 markets, mailer 9)
 *   - the env-flag dry-run behavior (NOT_IMPLEMENTED vs DRY_RUN error codes)
 *
 * Consolidating here so every change lands in one place and both call sites
 * benefit. The result is the same SolicitationResult shape both expect.
 */

import { logger } from '../../utils/logger.js'

/**
 * Amazon marketplace short-code → SP-API marketplaceId.
 * The Solicitations API expects the marketplaceId in the query string. We
 * accept the operator-friendly short code on the application side and
 * translate here.
 */
const AMAZON_MARKETPLACE_ID_MAP: Record<string, string> = {
  // EU region
  IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P', GB: 'A1F83G8C2ARO7P',
  NL: 'A1805IZSGTT6HS', PL: 'A1C3SOZRARQ6R3', SE: 'A2NODRKZP88ZB9',
  BE: 'AMEN7PMS3EDWL', IE: 'A28R8C7NBKEWEA', TR: 'A33AVAJ2PDY3EV',
  // NA region
  US: 'ATVPDKIKX0DER',
  // MENA
  AE: 'A2VIGQ35RCS4UG', SA: 'A17E79C6D8DWNP', EG: 'ARBP9OOSHTCHU',
  // APAC
  JP: 'A1VC38T7YXB528', AU: 'A39IBJ37TRP1C6', SG: 'A19VAU5U5O7RUS', IN: 'A21TJRUUN4KGV',
}

export function amazonMarketplaceIdFor(code: string | null | undefined): string | null {
  if (!code) return null
  return AMAZON_MARKETPLACE_ID_MAP[code.toUpperCase()] ?? null
}

export interface SolicitationResult {
  ok: boolean
  providerRequestId?: string
  /** One of:
   *    OK                — the call returned 2xx
   *    NOT_IMPLEMENTED   — NEXUS_ENABLE_AMAZON_SOLICITATIONS env flag is off
   *    UNKNOWN_MARKETPLACE — marketplace short code didn't map to an id
   *    ALREADY_SOLICITED — Amazon's duplicate-protection (HTTP 400/403 + "already")
   *    HTTP_xxx          — non-benign HTTP error, x replaced by status
   *    EXCEPTION         — fetch / network / other thrown error
   */
  errorCode?: string
  errorMessage?: string
}

/**
 * Fire one Amazon Solicitations API call. Gated behind
 * NEXUS_ENABLE_AMAZON_SOLICITATIONS=true — when off, returns
 * NOT_IMPLEMENTED so the engine can mark the row SKIPPED without
 * incrementing a failure counter.
 *
 * The SP-API client (`amazonSpApiClient.request`) handles:
 *   - LWA token refresh
 *   - SigV4 signing (RSU regions only — Solicitations is non-RSU but
 *     the client paces all calls)
 *   - Per-request 200ms rate-limit gap (≈5 req/sec global cap)
 *   - Retry on 429/5xx with 1s/2s/4s backoff
 *
 * Caller is responsible for:
 *   - Re-checking eligibility (4-30d post-delivery window, no active returns)
 *   - Writing the result onto a ReviewRequest row
 *   - Advancing attemptCount + nextRetryAt for the RV.3.3 re-try loop
 */
export async function sendAmazonSolicitation(args: {
  amazonOrderId: string
  marketplaceCode: string
}): Promise<SolicitationResult> {
  const { amazonOrderId, marketplaceCode } = args

  if (process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS !== 'true') {
    logger.info('[REVIEW ENGINE] sendAmazonSolicitation dryRun', {
      amazonOrderId, marketplaceCode,
    })
    return {
      ok: false,
      errorCode: 'NOT_IMPLEMENTED',
      errorMessage:
        'SP-API Solicitations gated by env (NEXUS_ENABLE_AMAZON_SOLICITATIONS=true)',
    }
  }

  const marketplaceId = amazonMarketplaceIdFor(marketplaceCode)
  if (!marketplaceId) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_MARKETPLACE',
      errorMessage: `No Amazon marketplaceId mapping for "${marketplaceCode}"`,
    }
  }

  try {
    const { amazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
    await amazonSpApiClient.request(
      'POST',
      `/solicitations/v1/orders/${encodeURIComponent(amazonOrderId)}/solicitations/productReviewAndSellerFeedback`,
      { query: { marketplaceIds: marketplaceId }, label: 'sendAmazonSolicitation' },
    )
    logger.info('[REVIEW ENGINE] sendAmazonSolicitation OK', { amazonOrderId, marketplaceCode })
    return { ok: true, errorCode: 'OK' }
  } catch (err: any) {
    const msg: string = err?.message ?? String(err)
    // Amazon's duplicate-protection — HTTP 400/403 with "already". Benign.
    if (/HTTP 40[03]/.test(msg) && /already/i.test(msg)) {
      return {
        ok: false,
        errorCode: 'ALREADY_SOLICITED',
        errorMessage: msg.slice(0, 500),
      }
    }
    const httpMatch = msg.match(/HTTP (\d+)/)
    if (httpMatch) {
      return {
        ok: false,
        errorCode: `HTTP_${httpMatch[1]}`,
        errorMessage: msg.slice(0, 500),
      }
    }
    logger.warn('[REVIEW ENGINE] sendAmazonSolicitation threw', {
      amazonOrderId, marketplaceCode, error: msg,
    })
    return { ok: false, errorCode: 'EXCEPTION', errorMessage: msg }
  }
}

/**
 * Outcomes that should mark the row SKIPPED (not FAILED) and never retry:
 *   - NOT_IMPLEMENTED  — env flag is off (dry-run)
 *   - UNKNOWN_MARKETPLACE — config error, not a transient failure
 *   - ALREADY_SOLICITED — Amazon will reject every retry too
 *
 * The mailer uses this to keep the dashboard "failed" count meaningful
 * (real failures only) and to avoid pointlessly retrying permanent-failure
 * rows on the RV.3.3 backoff schedule.
 */
const BENIGN_ERROR_CODES = new Set([
  'NOT_IMPLEMENTED',
  'UNKNOWN_MARKETPLACE',
  'ALREADY_SOLICITED',
])

export function isBenignFailure(errorCode: string | null | undefined): boolean {
  return errorCode != null && BENIGN_ERROR_CODES.has(errorCode)
}

/**
 * Human-readable suppressedReason for the dashboard, given an errorCode.
 * Returns null when the code isn't classified as benign (caller writes a
 * full errorMessage instead).
 */
export function benignSuppressedReason(errorCode: string | null | undefined): string | null {
  switch (errorCode) {
    case 'NOT_IMPLEMENTED':
      return 'Amazon Solicitations gated by env (NEXUS_ENABLE_AMAZON_SOLICITATIONS)'
    case 'UNKNOWN_MARKETPLACE':
      return 'Order has no recognised Amazon marketplace short code'
    case 'ALREADY_SOLICITED':
      return 'Amazon already solicited a review for this order'
    default:
      return null
  }
}
