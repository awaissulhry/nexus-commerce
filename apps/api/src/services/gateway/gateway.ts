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
import { accountStatusOf, googleAdsCustomerLinked, googleMerchantAccountLinked, googleMerchantDataSourceNexusMade } from './account.js'
import { googleMerchantCall, googleMerchantCallBodyOf, merchantReadAccount } from './google-merchant-calls.js'
import { googleAccountCallBodyOf, googleAdsAccountCall } from './google-account-calls.js'
import { metaAppSecretProof, metaReadOnlyProblem, metaRenewalOf, metaSendUrl } from './meta-calls.js'
import { writeLedgerRow } from './ledger.js'
import { SHOPIFY_API_VERSION } from '../shopify/api-version.js'
import { assertWriteAccount, type WriteTarget } from '../write-account-guard.js'
import { ebaySignatureAppliesTo } from '../cx/connectors/ebay/signing.js'
import {
  apiVersionOf, authHeadersOf, bucketGroupOf, ebayMarketHeaders, googleAdjustmentBodyOf, googleAdsAdjustmentCall, googleAdsExperimentCall, googleAdsMutateCustomer, googleAdsRecommendationCall, googleCallKind, googleDataManagerBodyOf, googleExperimentBodyOf, googleMutateBodyOf, googleRecommendationBodyOf, isGoogleDataManagerIngest, MarketUnconfigured, publishModeOf, rateReadingOf, sandboxUrlOf, shopifyGraphqlBodyOf,
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
  /**
   * How the call is authorised: the account's token (default), a token the caller holds, or none. Meta only: 'app' =
   * the connection's own Meta app token (`app-id|app-secret`, for debug_token), and a caller-held token may come with
   * its app secret (the connect-time check, before the connection holds them) so the gateway can sign it.
   */
  auth?: 'account' | 'none' | 'app' | { token: string; appSecret?: string }
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
    /**
     * RATE_LIMITED_LOCAL only: how long until this account's rate bucket has a slot, i.e. when the same
     * request can be sent again. Null for every other refusal.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'GatewayRefusal'
  }
}

const CHANNEL_NAME: Record<GatewayChannel, string> = { EBAY: 'eBay', AMAZON_SP: 'Amazon', SHOPIFY: 'Shopify', AMAZON_ADS: 'Amazon Ads', ETSY: 'Etsy', GOOGLE: 'Google', META: 'Meta' }
const LEDGER_CHANNEL: Record<GatewayChannel, 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'AMAZON_ADS' | 'ETSY' | 'GOOGLE' | 'META'> = { EBAY: 'EBAY', AMAZON_SP: 'AMAZON', SHOPIFY: 'SHOPIFY', AMAZON_ADS: 'AMAZON_ADS', ETSY: 'ETSY', GOOGLE: 'GOOGLE', META: 'META' }

/** A stable idempotency key for a write: the same parts always give the same key. */
export function idempotencyKeyFor(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)
}

async function tokenFor(req: GatewayRequest): Promise<string | null> {
  if (req.auth === 'none') return null
  if (req.auth && typeof req.auth === 'object') return req.auth.token
  if (!req.connectionId) return null
  if (req.auth === 'app') {
    if (req.channel !== 'META') throw new Error('an app token is a Meta call\'s only')
    return (await import('../cx/token.service.js')).metaAppAccessToken(req.connectionId)
  }
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
  const refuse = async (outcome: Exclude<GatewayOutcome, 'sent'>, code: string, message: string, statusCode: number, retryAfterMs: number | null = null): Promise<never> => {
    await writeLedgerRow({ ...base, statusCode: null, success: false, latencyMs: Date.now() - started, outcome, errorCode: code, errorMessage: message })
    throw new GatewayRefusal(outcome, code, message, statusCode, retryAfterMs)
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

  // 1c. Google — Nexus READS Google (Ads, Merchant Center, Analytics) and changes only Google Ads, through one
  // method: GoogleAdsService.Mutate (googleAdsMutateCustomer), holding only the kinds of operation Nexus sends, for a
  // customer the business chose through this connection. A validate-only mutate is a check (Google changes nothing)
  // and goes as a read; a real one goes as a write, under the publish mode (step 3). What is sent is the body as it
  // was judged (googleMutateBodyOf). Every other call is refused here, before the token or the network: by the kind
  // the caller declared AND by the method, path and body themselves (a real mutate declared as a read is still a
  // change). The refusal has its ledger row like every other.
  // G5 (2026-10-15): the one other Google Ads change — applying or dismissing Google's recommendations
  // (googleAdsRecommendationCall), judged the same way (googleRecommendationBodyOf); Google has no check for it, so it
  // always goes as a write, under the publish mode.
  // G8b (2026-10-15): the account's users, links and billing — each its own Google Ads method (googleAdsAccountCall),
  // its body judged to exactly what the account tools send (googleAccountCallBodyOf); a validate-only one is a check.
  // G9 (2026-10-15): an experiment's schedule / end / promote / graduate and a campaign draft's promote
  // (googleAdsExperimentCall), judged by googleExperimentBodyOf; Google has validate_only for each, so like a mutate a
  // check goes as a read and a real one as a write.
  // G8a (2026-10-15): sales sent to a Google Ads conversion action (the Data Manager API's events:ingest,
  // isGoogleDataManagerIngest) and their adjustments (ConversionAdjustmentUploadService, googleAdsAdjustmentCall), each
  // judged (googleDataManagerBodyOf, googleAdjustmentBodyOf): a check when validate-only, else a write under the publish
  // mode; for the account the business chose through this connection only.
  // G12 (2026-10-16): Merchant Center — the changes the Merchant tools send (googleMerchantCall: product inputs into a data
  // source, data sources, promotions), each body judged to exactly what they send (googleMerchantCallBodyOf); the Merchant
  // API has no check, so each is a write under the publish mode. Reads and changes alike go only to a Merchant Center
  // account this business chose through this connection (googleMerchantAccountLinked): an id never crosses businesses.
  // Every change but a create writes only into a data source Nexus made for this business (its own change records,
  // googleMerchantDataSourceNexusMade): never the primary feed of Shopify's Google channel. A read whose path seems to
  // name an account the gateway cannot read is refused (fail closed).
  let googleBody: string | null = null
  const merchant = req.channel === 'GOOGLE' ? googleMerchantCall(req.method, req.url) : null
  if (merchant) {
    const judged = googleMerchantCallBodyOf(merchant, req.body)
    if ('refusal' in judged) {
      return refuse('refused', 'GOOGLE_READ_ONLY', `Nothing was sent to Google: this Merchant Center change is not one Nexus sends (${req.method} ${safePath(req.url)}: ${judged.refusal}).`, 403)
    }
    if (req.kind !== 'write') return refuse('refused', 'GOOGLE_READ_ONLY', `Nothing was sent to Google: a Merchant Center change is a write (${req.method} ${safePath(req.url)}: the kind declared is not the call's).`, 403)
    if (!req.connectionId || !(await googleMerchantAccountLinked(req.connectionId, merchant.account))) {
      return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Merchant Center account ${merchant.account} is not the Merchant Center account this business chose through this Google connection.`, 403)
    }
    if (merchant.kind !== 'dataSources:create' && (!judged.dataSource || !(await googleMerchantDataSourceNexusMade(merchant.account, judged.dataSource)))) {
      return refuse('refused', 'GOOGLE_DATA_SOURCE_NOT_NEXUS', `Nothing was sent to Google: Merchant Center data source ${judged.dataSource ?? '(none named)'} is not one Nexus made for this business, and Nexus changes no other (never the primary feed of Shopify's Google channel).`, 403)
    }
    googleBody = judged.body
  } else if (req.channel === 'GOOGLE') {
    const merchantRead = googleCallKind(req.method, req.url) === 'read' ? merchantReadAccount(req.url) : null
    if (merchantRead === 'unreadable') {
      return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: this Merchant Center read names an account Nexus cannot read from its path (${safePath(req.url)}), so it cannot check it is the one this business chose.`, 403)
    }
    if (merchantRead && (!req.connectionId || !(await googleMerchantAccountLinked(req.connectionId, merchantRead.account)))) {
      return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Merchant Center account ${merchantRead.account} is not the Merchant Center account this business chose through this Google connection.`, 403)
    }
  }
  if (req.channel === 'GOOGLE' && !merchant) {
    const customer = googleAdsMutateCustomer(req.method, req.url)
    const recommendation = customer === null ? googleAdsRecommendationCall(req.method, req.url) : null
    const accountCall = customer === null && recommendation === null ? googleAdsAccountCall(req.method, req.url) : null
    const experiment = customer === null && recommendation === null && accountCall === null ? googleAdsExperimentCall(req.method, req.url) : null
    const adjustment = customer === null && !recommendation && !accountCall && !experiment ? googleAdsAdjustmentCall(req.method, req.url) : null
    const ingest = customer === null && !recommendation && !accountCall && !experiment && !adjustment && isGoogleDataManagerIngest(req.method, req.url)
    const readOnly = (detail: string) => refuse('refused', 'GOOGLE_READ_ONLY', `Nothing was sent to Google: Nexus only reads Google and changes Google Ads only through a mutate (or an apply or dismiss of its recommendations, an account call of its users, links and billing, an experiment or campaign draft action, sales sent to a conversion action and their adjustments, or a Merchant Center product input, data source or promotion), and this call is none of them (${req.method} ${safePath(req.url)}${detail}).`, 403)
    const notChosen = (id: string) => refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Google Ads account ${id} is not the account this business chose through this Google connection.`, 403)
    if (accountCall) {
      const judged = googleAccountCallBodyOf(accountCall, req.body)
      if ('refusal' in judged) return readOnly(`: ${judged.refusal}`)
      if (req.kind !== (judged.check ? 'read' : 'write')) return readOnly(': the kind declared is not the body\'s')
      if (!req.connectionId || !(await googleAdsCustomerLinked(req.connectionId, accountCall.customer))) {
        return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Google Ads account ${accountCall.customer} is not the account this business chose through this Google connection.`, 403)
      }
      googleBody = judged.body
    } else if (experiment) {
      const judged = googleExperimentBodyOf(experiment, req.body)
      if ('refusal' in judged) return readOnly(`: ${judged.refusal}`)
      if (req.kind !== (judged.check ? 'read' : 'write')) return readOnly(': the kind declared is not the body\'s')
      if (!req.connectionId || !(await googleAdsCustomerLinked(req.connectionId, experiment.customer))) {
        return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Google Ads account ${experiment.customer} is not the account this business chose through this Google connection.`, 403)
      }
      googleBody = judged.body
    } else if (ingest || adjustment) {
      const judged: { check: boolean; body: string; customer?: string } | { refusal: string } = adjustment ? googleAdjustmentBodyOf(adjustment, req.body) : googleDataManagerBodyOf(req.body)
      if ('refusal' in judged) return readOnly(`: ${judged.refusal}`)
      if (req.kind !== (judged.check ? 'read' : 'write')) return readOnly(': the kind declared is not the body\'s')
      // The account the call acts on: an adjustment's is the customer in its URL (Google uses only the action id inside the
      // body, never its customer part); a sale's is the destination's operating account.
      const account = adjustment ? adjustment.customer : judged.customer ?? ''
      if (!req.connectionId || !(await googleAdsCustomerLinked(req.connectionId, account))) return notChosen(account)
      googleBody = judged.body
    } else if (recommendation) {
      const judged = googleRecommendationBodyOf(recommendation, req.body)
      if ('refusal' in judged) return readOnly(`: ${judged.refusal}`)
      if (req.kind !== 'write') return readOnly(': the kind declared is not the body\'s')
      if (!req.connectionId || !(await googleAdsCustomerLinked(req.connectionId, recommendation.customer))) {
        return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Google Ads account ${recommendation.customer} is not the account this business chose through this Google connection.`, 403)
      }
      googleBody = judged.body
    } else if (customer === null) {
      if (req.kind !== 'read' || googleCallKind(req.method, req.url) !== 'read') return readOnly('')
    } else {
      const judged = googleMutateBodyOf(req.body, customer)
      if ('refusal' in judged) return readOnly(`: ${judged.refusal}`)
      if (req.kind !== (judged.check ? 'read' : 'write')) return readOnly(': the kind declared is not the body\'s')
      if (!req.connectionId || !(await googleAdsCustomerLinked(req.connectionId, customer))) {
        return refuse('refused', 'GOOGLE_ACCOUNT_NOT_CHOSEN', `Nothing was sent to Google: Google Ads account ${customer} is not the account this business chose through this Google connection.`, 403)
      }
      googleBody = judged.body
    }
  }

  // 1d. Meta (M1, 2026-10-20) — Nexus only READS Meta: a GET with no body, to the pinned Graph version, that is not a
  // method override, a batch, a token revoke or any sign-in call but the system-user token renewal (meta-calls.ts).
  // Refused before the account, the token or the network, by the kind declared AND by the method and URL themselves.
  if (req.channel === 'META') {
    const problem = metaReadOnlyProblem({ method: req.method, url: req.url, kind: req.kind, body: req.body, auth: req.auth, headers: req.headers })
    if (problem) return refuse('refused', 'META_READ_ONLY', `Nothing was sent to Meta: ${problem} (${req.method} ${safePath(req.url)}).`, 403)
    // The renewal names the app it is for: it must be THIS connection's own app, never another.
    const renewal = metaRenewalOf(req.url)
    if (renewal) {
      const appId = req.connectionId ? await (await import('../cx/token.service.js')).metaAppIdOf(req.connectionId) : null
      if (!appId || renewal.clientId !== appId) return refuse('refused', 'META_READ_ONLY', 'Nothing was sent to Meta: a token renewal is sent only for the connection\'s own Meta app.', 403)
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
  // Meta: the token and its appsecret_proof go on the URL that is sent (never on `url`, which the ledger, the trace and
  // the answer carry). The proof is made from the app secret the token service holds for this connection, or from the
  // one a connect-time caller passes; with neither, nothing is sent.
  let sendUrl = url
  if (req.channel === 'META' && token) {
    let proof: { appsecret_proof: string; appsecret_time: string } | null = null
    try {
      proof = req.auth && typeof req.auth === 'object'
        ? (req.auth.appSecret ? metaAppSecretProof(token, req.auth.appSecret) : null)
        : req.connectionId ? await (await import('../cx/token.service.js')).metaRequestProof(req.connectionId, token) : null
    } catch (err) {
      return refuse('held', 'META_APP_SECRET_UNAVAILABLE', `Held, nothing sent: the Meta app secret of this account could not be read (${err instanceof Error ? err.message : String(err)}).`, 409)
    }
    if (!proof) return refuse('held', 'META_APP_SECRET_UNAVAILABLE', 'Held, nothing sent: no Meta app secret is stored for this account, so the call cannot carry its appsecret_proof. Enter the app id and secret again in Settings → Channels → Meta.', 409)
    sendUrl = metaSendUrl(url, token, proof)
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
      return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the ${name} rate limit for this account needs ${Math.ceil(slot.waitMs / 1000)} s more. Retry later.`, 429, slot.waitMs)
    }
    attempts++
    timedOut = false
    try {
      // Never follow a redirect: a channel call carries its token in a header, and a custom token header
      // (x-amz-access-token, X-Shopify-Access-Token) would travel to the redirect's host.
      const res = await fetch(sendUrl, { method: req.method, headers, body: (googleBody ?? req.body ?? undefined) as RequestInit["body"], redirect: 'error', signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 30_000)]) : AbortSignal.timeout(req.timeoutMs ?? 30_000) })
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
  if (req.channel === 'META' && verdict) {
    // Meta answers a throttle with an error code (often with no usage header): hold the bucket all the same — 300 s, the
    // block Meta's rate-limit page names for an ad account's score; an hour for ad-set budget changes (613/1487632).
    if (verdict.errorClass === 'rate_limited' && !reading?.retryAfterSec) {
      await observeRate(req.channel, key, { retryAfterSec: verdict.channelCode === '613/1487632' ? 3600 : 300 })
    }
    // Meta says the token is dead: the next heartbeat checks it again at once, rather than trusting a check kept for hours.
    if ((verdict.errorClass === 'auth_revoked' || verdict.errorClass === 'auth_expired') && req.connectionId) {
      const connectionId = req.connectionId
      void import('../cx/connectors/meta/token-check.js').then((m) => m.forgetMetaTokenCheck(connectionId)).catch(() => undefined)
    }
  }

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
