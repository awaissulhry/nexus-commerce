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
import { accountStatusOf, googleAdsCustomerLinked, googleMerchantAccountLinked, googleMerchantDataSourceNexusMade, metaChosenAdAccountOf, metaStoredObject } from './account.js'
import { googleMerchantCall, googleMerchantCallBodyOf, merchantReadAccount } from './google-merchant-calls.js'
import { googleAccountCallBodyOf, googleAdsAccountCall } from './google-account-calls.js'
import { META_REST_API_VERSION, metaAppSecretProof, metaCallVerdict, metaSendUrl, metaWriteVerdict, scrubMetaAnswer, type MetaJudgedWrite } from './meta-calls.js'
import { holdMetaObject, metaObjectState, metaObjectWait, noteMetaObjectTouched } from './meta-object-limits.js'
import { metaGraphBase } from '../meta/api-version.js'
import { META_KIND_FIELDS } from '../meta/meta-kinds.js'
import { writeLedgerRow } from './ledger.js'
import { SHOPIFY_API_VERSION } from '../shopify/api-version.js'
import { assertWriteAccount, type WriteTarget } from '../write-account-guard.js'
import { ebaySignatureAppliesTo } from '../cx/connectors/ebay/signing.js'
import {
  apiVersionOf, authHeadersOf, bucketGroupOf, ebayMarketHeaders, googleAdjustmentBodyOf, googleAdsAdjustmentCall, googleAdsExperimentCall, googleAdsMutateCustomer, googleAdsRecommendationCall, googleCallKind, googleDataManagerBodyOf, googleExperimentBodyOf, googleMutateBodyOf, googleRecommendationBodyOf, isGoogleDataManagerIngest, MarketUnconfigured, publishModeOf, rateReadingOf, sandboxUrlOf, shopifyGraphqlBodyOf,
} from './channels.js'
import { bucketKey, observeRate, takeToken } from './rate.js'
import { ledgerSafeBody } from './redact.js'
import { classifyChannelAnswer, metaErrorOf, type ChannelVerdict, type GatewayChannel } from './vocabulary.js'
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
  /**
   * Meta step 17 (review fix B4): a change of an object by id names the KIND of object it changes. The gateway does not
   * trust it: it confirms it (the business's stored row, or a field only that kind has in its one live read) and refuses
   * the change otherwise, so the write allow-list is literally a campaign, an ad set or an ad — never a creative or a Page.
   */
  metaObjectKind?: 'campaign' | 'adset' | 'ad' | 'highdemandperiod' | 'customaudience' | 'adaccount'
  /**
   * Meta step 18: a change of a budget schedule (high-demand period, `metaObjectKind: 'highdemandperiod'`) names the
   * campaign or ad set it belongs to; the gateway confirms that object is of the chosen ad account AND lists the period
   * among its own budget schedules before anything is sent.
   */
  metaParent?: { kind: 'campaign' | 'adset'; id: string }
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

  // 1d. Meta (M1, 2026-10-20) — a READ is a GET with no body, to the pinned Graph version, that is not a method override,
  // a batch, a token revoke or any sign-in call but the system-user token renewal (meta-calls.ts metaCallVerdict).
  // Step 17 (2026-10-21) — anything else is judged by the write ALLOW-list (metaWriteVerdict): today a status change of
  // one campaign, ad set or ad, or Meta's check of one (validate_only: a read). Every batch is refused (none allowed yet).
  // Refused before the account, the token or the network, by the kind declared AND by the method, URL and body
  // themselves; what is sent is the body as it was judged. The object's ad account is checked after the status (3b).
  let metaRenewal = false
  let metaWrite: MetaJudgedWrite | null = null
  // Step 16 — a read of Meta's REST host (api.facebook.com): its token goes as a Bearer header (meta-calls.ts).
  let metaRest = false
  if (req.channel === 'META' && req.method !== 'GET') {
    const judged = metaWriteVerdict({ method: req.method, url: req.url, kind: req.kind, body: req.body, auth: req.auth, headers: req.headers, objectKind: req.metaObjectKind })
    if ('problem' in judged) {
      return refuse('refused', judged.batch ? 'META_BATCH_NOT_ALLOWED' : 'META_WRITE_NOT_ALLOWED', `Nothing was sent to Meta: ${judged.problem} (${req.method} ${safePath(req.url)}).`, 403)
    }
    if (!req.connectionId) return refuse('refused', 'ACCOUNT_REQUIRED', 'Nothing was sent to Meta: a change names the Meta connection it is for.', 400)
    // Review fix A2 — Meta's check is a POST Meta must honour: with Meta changes switched off, none is sent either.
    if (judged.write.check && publishModeOf('META') !== 'live') {
      return refuse('gated', 'PUBLISH_GATED', 'Nothing was sent to Meta: Meta changes are switched off in Nexus (NEXUS_META_ADS_WRITES), so Meta is not asked to check one either.', 503)
    }
    metaWrite = judged.write
  } else if (req.channel === 'META') {
    // One verdict on one canonical parse (meta-calls.ts): the refusal, and for the renewal the client_id it names.
    const judged = metaCallVerdict({ method: req.method, url: req.url, kind: req.kind, body: req.body, auth: req.auth, headers: req.headers })
    if (judged.problem) return refuse('refused', 'META_READ_ONLY', `Nothing was sent to Meta: ${judged.problem} (${req.method} ${safePath(req.url)}).`, 403)
    metaRest = judged.rest === true
    // The renewal names the app it is for: it must be THIS connection's own app, never another.
    if (judged.renewalClientId !== null) {
      const appId = req.connectionId ? await (await import('../cx/token.service.js')).metaAppIdOf(req.connectionId) : null
      if (!appId || judged.renewalClientId !== appId) return refuse('refused', 'META_READ_ONLY', 'Nothing was sent to Meta: a token renewal is sent only for the connection\'s own Meta app.', 403)
      metaRenewal = true
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
  // A Meta change never skips it (step 17): Meta's writes brake (NEXUS_META_ADS_WRITES=off) holds whatever the caller says.
  if (req.kind === 'write' && (!req.modeAppliedByCaller || req.channel === 'META')) {
    const mode = publishModeOf(req.channel)
    if (mode === 'gated') return refuse('gated', 'PUBLISH_GATED', `Nothing was sent to ${name}: ${name} publishing is switched off.`, 503)
    if (mode === 'dry-run') return refuse('would_send', 'DRY_RUN', `Dry run: this ${req.operation} would be sent to ${name}. Nothing was sent.`, 200)
    if (mode === 'sandbox') {
      const sandbox = sandboxUrlOf(req.channel, req.url)
      if (!sandbox) return refuse('gated', 'NO_SANDBOX_HOST', `Nothing was sent to ${name}: publishing is in sandbox mode and this call has no sandbox host.`, 503)
      url = sandbox
    }
  }

  // 3b. Meta step 17 — a change (or Meta's check of one) names an object by id (POST /<id>), never its ad account: the
  // object must be of the ad account THIS business chose through THIS connection (its own stored rows, else ONE live
  // read of its account_id), and Meta's check only for a campaign (Meta documents validate_only on campaign updates
  // only). Then Meta's per-object limits: a change waits 30 s after the last one of the same object, and an ad set's
  // budget changes wait out Meta's hour (meta-object-limits.ts).
  if (metaWrite && req.connectionId) {
    const owner = await metaOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind, req.metaParent)
      ?? await metaBodyIdsProblem(req.connectionId, metaWrite)
    if (owner) return refuse('refused', owner.code, owner.sentence, 403)
    if (!metaWrite.check) {
      const wait = metaObjectWait(await metaObjectState(req.connectionId, metaWrite.objectId), metaWrite.budget)
      if (wait) return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: ${wait.why}. Retry in ${Math.ceil(wait.waitMs / 1000)} s; nothing was changed.`, 429, wait.waitMs)
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
    // A Meta change is a form (Meta's `-F` fields), as the gateway judged it.
    ...(metaWrite ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
  }
  // Meta: the token and its appsecret_proof go on the URL that is sent (never on `url`, which the ledger, the trace and
  // the answer carry). The proof is made from the app secret the token service holds for this connection, or from the
  // one a connect-time caller passes; with neither, nothing is sent.
  let sendUrl = url
  // Step 16 — Meta's REST host takes the account's token as `Authorization: Bearer` with its API version header, never on
  // the URL; Meta documents no appsecret_proof there (meta-calls.ts metaRestVerdict). No redirect is ever followed.
  if (req.channel === 'META' && token && metaRest) {
    headers.Authorization = `Bearer ${token}`
    headers['X-API-Version'] = META_REST_API_VERSION
  }
  if (req.channel === 'META' && token && !metaRest) {
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
  // Review 3 — the token a renewal exchanges is the connection's own stored token, filled here (a caller cannot name one:
  // meta-calls.ts refuses it). Like the token above, it goes only on the URL that is sent.
  if (req.channel === 'META' && metaRenewal) {
    let current: string
    try {
      current = await (await import('../cx/token.service.js')).metaRenewalToken(req.connectionId!)
    } catch (err) {
      return refuse('held', 'META_TOKEN_UNAVAILABLE', `Held, nothing sent: the stored Meta token of this account could not be read (${err instanceof Error ? err.message : String(err)}).`, 409)
    }
    const renewal = new URL(url)
    renewal.searchParams.set('fb_exchange_token', current)
    sendUrl = renewal.toString()
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
  // A Meta change is never repeatable, whatever the caller says (step 17): a 5xx or no answer may have applied it.
  const repeatable = (req.kind === 'read' || req.idempotent === true || req.method === 'PUT' || req.method === 'DELETE') && !(metaWrite && !metaWrite.check)
  let throttleRetries = 0
  let transientRetries = 0
  let attempts = 0
  let status = 0
  let text = ''
  let responseHeaders = new Headers()
  let timedOut = false
  let reading: { remaining?: number; limit?: number; retryAfterSec?: number } | null = null
  let graphqlErrors = false
  let metaScrubbed = 0
  for (;;) {
    // Meta scores a write 3 points and a read 1 (rate-limiting page); its check of a change is counted as a write.
    const slot = await takeToken(req.channel, key, req.maxRateWaitMs ?? 30_000, undefined, metaWrite ? 3 : 1)
    if (!slot.ok) {
      return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the ${name} rate limit for this account needs ${Math.ceil(slot.waitMs / 1000)} s more. Retry later.`, 429, slot.waitMs)
    }
    attempts++
    timedOut = false
    try {
      // Never follow a redirect: a channel call carries its token in a header, and a custom token header
      // (x-amz-access-token, X-Shopify-Access-Token) would travel to the redirect's host.
      const res = await fetch(sendUrl, { method: req.method, headers, body: (googleBody ?? metaWrite?.body ?? req.body ?? undefined) as RequestInit["body"], redirect: 'error', signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 30_000)]) : AbortSignal.timeout(req.timeoutMs ?? 30_000) })
      status = res.status
      responseHeaders = res.headers
      text = await res.text()
      // Review 2 — no token leaves the gateway in a Meta answer (the renewal's own answer IS the new token).
      if (req.channel === 'META' && !metaRenewal) {
        const clean = scrubMetaAnswer(text)
        text = clean.text
        metaScrubbed += clean.scrubbed
      }
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
  // Meta step 31 review A4 — an answer to people's hashed data keeps only Meta's own code and message fields, never its raw text.
  if (verdict && metaWrite?.personal) verdict.channelMessage = metaPersonalWords(text, status)
  // Step 17 — what Meta's per-object limits learn from a change or a check of one: it reached Meta (or may have), or Meta
  // held that one object (613/4841018: 30 s for its changes; 613/1487632: an hour for that ad set's budget changes).
  const objectLimit = verdict?.channelCode === '613/4841018' ? 'edits' : verdict?.channelCode === '613/1487632' ? 'budget' : null
  if (req.channel === 'META' && metaWrite && req.connectionId) {
    if (objectLimit) await holdMetaObject(req.connectionId, metaWrite.objectId, objectLimit)
    else if (ok || status === 0 || status >= 500) await noteMetaObjectTouched(req.connectionId, metaWrite.objectId, { budget: ok && metaWrite.budget && !metaWrite.check })
  }
  if (req.channel === 'META' && verdict) {
    // Meta answers a throttle with an error code (often with no usage header): hold the bucket all the same — 300 s, the
    // block Meta's rate-limit page names for an ad account's score. The two per-object limits (4841018, 1487632) hold only
    // that object (above), never the account's whole bucket.
    if (verdict.errorClass === 'rate_limited' && !reading?.retryAfterSec && !objectLimit) {
      await observeRate(req.channel, key, { retryAfterSec: 300 })
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
    // Meta step 31 — a body of people's hashed data (an audience's people) and Meta's answer to it are never kept: only their size.
    requestPayload: ok ? undefined : metaWrite?.personal ? { __personal: true, bytes: metaWrite.body.length } : typeof req.body === 'string' || req.body == null ? ledgerSafeBody(req.body ?? null) : { __binary: true, bytes: req.body instanceof Uint8Array ? req.body.byteLength : null },
    // Review 2 — how many access_token keys were dropped from a Meta answer (it never reaches the ledger either).
    responsePayload: metaWrite?.personal ? (ok ? undefined : { __personal: true, bytes: text.length }) : metaScrubbed ? { scrubbed: metaScrubbed, ...(ok ? {} : { body: ledgerSafeBody(text) }) } : ok ? undefined : ledgerSafeBody(text),
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

/**
 * TWO fields only that kind of object has together, both always set on it: the ONE table of kinds (services/meta/meta-kinds.ts,
 * step 6 review fix A1), of which a change names a campaign, an ad set or an ad.
 */
const META_KIND_FIELD: Readonly<Record<'campaign' | 'adset' | 'ad' | 'customaudience', readonly [string, string]>> = {
  campaign: META_KIND_FIELDS.campaign,
  adset: META_KIND_FIELDS.adset,
  ad: META_KIND_FIELDS.ad,
  // Step 18 — only as an id INSIDE a change's body (an ad set's customer exclusions), never the object a change names.
  customaudience: META_KIND_FIELDS.customaudience,
}
const META_KIND_WORD: Readonly<Record<'campaign' | 'adset' | 'ad' | 'customaudience', string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad', customaudience: 'custom audience' }

/**
 * Step 17 — why a Meta change (or Meta's check of one) of this object is refused for this connection, or null: the object
 * must be of the ad account the business chose through it, AND of the kind the change names (review fix B4: the
 * allow-list is a campaign, an ad set or an ad — nothing else Meta numbers the same way). From the business's own stored
 * rows (row-level security), else ONE live read through this gateway (`GET /<id>?fields=account_id,<two fields only
 * that kind has>`). Meta's check only for a campaign (Meta documents validate_only on campaign updates only). An object Nexus
 * cannot place, of another kind, or of any other account (another business's too) gets nothing sent; the sentence never
 * names the other account.
 */
async function metaOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: 'campaign' | 'adset' | 'ad' | 'customaudience' | 'highdemandperiod' | 'adaccount' | undefined, parent?: { kind: 'campaign' | 'adset'; id: string }): Promise<{ code: string; sentence: string } | null> {
  const id = write.objectId
  // Step 18 — a budget schedule: its campaign or ad set first, then the period among that object's own.
  if (kind === 'highdemandperiod') return metaPeriodOwnerProblem(connectionId, write, parent)
  // Step 31 — a change on the ad account itself (its audiences, its existing customers, its people opted out): the chosen one.
  if (kind === 'adaccount') return metaAdAccountOwnerProblem(connectionId, id)
  if (!kind || !Object.prototype.hasOwnProperty.call(META_KIND_FIELD, kind)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change of ${id} names the kind of object it changes (a campaign, an ad set or an ad).` }
  if (write.check && kind !== 'campaign') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: Meta has a check (validate_only) only for campaign changes, and ${id} is named a ${META_KIND_WORD[kind]}.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.' }
  const notChosen = { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: object ${id} is not of the Meta ad account this business chose through this connection.` }
  const notKind = (detail = '') => ({ code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is not a ${META_KIND_WORD[kind]} Nexus can confirm${detail}; a Nexus change writes only a campaign, an ad set or an ad of its own kind.` })
  const stored = await metaStoredObject(id)
  if (stored) {
    if (stored.adAccountId !== chosen) return notChosen
    return stored.kind !== kind ? notKind(` (Nexus has it as a ${META_KIND_WORD[stored.kind]})`) : null
  }
  const url = new URL(`${metaGraphBase()}/${id}`)
  url.searchParams.set('fields', ['account_id', ...META_KIND_FIELD[kind]].join(','))
  let answer: GatewayResponse
  try {
    answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
  } catch (err) {
    return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm which ad account ${id} belongs to (${err instanceof Error ? err.message : String(err)}).` }
  }
  const body = answer.ok ? answer.json<Record<string, unknown>>() : null
  const account = body && (typeof body.account_id === 'string' || typeof body.account_id === 'number') ? String(body.account_id).replace(/^act_/, '') : null
  if (!account || !/^\d{1,25}$/.test(account)) {
    // Meta refuses the kind's own field for another kind ("nonexisting field"): not the kind named.
    if (!answer.ok && /nonexisting field/i.test(answer.verdict?.channelMessage ?? '')) return notKind(` (Meta: ${answer.verdict!.channelMessage})`)
    return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm which ad account ${id} belongs to${answer.verdict?.channelMessage ? ` (Meta: ${answer.verdict.channelMessage})` : ''}.` }
  }
  if (account !== chosen) return notChosen
  // Both of the kind's own fields, each present with a value.
  if (META_KIND_FIELD[kind].some((name) => { const value = body?.[name]; return value === undefined || value === null || value === '' })) return notKind()
  return null
}

/**
 * Meta step 18 — a budget schedule (high-demand period) has no account_id of its own: the change names its campaign or ad
 * set (`metaParent`), which must be of the chosen ad account (metaOwnerProblem), and the period must be one of that
 * object's own budget schedules (ONE live read of `/<campaign | ad set>/budget_schedules`, at most 50 per object — Meta's
 * limit, high-demand-period.md). Anything else: nothing is sent.
 */
async function metaPeriodOwnerProblem(connectionId: string, write: MetaJudgedWrite, parent: { kind: 'campaign' | 'adset'; id: string } | undefined): Promise<{ code: string; sentence: string } | null> {
  const id = write.objectId
  if (!parent || (parent.kind !== 'campaign' && parent.kind !== 'adset') || !/^\d{1,20}$/.test(parent.id)) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change of budget schedule ${id} names the campaign or ad set it belongs to.` }
  }
  const owner = await metaOwnerProblem(connectionId, { ...write, objectId: parent.id, check: false }, parent.kind)
  if (owner) return owner
  const listed = await metaListedIds(connectionId, `${parent.id}/budget_schedules`)
  if (listed === null) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not read the budget schedules of ${META_KIND_WORD[parent.kind]} ${parent.id} to confirm ${id} is one of them.` }
  return listed.has(id) ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is not a budget schedule of ${META_KIND_WORD[parent.kind]} ${parent.id}.` }
}

/**
 * Meta step 31 — a change on the ad account itself (`act_<id>`, `act_<id>/customaudiences | product_audiences |
 * usersofanyaudience`): it must be the ad account THIS business chose through THIS connection.
 */
async function metaAdAccountOwnerProblem(connectionId: string, objectId: string): Promise<{ code: string; sentence: string } | null> {
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.' }
  return objectId === `act_${chosen}` ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${objectId} is not the Meta ad account this business chose through this connection.` }
}

/**
 * Meta step 31 review A4 — the words kept of an error answer to people's hashed data (an audience's people): Meta's own
 * title, message and code fields only (metaErrorOf), never the raw answer text (it could echo what was sent).
 */
function metaPersonalWords(text: string, status: number): string {
  const e = metaErrorOf(text)
  const said = e.userTitle && e.userMessage ? `${e.userTitle}: ${e.userMessage}` : e.userMessage ?? e.userTitle ?? e.message
  return said ? said.slice(0, 500) : `Meta answered HTTP ${status || 'nothing'} without an error message.`
}

/** The ids of one Meta list (fields=id, at most 100, one page), or null when it could not be read. */
async function metaListedIds(connectionId: string, path: string): Promise<Set<string> | null> {
  const url = new URL(`${metaGraphBase()}/${path}`)
  url.searchParams.set('fields', 'id')
  url.searchParams.set('limit', '100')
  try {
    const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
    const body = answer.ok ? answer.json<{ data?: Array<{ id?: unknown }>; paging?: { next?: unknown } }>() : null
    if (!body || !Array.isArray(body.data)) return null
    const ids = new Set(body.data.map((row) => (typeof row?.id === 'string' || typeof row?.id === 'number' ? String(row.id) : '')).filter(Boolean))
    // More than one page: the id may be on the next one — not confirmed (a Nexus change never pages for its check).
    return body.paging?.next ? null : ids
  } catch {
    return null
  }
}

/**
 * Meta step 18 — the ids INSIDE a change's body (meta-settings-rules.ts `ids`): the child ad sets of a campaign's budget
 * or bid move, the ads of a sequence or rotation, the custom audiences an ad set excludes — each of the chosen ad account
 * and of its kind (its stored row, else one live read of its account_id and two fields only that kind has); the pixel of
 * a promoted object — one of the chosen ad account's own pixels (`act_<id>/adspixels`); its catalog or product set — the
 * catalog rule (review A4). Any other: nothing is sent.
 */
async function metaBodyIdsProblem(connectionId: string, write: MetaJudgedWrite): Promise<{ code: string; sentence: string } | null> {
  if (!write.ids?.length) return null
  if (write.ids.length > 150) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: a change names at most 150 objects inside its body.' }
  let pixels: Set<string> | null | undefined
  for (const inner of write.ids) {
    // Step 31 — a campaign or ad set a lookalike learns from: either kind, of the chosen ad account.
    if (inner.kind === 'campaignOrAdset') {
      const asCampaign = await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, 'campaign')
      const problem = asCampaign ? await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, 'adset') : null
      if (asCampaign && problem) return { code: problem.code, sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a campaign or ad set Nexus can confirm of the Meta ad account this business chose.` }
      continue
    }
    // Step 31 — a Page, Instagram account, lead form, Instant Experience or video an audience is built from, or an ad
    // account it is shared with: the read side's own ownership rules (marketing/meta-ads/audience-ids.ts).
    if (inner.kind === 'page' || inner.kind === 'instagram' || inner.kind === 'leadform' || inner.kind === 'canvas' || inner.kind === 'video' || inner.kind === 'adaccount') {
      const { metaAudienceIdProblem } = await import('../marketing/meta-ads/audience-ids.js')
      const problem = await metaAudienceIdProblem(connectionId, { id: inner.id, kind: inner.kind })
      if (problem) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${problem}` }
      continue
    }
    // Review A4 — a catalog or a product set: the ONE catalog rule (marketing/meta-ads/catalog-rule.ts): of the chosen ad
    // account's business portfolio, and that portfolio no other Nexus business's.
    if (inner.kind === 'catalog' || inner.kind === 'productset') {
      const chosen = await metaChosenAdAccountOf(connectionId)
      if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection.' }
      const { metaCatalogProblem } = await import('../marketing/meta-ads/catalog-rule.js')
      const problem = await metaCatalogProblem({ connectionId, adAccountId: chosen }, inner.kind === 'catalog' ? { catalogId: inner.id } : { productSetId: inner.id })
      if (problem) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${problem}` }
      continue
    }
    if (inner.kind === 'pixel') {
      if (pixels === undefined) {
        const chosen = await metaChosenAdAccountOf(connectionId)
        pixels = chosen ? await metaListedIds(connectionId, `act_${chosen}/adspixels`) : null
      }
      if (!pixels?.has(inner.id)) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: pixel ${inner.id} is not one Nexus can confirm among the chosen ad account's own pixels.` }
      continue
    }
    const problem = await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, inner.kind)
    if (problem) return { code: problem.code, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, `Nothing was sent to Meta: inside this change, `) }
  }
  return null
}

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
