/**
 * P1.1 (docs/channel-connections/FINAL-PLAN.md, section 5 item 1) — the ONE way Nexus calls a channel.
 *
 * Every call runs the same steps, in this order:
 *   1. account      — a write names its account (`connectionId`); it never falls back to the primary.
 *   2. status       — an account that needs sign-in (or is revoked / disconnected) is HELD, not called.
 *   3. publish mode — for writes: gated = nothing; dry-run = nothing, recorded as "would send";
 *                     sandbox = the channel's sandbox host, or nothing when it has none.
 *   4. push lock    — a listing that is paused, closed, ended or held by Presence is refused; and the
 *                     wrong-account guard (P0.7) for eBay / Amazon listing writes.
 *   5. headers      — the account's token, the market headers (eBay: marketplace id + language from the
 *                     Marketplace row, the one language authority), the eBay RFC 9421 signature on
 *                     its must-sign paths.
 *   6. rate bucket  — one token per call from the bucket of (channel, account, operation group); the
 *                     channel's own rate headers tune it; a 429 waits for its Retry-After and retries.
 *   7. idempotency  — a caller's key is recorded (Shopify @idempotent, eBay UUID/InvocationID live in
 *                     the body the caller builds; `idempotencyKeyFor` makes a stable one).
 *   8. classify     — a failed answer gets one class from the one vocabulary (vocabulary.ts).
 *   9. ledger       — exactly one OutboundApiCallLog row per call, whatever happened: account,
 *                     operation, time, outcome, class, rate headroom, attempts; bodies only on failure,
 *                     with secrets and personal data removed and capped (redact.ts).
 *
 * Nothing sent ⇒ a `GatewayRefusal` is thrown (after its ledger row), with the outcome and one plain
 * sentence. A channel error is NOT thrown: the response comes back with `ok: false` and its verdict,
 * so a caller keeps its own error handling while moving onto the gateway.
 */
import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { assertPushAllowed, type PushLockListing } from '@nexus/shared/push-lock'
import { recordGatewayCall } from '../outbound-api-call-log.service.js'
import { assertWriteAccount, type WriteTarget } from '../write-account-guard.js'
import { ebaySignatureAppliesTo } from '../cx/connectors/ebay/signing.js'
import {
  apiVersionOf, authHeadersOf, bucketGroupOf, ebayMarketHeaders, publishModeOf, rateReadingOf, sandboxUrlOf, shopifyGraphqlBodyOf,
} from './channels.js'
import { bucketKey, observeRate, takeToken } from './rate.js'
import { ledgerSafeBody } from './redact.js'
import { classifyChannelAnswer, type ChannelVerdict, type GatewayChannel } from './vocabulary.js'

export type GatewayOutcome = 'sent' | 'would_send' | 'gated' | 'refused' | 'held'

export interface GatewayRequest {
  channel: GatewayChannel
  /** Stable operation name for the ledger and dashboards, e.g. 'inventory.createOrReplaceInventoryItem'. */
  operation: string
  kind: 'read' | 'write'
  /** The account. Required for writes (never "the primary"); null only with `appLevel`. */
  connectionId: string | null
  /** An app-level call (grantless / our own app), not made for a seller account. */
  appLevel?: boolean
  /** Absolute PRODUCTION URL; the gateway moves it to the sandbox host in sandbox mode. */
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string | null
  /** How the call is authorised: the account's token (default), a token the caller holds, or none. */
  auth?: 'account' | 'none' | { token: string }
  marketplace?: string | null
  /** eBay: one of the market's content languages (Marketplace.languages); default = the market's first. */
  contentLanguage?: string | null
  /** eBay: sign even when the path is not on the must-sign list. */
  sign?: boolean
  idempotencyKey?: string | null
  /** The listings this write touches, for the push lock. */
  pushLock?: ReadonlyArray<PushLockListing | null | undefined>
  /** eBay / Amazon listing writes: who owns what this write touches (P0.7 guard). */
  writeTarget?: WriteTarget
  /** The caller already applied the publish mode itself (a client moved onto the gateway as is). */
  modeAppliedByCaller?: boolean
  maxRateWaitMs?: number
  max429Retries?: number
  timeoutMs?: number
  ledger?: { productId?: string | null; listingId?: string | null; orderId?: string | null; triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook' }
}

export interface GatewayResponse {
  outcome: 'sent'
  ok: boolean
  status: number
  headers: Headers
  text: string
  url: string
  attempts: number
  verdict: ChannelVerdict | null
  rate: { remaining: number | null; limit: number | null }
  json<T = unknown>(): T | null
}

export class GatewayRefusal extends Error {
  constructor(
    readonly outcome: Exclude<GatewayOutcome, 'sent'>,
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'GatewayRefusal'
  }
}

const CHANNEL_NAME: Record<GatewayChannel, string> = { EBAY: 'eBay', AMAZON_SP: 'Amazon', SHOPIFY: 'Shopify', AMAZON_ADS: 'Amazon Ads' }
const LEDGER_CHANNEL: Record<GatewayChannel, 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'AMAZON_ADS'> = { EBAY: 'EBAY', AMAZON_SP: 'AMAZON', SHOPIFY: 'SHOPIFY', AMAZON_ADS: 'AMAZON_ADS' }

/** A stable idempotency key for a write: the same parts always give the same key. */
export function idempotencyKeyFor(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)
}

async function tokenFor(req: GatewayRequest): Promise<string | null> {
  if (req.auth === 'none') return null
  if (req.auth && typeof req.auth === 'object') return req.auth.token
  if (!req.connectionId) return null
  if (req.channel === 'AMAZON_SP') return (await import('../../lib/amazon-sp-client.js')).getAmazonAccessToken(req.connectionId)
  return (await import('../cx/token.service.js')).getAccessToken(req.connectionId)
}

export async function gatewayCall(req: GatewayRequest): Promise<GatewayResponse> {
  const started = Date.now()
  const name = CHANNEL_NAME[req.channel]
  const base = {
    channel: LEDGER_CHANNEL[req.channel],
    marketplace: req.marketplace ?? null,
    connectionId: req.connectionId,
    operation: req.operation,
    endpoint: safePath(req.url),
    method: req.method,
    idempotencyKey: req.idempotencyKey ?? null,
    apiVersion: apiVersionOf(req.channel, req.url),
    productId: req.ledger?.productId ?? null,
    listingId: req.ledger?.listingId ?? null,
    orderId: req.ledger?.orderId ?? null,
    triggeredBy: req.ledger?.triggeredBy,
  }
  const refuse = async (outcome: Exclude<GatewayOutcome, 'sent'>, code: string, message: string, statusCode: number): Promise<never> => {
    await recordGatewayCall({ ...base, statusCode: null, success: false, latencyMs: Date.now() - started, outcome, errorCode: code, errorMessage: message })
    throw new GatewayRefusal(outcome, code, message, statusCode)
  }

  // 1. account
  if (!req.connectionId && !req.appLevel) {
    return refuse('refused', 'ACCOUNT_REQUIRED', `Nothing was sent to ${name}: the call does not name the account it is for.`, 400)
  }

  // 2. status
  if (req.connectionId) {
    const account = await prisma.channelConnection.findUnique({ where: { id: req.connectionId }, select: { authStatus: true, isActive: true, displayName: true } })
    if (!account) return refuse('refused', 'ACCOUNT_NOT_FOUND', `Nothing was sent to ${name}: the account ${req.connectionId} does not exist here.`, 404)
    if (!account.isActive || ['needs_reauth', 'revoked', 'disconnected'].includes(account.authStatus)) {
      return refuse('held', 'ACCOUNT_NEEDS_SIGNIN', `Held, nothing sent: the ${name} account "${account.displayName ?? req.connectionId}" needs to be reconnected (${account.isActive ? account.authStatus : 'inactive'}).`, 409)
    }
  }

  // 3. publish mode (writes)
  let url = req.url
  if (req.kind === 'write' && !req.modeAppliedByCaller) {
    const mode = publishModeOf(req.channel)
    if (mode === 'gated') return refuse('gated', 'PUBLISH_GATED', `Nothing was sent to ${name}: ${name} publishing is switched off.`, 503)
    if (mode === 'dry-run') return refuse('would_send', 'DRY_RUN', `Dry run: this ${req.operation} would be sent to ${name}. Nothing was sent.`, 200)
    if (mode === 'sandbox') {
      const sandbox = sandboxUrlOf(req.channel, req.url)
      if (!sandbox) return refuse('gated', 'NO_SANDBOX_HOST', `Nothing was sent to ${name}: publishing is in sandbox mode and this call has no sandbox host.`, 503)
      url = sandbox
    }
  }

  // 4. push lock + wrong-account guard (writes)
  if (req.kind === 'write') {
    for (const listing of req.pushLock ?? []) {
      const refusal = assertPushAllowed(listing ?? null)
      if (refusal) return refuse('refused', refusal.code, refusal.sentence, 409)
    }
    if (req.writeTarget && req.connectionId && (req.channel === 'EBAY' || req.channel === 'AMAZON_SP')) {
      try {
        await assertWriteAccount(req.channel === 'EBAY' ? 'EBAY' : 'AMAZON', req.connectionId, req.writeTarget)
      } catch (err) {
        return refuse('refused', 'WRONG_ACCOUNT_WRITE', err instanceof Error ? err.message : String(err), 409)
      }
    }
  }

  // 5. headers + signing
  let token: string | null
  try {
    token = await tokenFor(req)
  } catch (err) {
    return refuse('held', 'TOKEN_UNAVAILABLE', `Held, nothing sent: no ${name} token for this account (${err instanceof Error ? err.message : String(err)}).`, 409)
  }
  // eBay market headers from the Marketplace row. A write to a market Nexus has no languages for is
  // refused (eBay would take the wrong language); a read goes without them (eBay's default is harmless).
  let marketHeaders: Record<string, string> = {}
  if (req.channel === 'EBAY' && req.marketplace) {
    try {
      marketHeaders = await ebayMarketHeaders(req.marketplace, req.contentLanguage)
    } catch (err) {
      if (req.kind === 'write') return refuse('refused', 'MARKET_UNCONFIGURED', `Nothing was sent to eBay: ${err instanceof Error ? err.message : String(err)}`, 400)
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...marketHeaders,
    ...(req.headers ?? {}),
    ...(token ? authHeadersOf(req.channel, token) : {}),
  }
  if (req.channel === 'EBAY' && (req.sign || ebaySignatureAppliesTo(url, req.method))) {
    const { ebaySigningHeaders } = await import('../cx/connectors/ebay/client.js')
    Object.assign(headers, await ebaySigningHeaders({ environment: /sandbox/.test(new URL(url).hostname) ? 'sandbox' : 'production', method: req.method, url, body: req.body ?? null }))
  }

  // 6–7. rate bucket, send, 429 / transient retries
  const key = bucketKey(req.channel, req.connectionId, bucketGroupOf(req.channel, req.method, url))
  const maxRetries = req.max429Retries ?? 2
  let attempts = 0
  let status = 0
  let text = ''
  let responseHeaders = new Headers()
  let timedOut = false
  let reading: { remaining?: number; limit?: number; retryAfterSec?: number } | null = null
  let graphqlErrors = false
  for (;;) {
    const slot = await takeToken(req.channel, key, req.maxRateWaitMs ?? 30_000)
    if (!slot.ok) {
      return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the ${name} rate limit for this account needs ${Math.ceil(slot.waitMs / 1000)} s more. Retry later.`, 429)
    }
    attempts++
    timedOut = false
    try {
      const res = await fetch(url, { method: req.method, headers, body: req.body ?? undefined, signal: AbortSignal.timeout(req.timeoutMs ?? 30_000) })
      status = res.status
      responseHeaders = res.headers
      text = await res.text()
    } catch (err) {
      status = 0
      timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      text = err instanceof Error ? err.message : String(err)
    }
    reading = status ? rateReadingOf(req.channel, responseHeaders, status) : null
    // Shopify GraphQL: errors and THROTTLED arrive inside a 200; the headroom is in the body.
    const gql = req.channel === 'SHOPIFY' && status === 200 ? shopifyGraphqlBodyOf(text) : null
    graphqlErrors = !!gql?.errors
    if (gql && (gql.remaining !== null || gql.limit !== null)) reading = { ...(reading ?? {}), remaining: gql.remaining ?? undefined, limit: gql.limit ?? undefined }
    const throttled = status === 429 || !!gql?.throttled
    await observeRate(req.channel, key, throttled ? { ...(reading ?? {}), retryAfterSec: reading?.retryAfterSec ?? (Number(responseHeaders.get('retry-after')) || 1) } : reading)
    const retryable429 = throttled && attempts <= maxRetries
    const retryableRead = req.kind === 'read' && (status === 0 || status >= 500) && attempts < 2
    if (retryable429 || retryableRead) continue
    break
  }

  // 8. classify
  const ok = status >= 200 && status < 300 && !graphqlErrors
  const verdict = ok ? null : classifyChannelAnswer(req.channel, status, text, { timedOut })

  // 9. ledger
  await recordGatewayCall({
    ...base,
    endpoint: safePath(url),
    statusCode: status || null,
    success: ok,
    latencyMs: Date.now() - started,
    outcome: 'sent',
    errorClass: verdict?.errorClass ?? null,
    errorCode: verdict?.channelCode ?? null,
    errorMessage: verdict?.channelMessage ?? null,
    rateLimitRemaining: reading?.remaining ?? null,
    rateLimitLimit: reading?.limit ?? null,
    attempts,
    requestPayload: ok ? undefined : ledgerSafeBody(req.body ?? null),
    responsePayload: ok ? undefined : ledgerSafeBody(text),
  })

  return {
    outcome: 'sent',
    ok,
    status,
    headers: responseHeaders,
    text,
    url,
    attempts,
    verdict,
    rate: { remaining: reading?.remaining ?? null, limit: reading?.limit ?? null },
    json<T>() {
      try { return text ? (JSON.parse(text) as T) : null } catch { return null }
    },
  }
}

/** The URL path for the ledger, with any query string dropped (it can carry buyer data or tokens). */
function safePath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url.split('?')[0]
  }
}
