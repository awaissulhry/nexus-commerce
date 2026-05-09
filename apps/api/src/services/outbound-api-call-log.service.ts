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

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { publishSyncLogEvent } from './sync-logs-events.service.js'

type Channel =
  | 'AMAZON'
  | 'EBAY'
  | 'SHOPIFY'
  | 'WOOCOMMERCE'
  | 'ETSY'
  | 'SENDCLOUD'

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
  const startedAt = Date.now()
  let statusCode: number | null = null
  let success = false
  let errorMessage: string | undefined
  let errorCode: string | undefined
  let errorType: ParsedError['type']
  let responsePayload: unknown = undefined

  try {
    const result = await fn()
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
    try {
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
          requestId: ctx.requestId,
          triggeredBy: ctx.triggeredBy ?? 'api',
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
