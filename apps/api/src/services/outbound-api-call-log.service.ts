/**
 * L.3.1 — Outbound API call log service.
 *
 * Wraps any async function that performs an outbound HTTP call to a
 * channel API and writes one OutboundApiCallLog row at completion
 * with channel + operation + latency + statusCode + error detail.
 *
 * Usage (Amazon SP-API):
 *
 *   const orders = await recordApiCall(
 *     {
 *       channel: 'AMAZON',
 *       marketplace: 'A1F83G8C2ARO7P',
 *       operation: 'getOrders',
 *       method: 'GET',
 *       triggeredBy: 'cron',
 *     },
 *     () => sp.callAPI({ operation: 'getOrders', endpoint: 'orders', ... }),
 *   )
 *
 * Usage (eBay raw fetch):
 *
 *   const res = await recordApiCall(
 *     {
 *       channel: 'EBAY',
 *       marketplace: 'EBAY_IT',
 *       connectionId: conn.id,
 *       operation: 'getOrder',
 *       endpoint: '/sell/fulfillment/v1/order',
 *       method: 'GET',
 *     },
 *     async () => {
 *       const r = await fetch(url, { headers })
 *       if (!r.ok) {
 *         const body = await r.text()
 *         const err = new Error(`eBay ${r.status}: ${body}`) as Error & {
 *           statusCode: number
 *           body: string
 *         }
 *         err.statusCode = r.status
 *         err.body = body
 *         throw err
 *       }
 *       return r.json()
 *     },
 *   )
 *
 * The writer never breaks the underlying call: DB write failures are
 * logged at WARN and swallowed. The original promise (resolve or
 * reject) is always what the caller sees.
 *
 * Payload retention policy:
 *   - Success path: payload columns left null (the success-rate +
 *     latency are what the dashboards care about; storing every
 *     successful response is unaffordable at 1.7M rows/yr).
 *   - Failure path: requestPayload (from ctx) AND responsePayload
 *     (extracted from the error body) are retained. This is what an
 *     operator needs to triage a real failure.
 *   - Caller is still responsible for redacting secrets / trimming
 *     binary content from anything passed in `requestPayload`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { publishSyncLogEvent } from './sync-logs-events.service.js'
import { recordErrorOccurrence } from './error-grouping.service.js'
import {
  getRequestId,
  getRequestSource,
} from '../utils/request-context.js'
import { logTraceEvent } from '../utils/trace-log.js'
import { withSpan } from '../utils/otel-setup.js'

type Channel =
  | 'AMAZON'
  | 'EBAY'
  | 'SHOPIFY'
  | 'WOOCOMMERCE'
  | 'ETSY'
  | 'SENDCLOUD'
  // P1.1 — Amazon Ads rows were written as 'AMAZON'; the gateway writes them as their own channel.
  | 'AMAZON_ADS'

export interface ApiCallContext {
  channel: Channel
  marketplace?: string
  connectionId?: string
  operation: string
  endpoint?: string
  method?: string
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
  requestId?: string
  /**
   * Optional request payload. Stored on FAILURE only (success skips
   * to control volume). Caller must redact secrets / trim binary.
   */
  requestPayload?: unknown
  productId?: string
  listingId?: string
  orderId?: string
}

interface ParsedError {
  statusCode: number | null
  message: string
  code?: string
  type?: 'RATE_LIMIT' | 'AUTHENTICATION' | 'VALIDATION' | 'NETWORK' | 'SERVER'
  body?: unknown
}

const ERROR_MESSAGE_MAX = 2000
const PAYLOAD_BYTES_MAX = 32 * 1024 // 32 kB cap per JSON column

function parseError(err: unknown): ParsedError {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    const statusCode = typeof e.statusCode === 'number' ? e.statusCode : null
    const message = String(e.message ?? 'Unknown error')
    const code = e.code !== undefined ? String(e.code) : undefined

    let type: ParsedError['type']
    if (statusCode === 429 || /throttle|quota|rate.?limit/i.test(message)) {
      type = 'RATE_LIMIT'
    } else if (statusCode === 401 || statusCode === 403) {
      type = 'AUTHENTICATION'
    } else if (statusCode === 400 || statusCode === 422) {
      type = 'VALIDATION'
    } else if (statusCode !== null && statusCode >= 500) {
      type = 'SERVER'
    } else if (statusCode === null) {
      type = 'NETWORK'
    }

    return { statusCode, message, code, type, body: e.body }
  }
  return {
    statusCode: null,
    message: err instanceof Error ? err.message : String(err),
    type: 'NETWORK',
  }
}

/**
 * Trim a JSON-serialisable value to PAYLOAD_BYTES_MAX. If the
 * stringified form is larger, return a marker object the dashboard
 * can render distinctly. Never throws — used in a finally block.
 */
function clipPayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return undefined
  try {
    const s = JSON.stringify(payload)
    if (s.length <= PAYLOAD_BYTES_MAX) return payload
    return {
      __truncated: true,
      bytes: s.length,
      preview: s.slice(0, PAYLOAD_BYTES_MAX),
    }
  } catch {
    return { __unserialisable: true, type: typeof payload }
  }
}

/**
 * Monkey-patch a SellingPartner instance's callAPI so every call
 * goes through recordApiCall(). Existing callsites pass through
 * untouched — they get observability for free.
 *
 * The SP-API library's callAPI signature accepts a single object:
 *   { operation, endpoint, path?, query?, body? }
 * The patched method reads `operation` + `endpoint` to populate
 * the OutboundApiCallLog row. Override defaults via `defaultCtx`
 * (e.g. set `marketplace` per construction site).
 *
 * Idempotent: a second call is a no-op (we tag the patched method
 * with a sentinel symbol).
 */
const PATCHED = Symbol('outboundApiCallLog.patched')

interface SpInstance {
  callAPI: (params: { operation: string; endpoint?: string }) => Promise<unknown>
  [key: string]: unknown
}

export function instrumentSellingPartner(
  sp: SpInstance,
  defaultCtx: Partial<ApiCallContext> = {},
): void {
  const callAPI = sp.callAPI as unknown as {
    [PATCHED]?: boolean
  } & SpInstance['callAPI']
  if (callAPI[PATCHED]) return

  const original = callAPI.bind(sp)
  const wrapped = async (params: {
    operation: string
    endpoint?: string
  }): Promise<unknown> => {
    const ctx: ApiCallContext = {
      channel: 'AMAZON',
      ...defaultCtx,
      operation: String(params?.operation ?? 'unknown'),
      endpoint: params?.endpoint ?? defaultCtx.endpoint,
    }
    return recordApiCall(ctx, () => original(params))
  }
  ;(wrapped as unknown as { [PATCHED]: boolean })[PATCHED] = true
  sp.callAPI = wrapped as SpInstance['callAPI']
}

export async function recordApiCall<T>(
  ctx: ApiCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  // L.26.0 — wrap the call in an OTel span when the SDK is
  // initialised. withSpan is a no-op fallback when disabled, so
  // the existing recording behaviour below stays intact.
  return withSpan(
    `${ctx.channel.toLowerCase()}.${ctx.operation}`,
    {
      'channel': ctx.channel,
      'operation': ctx.operation,
      'marketplace': ctx.marketplace,
      'http.method': ctx.method,
      'http.endpoint': ctx.endpoint,
      'product.id': ctx.productId,
      'listing.id': ctx.listingId,
      'order.id': ctx.orderId,
    },
    () => recordApiCallInner(ctx, fn),
  )
}

/**
 * P1.2 — a call that moved onto the channel gateway can still sit inside an old `recordApiCall` wrapper.
 * The gateway then writes the row (one per send) and takes the wrapper's operation name and entity
 * links; the wrapper writes nothing of its own. Without this every moved call would be recorded twice.
 */
interface LedgerScope { ctx: ApiCallContext; gatewayRows: number }
const ledgerScope = new AsyncLocalStorage<LedgerScope>()

/** For the gateway's ledger write: the enclosing wrapper's context (and the wrapper is told to stay silent). */
export function claimEnclosingApiCall(): ApiCallContext | null {
  const scope = ledgerScope.getStore()
  if (!scope) return null
  scope.gatewayRows++
  return scope.ctx
}

async function recordApiCallInner<T>(
  ctx: ApiCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: LedgerScope = { ctx, gatewayRows: 0 }
  const startedAt = Date.now()
  let statusCode: number | null = null
  let success = false
  let errorMessage: string | undefined
  let errorCode: string | undefined
  let errorType: ParsedError['type']
  let responsePayload: unknown = undefined

  try {
    const result = await ledgerScope.run(scope, fn)
    success = true
    statusCode = 200 // SP-API lib + fetch wrappers return only on 2xx
    return result
  } catch (err) {
    const parsed = parseError(err)
    success = false
    statusCode = parsed.statusCode
    errorMessage = parsed.message
    errorCode = parsed.code
    errorType = parsed.type
    responsePayload = parsed.body
    throw err
  } finally {
    const latencyMs = Date.now() - startedAt
    // The gateway already wrote one row per send made inside this wrapper.
    if (scope.gatewayRows === 0) try {
      const row = await prisma.outboundApiCallLog.create({
        data: {
          channel: ctx.channel,
          marketplace: ctx.marketplace,
          connectionId: ctx.connectionId,
          operation: ctx.operation,
          endpoint: ctx.endpoint,
          method: ctx.method,
          statusCode,
          success,
          latencyMs,
          errorMessage: errorMessage?.slice(0, ERROR_MESSAGE_MAX),
          errorCode,
          errorType,
          // L.12.0 — fall back to the AsyncLocalStorage requestId
          // (populated by the Fastify onRequest hook OR by
          // recordCronRun's tickId) so callers don't have to pass
          // it explicitly. Same for triggeredBy.
          requestId: ctx.requestId ?? getRequestId(),
          triggeredBy:
            ctx.triggeredBy ?? getRequestSource() ?? 'api',
          // Retain payloads ONLY on failure to keep table volume sane.
          requestPayload: success
            ? undefined
            : (clipPayload(ctx.requestPayload) as never),
          responsePayload: success
            ? undefined
            : (clipPayload(responsePayload) as never),
          productId: ctx.productId,
          listingId: ctx.listingId,
          orderId: ctx.orderId,
        },
        select: { id: true, createdAt: true },
      })
      // L.21.0 — emit structured trace event to stdout (gated on
      // NEXUS_TRACE_LOG=1). Format follows OTel span semantic
      // conventions so a stdout-ingesting collector picks it up.
      logTraceEvent({
        spanName: `${ctx.channel.toLowerCase()}.${ctx.operation}`,
        spanKind: 'client',
        status: success ? 'ok' : 'error',
        durationMs: latencyMs,
        attributes: {
          channel: ctx.channel,
          operation: ctx.operation,
          marketplace: ctx.marketplace ?? null,
          'http.status_code': statusCode,
          'error.type': errorType ?? null,
          'error.code': errorCode ?? null,
        },
      })

      // L.7.0 — broadcast to the in-process event bus so SSE
      // subscribers (the hub's live tail) receive a slim row.
      publishSyncLogEvent({
        type: 'api-call.recorded',
        ts: row.createdAt.getTime(),
        id: row.id,
        channel: ctx.channel,
        marketplace: ctx.marketplace ?? null,
        operation: ctx.operation,
        statusCode,
        success,
        latencyMs,
        errorType: errorType ?? null,
        errorMessage: errorMessage
          ? errorMessage.slice(0, 200)
          : null,
      })

      // L.8.0 — on failure, also upsert the SyncLogErrorGroup row
      // so the hub can show "this same error happened N times".
      // Best-effort: errors are logged inside the helper; success
      // path skips this entirely.
      if (!success) {
        void recordErrorOccurrence({
          channel: ctx.channel,
          operation: ctx.operation,
          errorType: errorType ?? null,
          errorCode: errorCode ?? null,
          message: errorMessage ?? null,
        })
      }
    } catch (writeErr) {
      // Never break the actual call because logging itself is degraded.
      logger.warn('outbound-api-call-log: write failed', {
        error:
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        channel: ctx.channel,
        operation: ctx.operation,
      })
    }
  }
}

// ── P1.1 — the channel gateway's ledger row ─────────────────────────────────

export interface GatewayLedgerRow {
  channel: Channel
  marketplace?: string | null
  connectionId?: string | null
  operation: string
  endpoint?: string | null
  method?: string | null
  statusCode: number | null
  success: boolean
  latencyMs: number
  /** sent | would_send | gated | refused | held */
  outcome: string
  errorClass?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  rateLimitRemaining?: number | null
  rateLimitLimit?: number | null
  idempotencyKey?: string | null
  attempts?: number | null
  apiVersion?: string | null
  /** Already made safe by services/gateway/redact.ts (secrets and personal data removed, capped). */
  requestPayload?: unknown
  responsePayload?: unknown
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
  productId?: string | null
  listingId?: string | null
  orderId?: string | null
}

/** Map the gateway's class onto the older errorType column, so existing dashboards keep grouping. */
const LEGACY_ERROR_TYPE: Record<string, ParsedError['type']> = {
  rate_limited: 'RATE_LIMIT', auth_revoked: 'AUTHENTICATION', auth_expired: 'AUTHENTICATION', forbidden: 'AUTHENTICATION',
  signature: 'AUTHENTICATION', configuration: 'AUTHENTICATION', validation: 'VALIDATION', not_found: 'VALIDATION',
  conflict: 'VALIDATION', transient: 'SERVER', network: 'NETWORK', timeout: 'NETWORK',
}

/**
 * Write one gateway row (every gateway call writes exactly one, whatever happened). Never throws: a
 * ledger outage is logged and must not become a failed channel call.
 */
export async function recordGatewayCall(row: GatewayLedgerRow): Promise<void> {
  try {
    const created = await prisma.outboundApiCallLog.create({
      data: {
        channel: row.channel,
        marketplace: row.marketplace ?? undefined,
        connectionId: row.connectionId ?? undefined,
        operation: row.operation,
        endpoint: row.endpoint ?? undefined,
        method: row.method ?? undefined,
        statusCode: row.statusCode,
        success: row.success,
        latencyMs: row.latencyMs,
        errorMessage: row.errorMessage?.slice(0, ERROR_MESSAGE_MAX),
        errorCode: row.errorCode ?? undefined,
        errorType: row.errorClass ? LEGACY_ERROR_TYPE[row.errorClass] : undefined,
        requestId: getRequestId(),
        triggeredBy: row.triggeredBy ?? getRequestSource() ?? 'api',
        requestPayload: row.success ? undefined : (row.requestPayload as never),
        responsePayload: row.success ? undefined : (row.responsePayload as never),
        productId: row.productId ?? undefined,
        listingId: row.listingId ?? undefined,
        orderId: row.orderId ?? undefined,
        outcome: row.outcome,
        errorClass: row.errorClass ?? undefined,
        rateLimitRemaining: row.rateLimitRemaining ?? undefined,
        rateLimitLimit: row.rateLimitLimit ?? undefined,
        idempotencyKey: row.idempotencyKey ?? undefined,
        attempts: row.attempts ?? undefined,
        apiVersion: row.apiVersion ?? undefined,
      },
      select: { id: true, createdAt: true },
    })
    publishSyncLogEvent({
      type: 'api-call.recorded',
      ts: created.createdAt.getTime(),
      id: created.id,
      channel: row.channel,
      marketplace: row.marketplace ?? null,
      operation: row.operation,
      statusCode: row.statusCode,
      success: row.success,
      latencyMs: row.latencyMs,
      errorType: row.errorClass ?? null,
      errorMessage: row.errorMessage ? row.errorMessage.slice(0, 200) : null,
    })
    if (!row.success && row.outcome === 'sent') {
      void recordErrorOccurrence({
        channel: row.channel,
        operation: row.operation,
        errorType: row.errorClass ?? null,
        errorCode: row.errorCode ?? null,
        message: row.errorMessage ?? null,
      })
    }
  } catch (writeErr) {
    logger.warn('outbound-api-call-log: gateway row write failed', {
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      channel: row.channel,
      operation: row.operation,
    })
  }
}
