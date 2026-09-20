/**
 * P1.1 (docs/channel-connections/FINAL-PLAN.md, section 5 item 1) — the ONE way Nexus calls a channel.
 *
 * Every call runs the same steps, in this order:
 *   1. account      — a write names its account (`connectionId`); it never falls back to the primary.
 *   2. status       — an account that needs sign-in (or is revoked / disconnected) is HELD, not called.
 *   3. publish mode — for writes: gated = nothing; dry-run = nothing, recorded as "would send";
 *                     sandbox = the channel's sandbox host, or nothing when it has none. Only
 *                     listing writes follow it (see `kind`); order actions have their own switches.
 *   4. push lock    — a listing that is paused, closed, ended or held by Presence is refused; and the
 *                     wrong-account guard (P0.7) for eBay / Amazon listing writes.
 *   5. headers      — the account's token, the market headers (eBay: marketplace id + language from the
 *                     Marketplace row, the one language authority), the eBay RFC 9421 signature on
 *                     its must-sign paths.
 *   6. rate bucket  — one token per call from the bucket of (channel, account, operation group); the
 *                     channel's own rate headers tune it; a 429 waits for its Retry-After and retries;
 *                     a network error / timeout / 5xx is retried (with a growing wait) only for a read
 *                     or a write that is safe to repeat — never for a write that could apply twice.
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
import { withSpan } from '../../utils/otel-setup.js'
import { assertPushAllowed, type PushLockListing } from '@nexus/shared/push-lock'
import { accountStatusOf } from './account.js'
import { writeLedgerRow } from './ledger.js'
import { SHOPIFY_API_VERSION } from '../shopify/api-version.js'
import { assertWriteAccount, type WriteTarget } from '../write-account-guard.js'
import { ebaySignatureAppliesTo } from '../cx/connectors/ebay/signing.js'
import {
  apiVersionOf, authHeadersOf, bucketGroupOf, ebayMarketHeaders, MarketUnconfigured, publishModeOf, rateReadingOf, sandboxUrlOf, shopifyGraphqlBodyOf,
} from './channels.js'
import { bucketKey, observeRate, takeToken } from './rate.js'
import { ledgerSafeBody } from './redact.js'
import { classifyChannelAnswer, type ChannelVerdict, type GatewayChannel } from './vocabulary.js'
import { watchForDeprecation } from '../cx/deprecation-watch.service.js'

export type GatewayOutcome = 'sent' | 'would_send' | 'gated' | 'refused' | 'held'
export type GatewayBody = string | FormData | Uint8Array | null

export interface GatewayRequest {
  channel: GatewayChannel
  /** Stable operation name for the ledger and dashboards, e.g. 'inventory.createOrReplaceInventoryItem'. */
  operation: string
  /**
   * read — changes nothing.
   * write — changes a listing (content, stock, price, images, end / relist): the publish mode, the push
   *   lock and the wrong-account guard apply.
   * action — a change that has its own switch at the call site: orders and buyers (refund, shipment,
   *   cancellation, label, feedback, message — P0.1: NEXUS_ENABLE_*_SHIP_CONFIRM, …_ORDER_CANCEL,
   *   …_BUY_SHIPPING) and marketing (promotions, markdowns, ads — NEXUS_EBAY_MARKDOWN_LIVE, …_VOLUME_LIVE,
   *   the ads write gate). The listing publish mode does not apply.
   * setup — plumbing the connection itself needs (event subscriptions, notification destinations, signing
   *   keys, app secrets): sent in every publish mode, because a switched-off channel must still be able to
   *   connect and receive events.
   * The account check, rate bucket, error class and ledger apply to all four.
   */
  kind: 'read' | 'write' | 'action' | 'setup'
  /** The account. Required for writes (never "the primary"); null only with `appLevel`. */
  connectionId: string | null
  /** An app-level call (grantless / our own app), not made for a seller account. */
  appLevel?: boolean
  /** Absolute PRODUCTION URL; the gateway moves it to the sandbox host in sandbox mode. */
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  /** Text, or a file upload (FormData / bytes). The ledger keeps text bodies (made safe) and only the size of a file. */
  body?: GatewayBody
  /** How the call is authorised: the account's token (default), a token the caller holds, or none. */
  auth?: 'account' | 'none' | { token: string }
  marketplace?: string | null
  /** eBay: one of the market's content languages (Marketplace.languages); default = the market's first. */
  contentLanguage?: string | null
  /**
   * eBay: who sets the marketplace / language headers. 'gateway' (default) — from the Marketplace row.
   * 'caller' — the call keeps the headers it sends (a path moved onto the gateway before P1.5 switches
   * its headers); `marketplace` is then only recorded on the ledger.
   */
  marketHeaders?: 'gateway' | 'caller'
  /** eBay: sign even when the path is not on the must-sign list. */
  sign?: boolean
  idempotencyKey?: string | null
  /** The listings this write touches, for the push lock. */
  pushLock?: ReadonlyArray<PushLockListing | null | undefined>
  /** eBay / Amazon listing writes: who owns what this write touches (P0.7 guard). */
  writeTarget?: WriteTarget
  /** The caller already applied the publish mode itself (a client moved onto the gateway as is). */
  modeAppliedByCaller?: boolean
  /**
   * For channels that report a failure inside a 2xx (eBay Trading's `<Ack>Failure</Ack>`): false = the
   * call failed. Without it, a 2xx is a success (Shopify GraphQL errors are read by the gateway itself).
   */
  answerOk?: (text: string) => boolean
  maxRateWaitMs?: number
  max429Retries?: number
  /**
   * A write that is safe to send twice (the same body gives the same result). PUT and DELETE are by
   * HTTP rule; a POST / PATCH is only when the caller says so (Amazon's listings PATCH is).
   */
  idempotent?: boolean
  /** Retries after a network error, a timeout or a 5xx — reads and idempotent writes only. Default 1. */
  maxTransientRetries?: number
  /** First wait before a transient retry, doubled each time. Default 1000 ms. */
  retryBackoffMs?: number
  timeoutMs?: number
  /** The caller's own deadline or cancel signal; combined with the gateway's timeout. */
  signal?: AbortSignal | null
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

const CHANNEL_NAME: Record<GatewayChannel, string> = { EBAY: 'eBay', AMAZON_SP: 'Amazon', SHOPIFY: 'Shopify', AMAZON_ADS: 'Amazon Ads', ETSY: 'Etsy' }
const LEDGER_CHANNEL: Record<GatewayChannel, 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'AMAZON_ADS' | 'ETSY'> = { EBAY: 'EBAY', AMAZON_SP: 'AMAZON', SHOPIFY: 'SHOPIFY', AMAZON_ADS: 'AMAZON_ADS', ETSY: 'ETSY' }

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

export function gatewayCall(req: GatewayRequest): Promise<GatewayResponse> {
  return withSpan(`${req.channel.toLowerCase()}.${req.operation}`, {
    channel: req.channel, operation: req.operation, marketplace: req.marketplace ?? undefined, 'http.method': req.method,
    'http.endpoint': safePath(req.url), 'listing.id': req.ledger?.listingId ?? undefined, 'product.id': req.ledger?.productId ?? undefined,
  }, () => runGatewayCall(req))
}

async function runGatewayCall(req: GatewayRequest): Promise<GatewayResponse> {
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
    await writeLedgerRow({ ...base, statusCode: null, success: false, latencyMs: Date.now() - started, outcome, errorCode: code, errorMessage: message })
    throw new GatewayRefusal(outcome, code, message, statusCode)
  }

  // 1. account
  if (!req.connectionId && !req.appLevel) {
    return refuse('refused', 'ACCOUNT_REQUIRED', `Nothing was sent to ${name}: the call does not name the account it is for.`, 400)
  }

  // 1b. P1.4 — a Shopify change (a write, an order action, a setup call) goes out only on the current
  // GraphQL Admin API with a named account: never REST, never an older version, never the env credential.
  // Reads are not changes (their version moves in P5.3).
  if (req.channel === 'SHOPIFY' && req.kind !== 'read') {
    const endpoint = new URL(req.url).pathname
    if (!req.connectionId || endpoint !== `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`) {
      return refuse('refused', 'SHOPIFY_LEGACY_WRITE', `Nothing was sent to Shopify: a change goes out only on the ${SHOPIFY_API_VERSION} GraphQL Admin API with a connected account (this call: ${req.method} ${endpoint}${req.connectionId ? '' : ', no account'}).`, 400)
    }
  }

  // 2. status
  if (req.connectionId) {
    const account = await accountStatusOf(req.connectionId)
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
  // P1.5 — eBay's three market headers (X-EBAY-C-MARKETPLACE-ID, Content-Language, Accept-Language) from
  // the Marketplace row, for the market the call names (`marketplace`, or its marketplace-id header).
  // A LISTING WRITE gets all three from the row — eBay stores content in the write's language, and the
  // old helpers sent en-US for Italy; a language the caller sends is kept only when it is one of that
  // market's languages, and a write to a market with no row is refused. Every other call only gets the
  // headers it left out (a read may ask for English labels on purpose).
  const callerHeaders: Record<string, string> = { ...(req.headers ?? {}) }
  const callerValue = (name: string) => Object.entries(callerHeaders).find(([k]) => k.toLowerCase() === name)?.[1]
  let marketHeaders: Record<string, string> = {}
  const market = req.marketplace ?? callerValue('x-ebay-c-marketplace-id') ?? null
  if (req.channel === 'EBAY' && market && req.marketHeaders !== 'caller') {
    const preferred = req.contentLanguage ?? callerValue('content-language') ?? null
    try {
      // A language the call CHOSE (`contentLanguage`) must be the market's; one it only sends in a header is
      // dropped for the market's default when it is not.
      marketHeaders = await ebayMarketHeaders(market, preferred).catch((err) => (req.contentLanguage ? Promise.reject(err) : ebayMarketHeaders(market)))
    } catch (err) {
      if (req.kind === 'write') {
        return err instanceof MarketUnconfigured
          ? refuse('refused', 'MARKET_UNCONFIGURED', `Nothing was sent to eBay: ${err.message}`, 400)
          : refuse('refused', 'MARKET_LOOKUP_FAILED', `Nothing was sent to eBay: the market's languages could not be read (${err instanceof Error ? err.message : String(err)}). Retry later.`, 503)
      }
    }
    if (req.kind === 'write') {
      for (const name of Object.keys(callerHeaders)) {
        if (/^(x-ebay-c-marketplace-id|content-language|accept-language)$/i.test(name)) delete callerHeaders[name]
      }
    } else {
      marketHeaders = Object.fromEntries(Object.entries(marketHeaders).filter(([name]) => callerValue(name.toLowerCase()) === undefined))
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...callerHeaders,
    ...marketHeaders,
    ...(token ? authHeadersOf(req.channel, token) : {}),
  }
  if (req.channel === 'EBAY' && (req.sign || ebaySignatureAppliesTo(url, req.method))) {
    if (req.body != null && typeof req.body !== 'string') {
      return refuse('refused', 'SIGNING_BINARY_BODY', 'Nothing was sent to eBay: a signed call with a file body is not supported by the gateway.', 400)
    }
    const { ebaySigningHeaders } = await import('../cx/connectors/ebay/client.js')
    Object.assign(headers, await ebaySigningHeaders({ environment: /sandbox/.test(new URL(url).hostname) ? 'sandbox' : 'production', method: req.method, url, body: (req.body as string | null | undefined) ?? null }))
  }

  // 6–7. rate bucket, send, 429 / transient retries
  const key = bucketKey(req.channel, req.connectionId, bucketGroupOf(req.channel, req.method, url))
  const max429 = req.max429Retries ?? 2
  const maxTransient = req.maxTransientRetries ?? 1
  const repeatable = req.kind === 'read' || req.idempotent === true || req.method === 'PUT' || req.method === 'DELETE'
  let throttleRetries = 0
  let transientRetries = 0
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
      // Never follow a redirect: a channel call carries its token in a header, and a custom token header
      // (x-amz-access-token, X-Shopify-Access-Token) would travel to the redirect's host.
      const res = await fetch(url, { method: req.method, headers, body: (req.body ?? undefined) as RequestInit["body"], redirect: 'error', signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 30_000)]) : AbortSignal.timeout(req.timeoutMs ?? 30_000) })
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
    if (throttled && throttleRetries < max429) { throttleRetries++; continue }
    if ((status === 0 || status >= 500) && repeatable && transientRetries < maxTransient) {
      await sleepMs((req.retryBackoffMs ?? 1000) * 2 ** transientRetries)
      transientRetries++
      continue
    }
    break
  }

  // 7b. P3.5 — deprecation watch. The channel telling us an endpoint is going away
  //     arrives on a SUCCESSFUL answer, which is why it is read here and not in the
  //     error path: `Sunset` rides on a 200 for months before anything starts failing.
  //     Fire-and-forget: this reports on a call, it is not part of one, and a slow
  //     notification must never be added to a channel call's latency.
  if (status >= 200 && status < 400) {
    void watchForDeprecation({ channel: req.channel, endpoint: safePath(url), headers: responseHeaders })
      .catch(() => { /* the watch logs its own failures; a call is never failed by it */ })
  }

  // 8. classify
  const ok = status >= 200 && status < 300 && !graphqlErrors && (req.answerOk ? req.answerOk(text) : true)
  const verdict = ok ? null : classifyChannelAnswer(req.channel, status, text, { timedOut })

  // 9. ledger
  await writeLedgerRow({
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
    requestPayload: ok ? undefined : typeof req.body === 'string' || req.body == null ? ledgerSafeBody(req.body ?? null) : { __binary: true, bytes: req.body instanceof Uint8Array ? req.body.byteLength : null },
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

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** No answer at all (network error or timeout) — thrown by `gatewayFetch`, as `fetch` itself throws. */
export class GatewayNoAnswer extends Error {
  constructor(readonly channel: GatewayChannel, readonly operation: string, readonly errorClass: 'network' | 'timeout', detail: string) {
    super(`${CHANNEL_NAME[channel]} did not answer (${operation}): ${detail}`)
    this.name = 'GatewayNoAnswer'
  }
}

/**
 * `gatewayCall` with the answer as a `Response`, so a `fetch(…)` call site moves onto the gateway without
 * changing how it reads the answer (`res.ok`, `res.status`, `res.json()`). No answer at all throws
 * `GatewayNoAnswer`; nothing sent throws the `GatewayRefusal`.
 */
export async function gatewayFetch(req: GatewayRequest): Promise<Response> {
  const res = await gatewayCall(req)
  if (res.status === 0) throw new GatewayNoAnswer(req.channel, req.operation, res.verdict?.errorClass === 'timeout' ? 'timeout' : 'network', res.text)
  const bodyless = res.status === 204 || res.status === 205 || res.status === 304
  return new Response(bodyless ? null : res.text, { status: res.status, headers: res.headers })
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
