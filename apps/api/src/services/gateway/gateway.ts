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
import { accountStatusOf, googleAdsCustomerLinked, googleMerchantAccountLinked, googleMerchantDataSourceNexusMade, metaChosenAdAccountOf, metaChosenInstagramOf, metaChosenPageOf, metaChosenPortfolioOf, metaLinkTaken, metaPortfolioShared, metaStoredObject } from './account.js'
import { googleMerchantCall, googleMerchantCallBodyOf, merchantReadAccount } from './google-merchant-calls.js'
import { googleAccountCallBodyOf, googleAdsAccountCall } from './google-account-calls.js'
import { META_REST_API_VERSION, metaAppSecretProof, metaCallVerdict, metaReadSecrets, metaSendUrl, metaWriteVerdict, scrubMetaAnswer, type MetaBoostWriteKind, type MetaJudgedWrite, type MetaLabelsKind, type MetaMediaWriteKind, type MetaOptimizeKind, type MetaRemoveKind, type MetaWriteBodyId } from './meta-calls.js'
import { metaRestFileExportOf, type MetaBrandSafetyKind, type MetaPageKind, type MetaWebhookKind, type MetaWriteKind } from './meta-calls.js'
import { META_MEDIA_LIST_MAX, metaMultipartBody, metaRuploadSendUrl, metaStartedVideoOf, metaVideoStartedOn, noteMetaVideoStarted } from './meta-media-rules.js'
import { metaBrandSafetyOwnerProblem, metaExportOwnerProblem, metaTargetingOwnerProblem, noteBlockListDraftMade, type MetaCheckRead } from './meta-brand-safety-owner.js'
import { META_BRAND_SAFETY_WRITE_RULES } from './meta-brand-safety-rules.js'
import { metaPageOwnerProblem } from './meta-page-owner.js'
import { MetaPageTokenUnavailable, metaPageTokenFor, scrubExactToken } from './meta-page-token.js'
import { holdMetaObject, metaObjectState, metaObjectWait, noteMetaObjectTouched } from './meta-object-limits.js'
import { META_SIGNALS_WRITE_RULES, type MetaSignalsKind } from './meta-signals-rules.js'
import { META_WEBHOOK_WRITE_RULES } from './meta-webhook-rules.js'
import { metaGraphBase } from '../meta/api-version.js'
import { MAX_RULE_BODY_IDS, ruleBodyIds } from './meta-ad-rule-rules.js'
import { META_KIND_FIELDS } from '../meta/meta-kinds.js'
// Meta step 27 review A1 — the activation rule of an ACTIVE ad's creative (meta-ad-rules.ts).
import { metaActivationProblem } from './meta-ad-rules.js'
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
  metaObjectKind?: MetaWriteKind
  /**
   * Meta step 18: a change of a budget schedule (high-demand period, `metaObjectKind: 'highdemandperiod'`) names the
   * campaign or ad set it belongs to; the gateway confirms that object is of the chosen ad account AND lists the period
   * among its own budget schedules before anything is sent.
   */
  metaParent?: { kind: 'campaign' | 'adset'; id: string }
  /**
   * Meta step 39 (review A9): the run of a Nexus change this call belongs to (the kit's own id): a block-list draft is
   * remembered for, and used by, only the same run.
   */
  metaRun?: string
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
  /** Meta step 39 (review A7): how many token-shaped things the gateway removed from Meta's answer (absent: none). */
  scrubbed?: number
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
  // one campaign, ad set or ad, or Meta's check of one (validate_only: a read); step 7 — or a report run of the chosen ad
  // account's numbers (POST /act_<id>/insights: a read, never braked by NEXUS_META_ADS_WRITES, since it changes nothing on
  // the account). Every batch is refused (none allowed yet).
  // Refused before the account, the token or the network, by the kind declared AND by the method, URL and body
  // themselves; what is sent is the body as it was judged. The object's ad account is checked after the status (3b).
  let metaRenewal = false
  let metaWrite: MetaJudgedWrite | null = null
  // Step 16 — a read of Meta's REST host (api.facebook.com): its token goes as a Bearer header (meta-calls.ts).
  let metaRest = false
  // Step 30 part 3 — the one read made with the chosen Page's own token (its connected apps; meta-calls.ts pageRead).
  let metaPageRead = false
  // Step 39 (BS-033) — the one PUT of Meta's REST host, the content block list's CSV export: a read, judged apart (its list
  // is checked to be the chosen portfolio's after the account's status, 3b).
  const metaExport = req.channel === 'META' && req.method === 'PUT' ? metaRestFileExportOf({ method: req.method, url: req.url, kind: req.kind, body: req.body, auth: req.auth, headers: req.headers }) : null
  if (metaExport && 'problem' in metaExport) return refuse('refused', 'META_READ_ONLY', `Nothing was sent to Meta: ${metaExport.problem} (${req.method} ${safePath(req.url)}).`, 403)
  if (metaExport) metaRest = true
  // Step 30 — the body a webhook subscription is sent with: the judged body plus the verify token (set below).
  let metaSendBody: string | null = null
  if (req.channel === 'META' && req.method !== 'GET' && !metaExport) {
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
    // Step 30 — a change that names a Meta app (an app subscription, an ad account's connected app) goes only for the
    // connection's OWN app, as the token renewal does.
    if (metaWrite.appId) {
      const own = await (await import('../cx/token.service.js')).metaAppIdOf(req.connectionId)
      if (!own || own !== metaWrite.appId) return refuse('refused', 'META_WRITE_NOT_ALLOWED', 'Nothing was sent to Meta: a webhook change is sent only for this connection\'s own Meta app.', 403)
    }
    // Step 26 (review B1) — a change on Meta's partnership REST host: the token goes as a Bearer header, like step 16's reads.
    metaRest = metaWrite.host === 'rest'
  } else if (req.channel === 'META' && !metaExport) {
    // One verdict on one canonical parse (meta-calls.ts): the refusal, and for the renewal the client_id it names.
    const judged = metaCallVerdict({ method: req.method, url: req.url, kind: req.kind, body: req.body, auth: req.auth, headers: req.headers })
    if (judged.problem) return refuse('refused', 'META_READ_ONLY', `Nothing was sent to Meta: ${judged.problem} (${req.method} ${safePath(req.url)}).`, 403)
    metaRest = judged.rest === true
    // Step 30 part 3 — a Page's connected apps are read with the Page's own token (5, below): only of the business's CHOSEN
    // Page (its PAGE MetaAccountLink), never a Page a caller names.
    if (judged.pageRead) {
      const chosen = req.connectionId ? await metaChosenPageOf(req.connectionId) : null
      if (!chosen || chosen !== judged.pageRead.pageId) return refuse('refused', 'META_PAGE_NOT_CHOSEN', 'Nothing was sent to Meta: a Page\'s connected apps are read only of the Facebook Page this business chose through this connection (with that Page\'s own token).', 403)
      metaPageRead = true
    }
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
  // Step 7 — a report run (POST /act_<id>/insights, a read: it changes nothing) only of the ad account THIS business chose
  // through THIS connection; no object limit applies to it.
  if (metaWrite?.reportRun && req.connectionId) {
    const chosen = await metaChosenAdAccountOf(req.connectionId)
    if (!chosen || chosen !== metaWrite.objectId) return refuse('refused', 'META_ACCOUNT_NOT_CHOSEN', 'Nothing was sent to Meta: a report run is only of the Meta ad account this business chose through this connection.', 403)
  } else if (metaWrite && req.connectionId) {
    // Step 39 — brand safety: an ad set's targeting is compared with its live targeting only once the call holds its rate
    // slot, right before it is sent (review A2, see 6–7); a brand-safety RULE's write (an ad account, portfolio or block list
    // of the chosen ad account) is checked by meta-brand-safety-owner.ts (its own reads through this gateway), with every id
    // inside the body. Chosen by the rule that judged the write, never by the kind alone: steps 19, 23 and 28 name
    // `adaccount` and `business` too, and keep their own checks.
    // Step 36 (Q1) — a change made AS the chosen Facebook Page (a rule marked `auth: 'page'`): its object must be that Page
    // or a child of it the gateway confirms (meta-page-owner.ts), before the Page's token is read. By the rule, never the
    // kind alone: step 28 names `page` too.
    // Step 30 — a webhook or alert subscription change (meta-webhook-rules.ts): by its rule too (it names step 19's
    // `adaccount` and step 28's `page`), its own app, the chosen ad account or the chosen Page (metaWebhookOwnerProblem).
    const owner = metaWrite.auth === 'page' ? await metaPageOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind, metaCheckRead(req.connectionId))
      : isWebhookRule(metaWrite.rule) ? await metaWebhookOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind)
      : metaWrite.targeting ? (req.metaObjectKind === 'adsettargeting' ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a targeting change of ${metaWrite.objectId} names it an ad set's targeting.` })
        : isBrandSafetyRule(metaWrite.rule) ? await metaBrandSafetyOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind ?? '', metaCheckRead(req.connectionId), req.metaRun)
          // Step 32 — a dataset, custom conversion or event source group change: chosen by its rule (it also names step 19's
          // `adaccount` and step 28's `page`, whose own checks run first), then signals-rule.ts with every id inside the body.
          : isSignalsRule(metaWrite.rule) ? await metaSignalsOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind)
          : await metaOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind as Exclude<MetaWriteKind, MetaBrandSafetyKind | MetaPageKind | MetaSignalsKind | MetaWebhookKind> | undefined, req.metaParent)
          ?? await metaBodyIdsProblem(req.connectionId, metaWrite)
          ?? await metaMediaAssetsProblem(req.connectionId, metaWrite)
    if (owner) return refuse('refused', owner.code, owner.sentence, 403)
    // Step 30 — an app subscription carries the verify token Meta echoes to Nexus's receiver: the server's own
    // (META_WEBHOOK_VERIFY_TOKEN), added here to the judged body, never a caller's and never on the ledger.
    if (metaWrite.verifyToken) {
      const verify = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
      if (!verify) return refuse('held', 'META_VERIFY_TOKEN_UNSET', 'Held, nothing sent: no webhook verify token is set on the API service (META_WEBHOOK_VERIFY_TOKEN), so Meta could not verify Nexus\'s receiver.', 409)
      metaSendBody = `${metaWrite.body}&${new URLSearchParams({ verify_token: verify }).toString()}`
    }
    if (!metaWrite.check) {
      // Step 23 — a call on an edge (an upload, a folder, a removal) edits no object: no 30-s gap, only Meta's own hold.
      const state = await metaObjectState(req.connectionId, metaWrite.objectId)
      const wait = metaObjectWait(metaWrite.edgeCall ? { ...state, touchedAt: null } : state, metaWrite.budget)
      if (wait) return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: ${wait.why}. Retry in ${Math.ceil(wait.waitMs / 1000)} s; nothing was changed.`, 429, wait.waitMs)
    }
  }

  // Step 39 (BS-033) — the CSV export only of the chosen portfolio's content block list.
  if (metaExport && 'contentBlockListId' in metaExport) {
    if (!req.connectionId) return refuse('refused', 'ACCOUNT_REQUIRED', 'Nothing was sent to Meta: the export names the Meta connection it is for.', 400)
    const owner = await metaExportOwnerProblem(req.connectionId, metaExport.contentBlockListId, metaCheckRead(req.connectionId))
    if (owner) return refuse('refused', owner.code, owner.sentence, 403)
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
  // Step 36 (Q1) — a change made as the chosen Page goes with the Page's OWN token, which the gateway reads here for this one
  // call (meta-page-token.ts: with the system-user token, for the chosen Page only) and keeps in memory for this call only:
  // it goes on the URL that is sent, never on `url` (the ledger, the trace, the answer), and is scrubbed from the answer.
  let pageToken: string | null = null
  try {
    // Step 30 part 3 — and the one read of the chosen Page's connected apps (Meta answers it only to the Page's token).
    if ((metaWrite?.auth === 'page' || metaPageRead) && req.connectionId) token = pageToken = await metaPageTokenFor(req.connectionId)
    // Step 30 — a rule marked `auth: 'app'` (an app's webhook subscription, the app's removal from the chosen Page) goes with
    // the connection's own Meta APP token, read here for this one call; a caller never asks for it (the verdict refuses a
    // caller's `auth` on a change), and no other rule ever gets it.
    else if (metaWrite?.auth === 'app' && req.connectionId) token = await tokenFor({ ...req, auth: 'app' })
    else token = await tokenFor(req)
  } catch (err) {
    if (err instanceof MetaPageTokenUnavailable) {
      if (err.code === 'PUBLISH_GATED') return refuse('gated', err.code, err.message, 503)
      return err.code === 'RATE_LIMITED_LOCAL' ? refuse('refused', err.code, err.message, 429, err.retryAfterMs) : refuse('held', err.code, err.message, 409)
    }
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
    // (step 23: a call to the upload host has no body; a file part's multipart body brings its own boundary type)
    ...(metaWrite && metaWrite.host !== 'rupload' && metaWrite.host !== 'rest' && !metaWrite.multipart ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    // Step 26 (review B1) — Meta's partnership host takes a JSON body (when the change has one).
    ...(metaWrite?.host === 'rest' && metaWrite.body ? { 'Content-Type': 'application/json' } : {}),
    // Step 23 — Meta's upload host: the judged `file_url` header (the link Meta fetches), never a caller's own header.
    ...(metaWrite?.headers ?? {}),
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
    if (metaWrite?.host === 'rupload') {
      // Step 23 — Meta's upload host takes the token as `Authorization: OAuth <token>` (guides/videoads/fbvideoads.md);
      // the proof rides on the address that is sent, like on Graph (the ledger keeps the path only).
      headers.Authorization = `OAuth ${token}`
      sendUrl = metaRuploadSendUrl(url, proof)
    } else sendUrl = metaSendUrl(url, token, proof)
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
    // Step 7 — a report run is an insights read (1 point).
    const slot = await takeToken(req.channel, key, req.maxRateWaitMs ?? 30_000, undefined, metaWrite && !metaWrite.reportRun ? 3 : 1)
    if (!slot.ok) {
      return refuse('refused', 'RATE_LIMITED_LOCAL', `Not sent yet: the ${name} rate limit for this account needs ${Math.ceil(slot.waitMs / 1000)} s more. Retry later.`, 429, slot.waitMs)
    }
    // Meta step 39 (Q7, review A2) — an ad set's targeting: its live targeting is read (with its owner and kind check) now
    // that the call holds its slot, right before the send, so nothing changed in Ads Manager during a wait is overwritten.
    if (metaWrite?.targeting && req.connectionId && attempts === 0) {
      const owner = await metaTargetingOwnerProblem(req.connectionId, metaWrite, req.metaObjectKind, metaCheckRead(req.connectionId))
      if (owner) return refuse('refused', owner.code, owner.sentence, 403)
    }
    attempts++
    timedOut = false
    try {
      // Never follow a redirect: a channel call carries its token in a header, and a custom token header
      // (x-amz-access-token, X-Shopify-Access-Token) would travel to the redirect's host.
      // Step 23 — nothing in the body of a call to Meta's upload host: Meta fetches the file from its link.
      const res = await fetch(sendUrl, { method: req.method, headers, body: (metaWrite?.host === 'rupload' || (metaWrite?.host === 'rest' && !metaWrite.body) ? undefined : metaWrite?.multipart ? metaMultipartBody(metaWrite.multipart) : googleBody ?? metaSendBody ?? metaWrite?.body ?? req.body ?? undefined) as RequestInit["body"], redirect: 'error', signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 30_000)]) : AbortSignal.timeout(req.timeoutMs ?? 30_000) })
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
    // Step 36 (Q1) — the Page's token never leaves the gateway, not even in an answer or an error that echoed it: as written,
    // URL-encoded, and in every string of a JSON answer once decoded (an echo with JSON \u escapes).
    if (pageToken) {
      const clean = scrubExactToken(text, pageToken)
      text = clean.text
      metaScrubbed += clean.removed
    }
    // Step 26 — a creator's partnership ad code (in a change's body, or a content look-up's query) never leaves the gateway
    // in Meta's answer: not to the caller, a sentence or the ledger.
    if (req.channel === 'META') {
      // Review A4 / round 2 — in every spelling an answer may carry it (metaSecretForms): as is, JSON-escaped (\" and \/),
      // escaped twice, %-encoded in upper or lower case.
      for (const secret of metaWrite?.secrets ?? metaReadSecrets(req.url)) {
        for (const form of metaSecretForms(secret)) if (text.includes(form)) { text = text.split(form).join('[removed]'); metaScrubbed += 1 }
      }
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
  if (req.channel === 'META' && metaWrite && !metaWrite.reportRun && req.connectionId) {
    // Step 39 — a block-list draft Meta made: only this run may make a list from it, once (its next request).
    if (ok && metaWrite.rule === 'blocklist.draft') noteBlockListDraftMade(req.connectionId, req.metaRun, text)
    if (objectLimit) await holdMetaObject(req.connectionId, metaWrite.objectId, objectLimit)
    // Step 29 — a POST that only reads (Meta's preview of a rule) changes nothing: no 30-s hold of the object either.
    else if (!metaWrite.edgeCall && !metaWrite.readOnly && (ok || status === 0 || status >= 500)) await noteMetaObjectTouched(req.connectionId, metaWrite.objectId, { budget: ok && metaWrite.budget && !metaWrite.check })
    // Step 23 — a video-ads upload Meta started on the chosen ad account: only this video may then go to Meta's upload
    // host and be finished, by this connection (meta-media-rules.ts).
    if (ok && metaWrite.rule === 'adaccount.video_ads.start') {
      const startedVideo = metaStartedVideoOf(text)
      if (startedVideo) noteMetaVideoStarted(req.connectionId, metaWrite.objectId.replace(/^act_/, ''), startedVideo.videoId)
    }
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
    // Step 23 — an image upload's bytes are never kept: their length only.
    // Step 36 review A6 — a Meta change whose rule names its ledger form (a test lead: the questions' names, never the
    // answers) keeps only that.
    requestPayload: ok ? undefined : metaWrite?.personal ? { __personal: true, bytes: metaWrite.body.length } : metaWrite?.bulky ? { __omitted: 'the bytes of a Meta upload are never kept', bytes: typeof req.body === 'string' ? req.body.length : null }
      // Step 26 — a body that carries a creator's partnership ad code is never kept either (meta-boost-rules.ts `secret`).
      : metaWrite?.secrets?.length ? { __omitted: 'a Meta change that carries a partnership ad code is never kept', bytes: typeof req.body === 'string' ? req.body.length : null } : metaWrite?.ledgerBody !== undefined ? ledgerSafeBody(metaWrite.ledgerBody) : typeof req.body === 'string' || req.body == null ? ledgerSafeBody(req.body ?? null) : { __binary: true, bytes: req.body instanceof Uint8Array ? req.body.byteLength : null },
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
    ...(metaScrubbed ? { scrubbed: metaScrubbed } : {}),
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
const META_KIND_FIELD: Readonly<Record<'campaign' | 'adset' | 'ad' | 'customaudience' | 'creative', readonly [string, string]>> = {
  campaign: META_KIND_FIELDS.campaign,
  adset: META_KIND_FIELDS.adset,
  ad: META_KIND_FIELDS.ad,
  // Step 18 — only as an id INSIDE a change's body (an ad set's customer exclusions), never the object a change names.
  customaudience: META_KIND_FIELDS.customaudience,
  // Step 22 — a creative remove-meta-ads-items deletes (object_type + status; a creative has its account_id).
  creative: META_KIND_FIELDS.creative,
}
const META_KIND_WORD: Readonly<Record<'campaign' | 'adset' | 'ad' | 'customaudience' | 'creative', string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad', customaudience: 'custom audience', creative: 'creative' }

/**
 * Step 17 — why a Meta change (or Meta's check of one) of this object is refused for this connection, or null: the object
 * must be of the ad account the business chose through it, AND of the kind the change names (review fix B4: the
 * allow-list is a campaign, an ad set or an ad — nothing else Meta numbers the same way). From the business's own stored
 * rows (row-level security), else ONE live read through this gateway (`GET /<id>?fields=account_id,<two fields only
 * that kind has>`). Meta's check only for a campaign (Meta documents validate_only on campaign updates only). An object Nexus
 * cannot place, of another kind, or of any other account (another business's too) gets nothing sent; the sentence never
 * names the other account.
 */
async function metaOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: 'campaign' | 'adset' | 'ad' | 'customaudience' | 'highdemandperiod' | 'adaccount' | 'adrule' | MetaRemoveKind | MetaLabelsKind | MetaOptimizeKind | MetaMediaWriteKind | MetaBoostWriteKind | undefined, parent?: { kind: 'campaign' | 'adset'; id: string }): Promise<{ code: string; sentence: string } | null> {
  const id = write.objectId
  // Step 29 — Meta's automated rules: the chosen ad account's rule library (a rule's create, with every id inside the
  // rule checked), or one of its rules (and the ids inside).
  if (kind === 'adrule' || (kind === 'adaccount' && write.rule === 'adRule.create')) return metaRuleOwnerProblem(connectionId, write, kind)
  // Step 19 — a create (and Meta's check of one: validate_only is documented on creates) names the ad account itself: it
  // goes only to act_<the account this business chose through this connection>, never another.
  if (kind === 'adaccount') {
    const chosen = await metaChosenAdAccountOf(connectionId)
    if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus creates nothing on Meta.' }
    return id === `act_${chosen}` ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: a create goes only to the Meta ad account this business chose through this connection.' }
  }
  // Step 23 — a folder in a business portfolio's media library: step 28's portfolio check, then no other Nexus business
  // shares that portfolio (its library would be that business's too).
  if (kind === 'business' && write.rule === 'portfolio.folder.create') return metaFolderPortfolioProblem(connectionId, write)
  // Step 28 — a new study's portfolio, a study, a Page, a Page video test (meta-optimize-owner.ts).
  if (kind === 'business' || kind === 'adstudy' || kind === 'page' || kind === 'pagevideotest') {
    const { metaOptimizeOwnerProblem } = await import('./meta-optimize-owner.js')
    return metaOptimizeOwnerProblem(connectionId, write, kind, metaOwnerIo(connectionId, write))
  }
  // Step 18 — a budget schedule: its campaign or ad set first, then the period among that object's own.
  if (kind === 'highdemandperiod') return metaPeriodOwnerProblem(connectionId, write, parent)
  // Step 22 — a video of the chosen ad account's library, or a part of an Instant Experience of the chosen Page.
  if (kind === 'video' || kind === 'canvaselement') return metaListedOwnerProblem(connectionId, write.objectId, kind, write.check)
  // Step 21 — a label or a value rule set: among the chosen ad account's own (metaAccountListedProblem).
  if (kind === 'adlabel' || kind === 'valueruleset') return metaAccountListedProblem(connectionId, write.objectId, kind, write.check)
  // Step 23 — a video upload this connection started (Meta's upload host, a video-ads finish).
  if (kind === 'startedvideo') return metaStartedVideoProblem(connectionId, write)
  // Step 26 — the chosen Instagram account itself, or a media of it (set-meta-partnership-access). The chosen Page on Meta's
  // partnership host is step 28's `page` check (above).
  if (kind === 'iguser' || kind === 'igmedia') return metaInstagramOwnerProblem(connectionId, write, kind)
  if (!kind || !Object.prototype.hasOwnProperty.call(META_KIND_FIELD, kind)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change of ${id} names the kind of object it changes (a campaign, an ad set or an ad).` }
  if (write.check && kind !== 'campaign') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: Meta has a check (validate_only) only for campaign changes, and ${id} is named ${kind === 'adset' || kind === 'ad' ? 'an' : 'a'} ${META_KIND_WORD[kind]}.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.' }
  const notChosen = { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: object ${id} is not of the Meta ad account this business chose through this connection.` }
  const notKind = (detail = '') => ({ code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is not a ${META_KIND_WORD[kind]} Nexus can confirm${detail}; a Nexus change writes only an object of the kind it names.` })
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
 * Meta step 30 — a webhook or alert subscription change: `act_<id>` must be THE ad account this business chose through
 * this connection, an app id its own Meta app, a Page id the Page it chose (MetaAccountLink). Anything else: nothing sent.
 */
async function metaWebhookOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined): Promise<{ code: string; sentence: string } | null> {
  if (!kind || !(write.kinds as readonly string[] | undefined)?.includes(kind) || (kind !== 'adaccount' && kind !== 'app' && kind !== 'page')) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: this change is not one of a ${kind}.` }
  const id = write.objectId
  if (kind === 'adaccount') {
    const chosen = await metaChosenAdAccountOf(connectionId)
    return chosen && id === `act_${chosen}` ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${id} is not the Meta ad account this business chose through this connection.` }
  }
  if (kind === 'app') {
    const own = await (await import('../cx/token.service.js')).metaAppIdOf(connectionId)
    return own && id === own ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: app ${id} is not this connection's own Meta app.` }
  }
  const page = await metaChosenPageOf(connectionId)
  return page && id === page ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${id} is not the Facebook Page this business chose through this connection.` }
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
 * Meta step 22 — a video (of the chosen ad account's library: `act_<id>/advideos`, "Ad account library video ID") or a part
 * of an Instant Experience (of the chosen Page: `<page id>/canvas_elements`) has no account_id to read: it must be LISTED
 * there — up to 5 pages of 100 (the read side's ownVideo looks at 500 too). Not listed, or the list could not be read in
 * full up to there: nothing is sent. Meta's check (validate_only) is documented for neither.
 */
async function metaListedOwnerProblem(connectionId: string, id: string, kind: 'video' | 'canvaselement', check: boolean): Promise<{ code: string; sentence: string } | null> {
  const what = kind === 'video' ? 'video' : 'Instant Experience part'
  if (check) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: Meta has no check (validate_only) for a change of a ${what}.` }
  const owner = kind === 'video' ? await metaChosenAdAccountOf(connectionId) : await metaChosenPageOf(connectionId)
  if (!owner) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: kind === 'video' ? 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection.' : 'Nothing was sent to Meta: this business has no Facebook Page chosen through this connection.' }
  const listed = await metaListedIdsPaged(connectionId, kind === 'video' ? `act_${owner}/advideos` : `${owner}/canvas_elements`, 5)
  if (listed === null) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not read the ${kind === 'video' ? 'chosen ad account\'s video library' : 'chosen Page\'s Instant Experience parts'} to confirm ${id} is there.` }
  return listed.has(id) ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${what} ${id} is not ${kind === 'video' ? 'in the chosen ad account\'s video library' : 'a part of the chosen Page\'s Instant Experiences'} (Nexus looks at the first 500).` }
}

/**
 * Meta step 22 — the ids of one Meta list (fields=id), page by page (cursor `after`, never Meta's next link: it carries the
 * token), at most `maxPages` of 100: each row's OWN `id` only (review A6: never an id inside a row — LIVE-PROBES CR-487).
 * Null when a page could not be read; the ids of the pages read when the list goes on past them.
 */
async function metaListedIdsPaged(connectionId: string, path: string, maxPages: number): Promise<Set<string> | null> {
  const ids = new Set<string>()
  const idOf = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${metaGraphBase()}/${path}`)
    url.searchParams.set('fields', 'id')
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after', after)
    let body: { data?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: unknown }; next?: unknown } } | null
    try {
      const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
      body = answer.ok ? answer.json<typeof body>() : null
    } catch {
      return null
    }
    if (!body || !Array.isArray(body.data)) return null
    for (const row of body.data) if (idOf(row?.id)) ids.add(idOf(row?.id))
    after = typeof body.paging?.cursors?.after === 'string' && body.paging?.next ? body.paging.cursors.after : null
    if (!after) break
  }
  return ids
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
  let optimizeCheck: ((inner: MetaWriteBodyId) => Promise<{ code: string; sentence: string } | null>) | undefined
  // Step 25 — this call's memo of the catalog rule (the portfolio read once, each catalog and id judged once): made per
  // call and dropped with it, so nothing carries across calls, connections or businesses.
  let catalogMemo: import('../marketing/meta-ads/catalog-rule.js').CatalogRuleMemo | undefined
  // Step 21 — each of the chosen ad account's own lists read once per change.
  const accountLists = new Map<MetaAccountListKind, Set<string> | null>()
  for (const inner of write.ids) {
    // Step 31 — a campaign or ad set a lookalike learns from: either kind, of the chosen ad account.
    if (inner.kind === 'campaignOrAdset') {
      const asCampaign = await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, 'campaign')
      const problem = asCampaign ? await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, 'adset') : null
      if (asCampaign && problem) return { code: problem.code, sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a campaign or ad set Nexus can confirm of the Meta ad account this business chose.` }
      continue
    }
    // Step 31 — an Instagram account, lead form, Instant Experience or source video an audience is built from, or an ad
    // account it is shared with: the read side's own ownership rules (marketing/meta-ads/audience-ids.ts). Its own kinds
    // (`sourcevideo`, `shareaccount`): step 22's `video` and step 28's `adaccount` keep their checks below; a Page is step
    // 19's `page` (the chosen Page), the same rule.
    if (inner.kind === 'instagram' || inner.kind === 'leadform' || inner.kind === 'canvas' || inner.kind === 'sourcevideo' || inner.kind === 'shareaccount') {
      const { metaAudienceIdProblem } = await import('../marketing/meta-ads/audience-ids.js')
      const kind = inner.kind === 'sourcevideo' ? 'video' : inner.kind === 'shareaccount' ? 'adaccount' : inner.kind
      const problem = await metaAudienceIdProblem(connectionId, { id: inner.id, kind })
      if (problem) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${problem}` }
      continue
    }
    // Step 21 — a label, a value rule set or a reach & frequency prediction: among the chosen ad account's own.
    if (inner.kind === 'adlabel' || inner.kind === 'valueruleset' || inner.kind === 'rfprediction') {
      const problem = await metaAccountListedProblem(connectionId, inner.id, inner.kind, false, accountLists)
      if (problem) return { code: problem.code, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, 'Nothing was sent to Meta: inside this change, ') }
      continue
    }
    // Step 21 — a prediction's destination: the Facebook Page or the Instagram account this business chose, no other.
    if (inner.kind === 'destination') {
      const [page, instagram] = await Promise.all([metaChosenPageOf(connectionId), metaChosenInstagramOf(connectionId)])
      if (inner.id !== page && inner.id !== instagram) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${inner.id} is neither the Facebook Page nor the Instagram account this business chose through this connection.` }
      continue
    }
    // Review A4 — a catalog or a product set: the ONE catalog rule (marketing/meta-ads/catalog-rule.ts): of the chosen ad
    // account's business portfolio, and that portfolio no other Nexus business's. Step 25 — a catalog item (a creative's
    // product tag or product data) by the same rule: its catalog.
    if (inner.kind === 'catalog' || inner.kind === 'productset' || inner.kind === 'productitem') {
      const chosen = await metaChosenAdAccountOf(connectionId)
      if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection.' }
      const { metaCatalogProblem, newCatalogRuleMemo } = await import('../marketing/meta-ads/catalog-rule.js')
      catalogMemo ??= newCatalogRuleMemo()
      const problem = await metaCatalogProblem({ connectionId, adAccountId: chosen }, inner.kind === 'catalog' ? { catalogId: inner.id } : inner.kind === 'productset' ? { productSetId: inner.id } : { productItemId: inner.id }, catalogMemo)
      if (problem) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${problem}` }
      continue
    }
    // Step 19 — the Page a new ad set promotes: the Page this business chose through this connection, no other.
    if (inner.kind === 'page') {
      const page = await metaChosenPageOf(connectionId)
      if (!page || page !== inner.id) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: Page ${inner.id} is not the Facebook Page this business chose through this connection.` }
      continue
    }
    // Step 19 — a custom conversion: one of the chosen ad account's own (act_<id>/customconversions; Meta allows 100 per account).
    if (inner.kind === 'customconversion') {
      const chosen = await metaChosenAdAccountOf(connectionId)
      const own = chosen ? await metaListedIds(connectionId, `act_${chosen}/customconversions`) : null
      if (!own?.has(inner.id)) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: custom conversion ${inner.id} is not one Nexus can confirm among the chosen ad account's own.` }
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
    // Step 27 review A1 — a creative an ad shows while ACTIVE: owner, kind and Advantage+ switches in one read.
    if (inner.kind === 'creative' && inner.activation) {
      const problem = await metaCreativeActivationProblem(connectionId, write, inner.id, inner.activation)
      if (problem) return problem
      continue
    }
    // Step 28 — an ad set or ad of a recommendation, a lift cell's ad account, a viewer, a Page video, a study's own cell
    // (a custom conversion is step 19's check above).
    if (inner.kind === 'adsetorad' || inner.kind === 'adaccount' || inner.kind === 'person' || inner.kind === 'pagevideo' || inner.kind === 'studycell') {
      optimizeCheck ??= (await import('./meta-optimize-owner.js')).metaOptimizeBodyChecker(connectionId, write, metaOwnerIo(connectionId, write))
      const problem = await optimizeCheck(inner)
      if (problem) return problem
      continue
    }
    // Step 39 — the brand-safety kinds of id (a portfolio a list is shared with, a block list, a draft) are checked by
    // meta-brand-safety-owner.ts for a brand-safety rule's write, never here; step 36's Page photo by meta-page-owner.ts.
    if (inner.kind === 'business' || inner.kind === 'agency' || inner.kind === 'publisherblocklist' || inner.kind === 'blocklistdraft' || inner.kind === 'pagephoto') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not an object this change may name.` }
    // Step 22 — a video inside a body (the video a library removal names): listed in the chosen ad account's library.
    const problem = await metaOwnerProblem(connectionId, { ...write, objectId: inner.id, check: false }, inner.kind)
    if (problem) return { code: problem.code, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, `Nothing was sent to Meta: inside this change, `) }
  }
  return null
}

/**
 * Meta step 27 review A1 — a creative an ad shows while ACTIVE (a new ad created ACTIVE, or a swap onto an ad that is ACTIVE —
 * `if-ad-active`: the ad's status read first, one live read). In ONE live read of the creative (account_id, the creative's
 * two kind fields and degrees_of_freedom_spec) it must be of the chosen ad account, a creative, and say OPT_OUT for every
 * Advantage+ feature (meta-ad-rules.ts metaActivationProblem): else nothing is sent.
 */
async function metaCreativeActivationProblem(connectionId: string, write: MetaJudgedWrite, creativeId: string, activation: 'always' | 'if-ad-active'): Promise<{ code: string; sentence: string } | null> {
  if (activation === 'if-ad-active') {
    const ad = await metaOwnerRead(connectionId, write.objectId, 'status')
    const status = ad.body?.status
    if (typeof status !== 'string') return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not read whether ad ${write.objectId} is ACTIVE, so it cannot judge the creative it would show.` }
    if (status !== 'ACTIVE') {
      const owner = await metaOwnerProblem(connectionId, { ...write, objectId: creativeId, check: false }, 'creative')
      return owner ? { code: owner.code, sentence: owner.sentence.replace(/^Nothing was sent to Meta: /, 'Nothing was sent to Meta: inside this change, ') } : null
    }
  }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.' }
  const { body } = await metaOwnerRead(connectionId, creativeId, ['account_id', ...META_KIND_FIELD.creative, 'degrees_of_freedom_spec'].join(','))
  const account = body && (typeof body.account_id === 'string' || typeof body.account_id === 'number') ? String(body.account_id).replace(/^act_/, '') : null
  if (!account) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: inside this change, Nexus could not confirm which ad account creative ${creativeId} belongs to, nor its Advantage+ switches.` }
  if (account !== chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, object ${creativeId} is not of the Meta ad account this business chose through this connection.` }
  if (META_KIND_FIELD.creative.some((name) => { const value = body?.[name]; return value === undefined || value === null || value === '' })) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${creativeId} is not a creative Nexus can confirm; a Nexus change writes only an object of the kind it names.` }
  }
  const problem = metaActivationProblem(body, `creative ${creativeId}`)
  return problem ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: an ACTIVE ad shows only a creative that switches on no Advantage+ feature — ${problem}.` } : null
}

/** Meta step 39 — is this the name of a brand-safety write rule (meta-brand-safety-rules.ts)? Read when judged, never at load. */
const isBrandSafetyRule = (name: string): boolean => META_BRAND_SAFETY_WRITE_RULES.some((rule) => rule.name === name)

/** Meta step 32 — is this the name of a dataset / custom conversion write rule (meta-signals-rules.ts)? Read when judged. */
const isSignalsRule = (name: string): boolean => META_SIGNALS_WRITE_RULES.some((rule) => rule.name === name)

/** Meta step 30 — is this the name of a webhook or alert subscription write rule (meta-webhook-rules.ts)? Read when judged. */
const isWebhookRule = (name: string): boolean => META_WEBHOOK_WRITE_RULES.some((rule) => rule.name === name)

/**
 * Meta step 32 — the owner check of a dataset, custom conversion or event source group change. What it shares with an
 * earlier step is that step's own check, run first: a create on the ad account (`adaccount`: act_<the chosen account>,
 * step 19), a Page's dataset (`page`: the chosen Page, step 28), an Instagram account's (`instagram`: the chosen account,
 * step 31's audience-ids rule). Then marketing/meta-ads/signals-rule.ts: a pixel by step 11's verdict, the portfolio no other
 * Nexus business shares, a custom conversion of a free pixel (Nexus-made to delete), an event source group, the ids inside
 * the body (the custom conversion's dataset, the group's datasets, the chosen ad account in a connect).
 */
async function metaSignalsOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: MetaWriteKind | undefined): Promise<{ code: string; sentence: string } | null> {
  if (kind === 'adaccount' || kind === 'page') {
    const problem = await metaOwnerProblem(connectionId, write, kind)
    if (problem) return problem
  }
  if (kind === 'instagram') {
    const { metaAudienceIdProblem } = await import('../marketing/meta-ads/audience-ids.js')
    const problem = await metaAudienceIdProblem(connectionId, { id: write.objectId, kind: 'instagram' })
    if (problem) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${problem}` }
  }
  if (!kind) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change of ${write.objectId} names the kind of object it changes.` }
  return (await import('../marketing/meta-ads/signals-rule.js')).metaSignalsProblem(connectionId, write, kind)
}

/**
 * Meta step 39 — one Graph read for a brand-safety owner check, through this gateway (its read gate, ledger and rate
 * bucket): Meta's body (and how many token shapes were scrubbed from it), or Meta's words when there is none. Never retried.
 */
function metaCheckRead(connectionId: string): MetaCheckRead {
  return async (path, query) => {
    const url = new URL(`${metaGraphBase()}/${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    try {
      const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
      const body = answer.ok ? answer.json<Record<string, unknown>>() : null
      return body && typeof body === 'object' && !Array.isArray(body) ? { body, words: null, scrubbed: answer.scrubbed ?? 0 } : { body: null, words: answer.verdict?.channelMessage ?? null }
    } catch (err) {
      return { body: null, words: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** One live read of a Meta object for a change's owner check (fields only), or null with Meta's words when it could not be made. */
async function metaOwnerRead(connectionId: string, id: string, fields: string): Promise<{ body: Record<string, unknown> | null; words: string | null }> {
  const url = new URL(`${metaGraphBase()}/${id}`)
  url.searchParams.set('fields', fields)
  try {
    const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
    return { body: answer.ok ? answer.json<Record<string, unknown>>() : null, words: answer.ok ? null : answer.verdict?.channelMessage ?? null }
  } catch (err) {
    return { body: null, words: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Meta step 29 — Meta's automated rules (set-meta-ad-rule, remove-meta-ad-rule). A rule is made on the chosen ad account's
 * own rule library (`POST act_<id>/adrules_library`, kind `adaccount`: the path's account must BE the chosen one); a change,
 * run, preview or delete names a rule (kind `adrule`), which must be of the chosen ad account: not one of Nexus's stored
 * campaigns, ad sets or ads, and ONE live read of `account_id` and the two fields only a rule has together
 * (`evaluation_spec`, `execution_spec` — reference ad-rule: id, account_id "the ad account that owns the rule", …). Then
 * every id INSIDE the body (meta-ad-rule-rules.ts ruleBodyIds): an ad, ad set or campaign named as such — of the chosen
 * account and of that kind (metaOwnerProblem); an unprefixed id or an aggregation id (Meta works out its level) — one of
 * Nexus's stored rows of the chosen account, else one live read of its account_id; an ad label — one live read of its
 * account. The people a rule notifies (user_ids) are Facebook users, not objects of an account: Nexus cannot check them
 * (the tool's preview says so). Anything else: nothing is sent.
 */
async function metaRuleOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: 'adrule' | 'adaccount'): Promise<{ code: string; sentence: string } | null> {
  const id = write.objectId
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.' }
  const notChosen = (what: string) => ({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${what} is not of the Meta ad account this business chose through this connection.` })
  if (kind === 'adaccount') {
    if (id !== `act_${chosen}`) return notChosen(`ad account ${id}`)
  } else {
    const notARule = (detail = '') => ({ code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is not a Meta rule Nexus can confirm${detail}.` })
    const stored = await metaStoredObject(id)
    if (stored) return notARule(` (Nexus has it as a ${META_KIND_WORD[stored.kind]})`)
    const read = await metaOwnerRead(connectionId, id, 'account_id,evaluation_spec,execution_spec')
    const account = read.body && (typeof read.body.account_id === 'string' || typeof read.body.account_id === 'number') ? String(read.body.account_id).replace(/^act_/, '') : null
    if (!account || !/^\d{1,25}$/.test(account)) {
      if (read.words && /nonexisting field/i.test(read.words)) return notARule(` (Meta: ${read.words})`)
      return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm which ad account rule ${id} belongs to${read.words ? ` (Meta: ${read.words})` : ''}.` }
    }
    if (account !== chosen) return notChosen(`rule ${id}`)
    if (['evaluation_spec', 'execution_spec'].some((f) => read.body![f] === undefined || read.body![f] === null)) return notARule()
  }
  if (!write.body) return null
  const inner = ruleBodyIds(write.body)
  if (inner.length > MAX_RULE_BODY_IDS) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: a rule names at most 150 objects and labels Nexus checks one by one; scope it by entity_type, a name or a label instead.' }
  for (const item of inner) {
    const inside = (sentence: string) => sentence.replace(/^Nothing was sent to Meta: /, 'Nothing was sent to Meta: inside this rule, ')
    if (item.kind === 'campaign' || item.kind === 'adset' || item.kind === 'ad') {
      const problem = await metaOwnerProblem(connectionId, { ...write, objectId: item.id, check: false, body: '' }, item.kind)
      if (problem) return { code: problem.code, sentence: inside(problem.sentence) }
      continue
    }
    if (item.kind === 'adobject') {
      const stored = await metaStoredObject(item.id)
      if (stored) { if (stored.adAccountId !== chosen) return notChosen(`inside this rule, ${item.id}`); continue }
      const read = await metaOwnerRead(connectionId, item.id, 'account_id')
      const account = read.body && (typeof read.body.account_id === 'string' || typeof read.body.account_id === 'number') ? String(read.body.account_id).replace(/^act_/, '') : null
      if (!account) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: inside this rule, Nexus could not confirm which ad account ${item.id} belongs to${read.words ? ` (Meta: ${read.words})` : ''}.` }
      if (account !== chosen) return notChosen(`inside this rule, ${item.id}`)
      continue
    }
    // An ad label (reference ad-label: account — the ad account it belongs to).
    const read = await metaOwnerRead(connectionId, item.id, 'account{id}')
    const owner = read.body?.account && typeof read.body.account === 'object' ? (read.body.account as Record<string, unknown>).id : null
    const account = typeof owner === 'string' || typeof owner === 'number' ? String(owner).replace(/^act_/, '') : null
    if (!account) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: inside this rule, Nexus could not confirm that ad label ${item.id} is of this ad account${read.words ? ` (Meta: ${read.words})` : ''}.` }
    if (account !== chosen) return notChosen(`inside this rule, ad label ${item.id}`)
  }
  return null
}

/**
 * Meta step 28 — what meta-optimize-owner.ts's checks read through this gateway: the chosen ad account, one GET (null
 * unless Meta answered it with a success), and the campaign / ad set / ad check above.
 */
function metaOwnerIo(connectionId: string, write: MetaJudgedWrite): import('./meta-optimize-owner.js').MetaOwnerIo {
  return {
    chosenAdAccount: () => metaChosenAdAccountOf(connectionId),
    read: async (path, query) => {
      const url = new URL(`${metaGraphBase()}/${path}`)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      try {
        const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
        return answer.ok ? answer.json<Record<string, unknown>>() : null
      } catch {
        return null
      }
    },
    objectProblem: (id, kind) => metaOwnerProblem(connectionId, { ...write, objectId: id, check: false }, kind),
  }
}

/** Meta step 21 — the chosen ad account's own lists a change's object or body id must be on. */
type MetaAccountListKind = 'adlabel' | 'valueruleset' | 'rfprediction'
const META_ACCOUNT_LISTS: Readonly<Record<MetaAccountListKind, { edge: string; word: string }>> = {
  adlabel: { edge: 'adlabels', word: 'label' },
  valueruleset: { edge: 'value_rule_set', word: 'value rule set' },
  rfprediction: { edge: 'reachfrequencypredictions', word: 'reach and frequency prediction' },
}

/**
 * Meta step 21 — a label (its node names no account on v26), a value rule set or a reach & frequency prediction is the
 * chosen ad account's own only when that account's own list holds it (`act_<id>/adlabels | value_rule_set |
 * reachfrequencypredictions`, fields=id, up to 5 pages of 100 — the read side's labels check looks at 500 too). Not listed,
 * or the list could not be read: nothing is sent. Meta documents no check (validate_only) for any of them.
 */
async function metaAccountListedProblem(connectionId: string, id: string, kind: MetaAccountListKind, check: boolean, lists: Map<MetaAccountListKind, Set<string> | null> = new Map()): Promise<{ code: string; sentence: string } | null> {
  const { edge, word } = META_ACCOUNT_LISTS[kind]
  if (check) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: Meta has no check (validate_only) for a change of a ${word}.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection.' }
  if (!lists.has(kind)) lists.set(kind, await metaListedIdsPaged(connectionId, `act_${chosen}/${edge}`, 5))
  const listed = lists.get(kind)
  if (!listed) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not read the chosen ad account's ${word}s to confirm ${id} is one of them.` }
  return listed.has(id) ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${word} ${id} is not one of the chosen ad account's own (Nexus looks at the first 500).` }
}

const notChosenMedia = (sentence: string) => ({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${sentence}` })

/**
 * Meta step 23 — a video upload THIS connection started on the chosen ad account (the gateway noted Meta's answer to the
 * video-ads start): the only object of a call to Meta's upload host. An upload on `act_<id>`'s own edge is step 19's
 * `adaccount` check, a video of the library (its captions) step 22's `video`, a folder's portfolio step 28's `business`.
 */
async function metaStartedVideoProblem(connectionId: string, write: MetaJudgedWrite): Promise<{ code: string; sentence: string } | null> {
  if (write.check) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: Meta has no check (validate_only) for an upload.' }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return notChosenMedia('this business has no Meta ad account chosen through this connection, so Nexus uploads nothing to Meta.')
  return metaVideoStartedOn(connectionId, write.objectId) === chosen ? null : notChosenMedia(`video ${write.objectId} is not an upload Nexus started on the chosen ad account through this connection.`)
}

/**
 * Meta step 23 — a folder goes into a business portfolio's media library only when step 28's check confirms the portfolio
 * IS the chosen ad account's own (meta-optimize-owner.ts `business`) AND no other Nexus business's chosen ad account is of
 * it (nexus_meta_links_taken PORTFOLIO, step 10's PORTFOLIO_TAKEN). The sentence never names the other business.
 */
async function metaFolderPortfolioProblem(connectionId: string, write: MetaJudgedWrite): Promise<{ code: string; sentence: string } | null> {
  const { metaOptimizeOwnerProblem } = await import('./meta-optimize-owner.js')
  const owner = await metaOptimizeOwnerProblem(connectionId, write, 'business', metaOwnerIo(connectionId, write))
  if (owner) return owner
  if (await metaPortfolioShared(write.objectId)) {
    return notChosenMedia('another business in Nexus uses an ad account of this business portfolio, so Nexus changes nothing in the portfolio\'s media library (it would be that business\'s too).')
  }
  return null
}

/**
 * Meta step 26 — what a partnership-access change names (meta-boost-rules.ts), checked before anything is sent: `iguser` —
 * the path's Instagram account IS the one this business chose (step 21's metaChosenInstagramOf); `igmedia` — the media is the
 * chosen Instagram account's (Meta's owner, else its username: one live read). Meta documents no check (validate_only) there.
 */
async function metaInstagramOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: MetaBoostWriteKind): Promise<{ code: string; sentence: string } | null> {
  if (write.check) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: Meta has no check (validate_only) for an Instagram partnership permission, a tag approval, an ad code or a Collab invite.' }
  const instagram = await metaChosenInstagramOf(connectionId)
  if (!instagram) return notChosenMedia('this business has no Instagram account chosen, so Nexus changes no Instagram partnership setting.')
  if (kind === 'iguser') return write.objectId === instagram ? null : notChosenMedia('the Instagram account this change names is not the one this business chose.')
  return (await metaInstagramMediaOwned(connectionId, write.objectId, instagram)) ? null : notChosenMedia(`Instagram media ${write.objectId} is not one Nexus can confirm as the chosen Instagram account's.`)
}

/**
 * Step 26 (review A4, round 2) — every spelling of a secret an answer may carry, longest first: as is; JSON-escaped once (with
 * `/` as is and as `\/`) and twice; %-encoded (encodeURIComponent and a form's `+` for a space), in upper and lower case.
 */
export function metaSecretForms(secret: string): string[] {
  const json1 = JSON.stringify(secret).slice(1, -1)
  const json1Slash = json1.replace(/\//g, '\\/')
  const pct = [encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2)]
  const lower = (v: string) => v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
  // Re-review (step 26) — a nested answer escaped PHP-style escapes `/` at both levels (`Ab\\\/Cd`).
  const json2Slash = JSON.stringify(json1Slash).slice(1, -1).replace(/\//g, '\\/')
  const forms = [secret, json1, json1Slash, JSON.stringify(json1).slice(1, -1), JSON.stringify(json1Slash).slice(1, -1), json2Slash, ...pct, ...pct.map(lower)]
  return [...new Set(forms.filter((f) => f.length >= 4))].sort((a, b) => b.length - a.length)
}

/**
 * Meta step 23 — the media ids INSIDE a change's body (meta-media-rules.ts `assets`), each the business's own before
 * anything is sent:
 *   instagrammedia  Meta's `owner` of the media is the chosen Instagram account (ONE live read; when Meta gives no owner,
 *                   its `username` against the chosen account's username read live — step 10's ownMedia rule);
 *   startedvideo    a video upload THIS connection started on the chosen ad account;
 *   creativefolder  one of the chosen portfolio's folders (one live read of its first 100).
 */
async function metaMediaAssetsProblem(connectionId: string, write: MetaJudgedWrite): Promise<{ code: string; sentence: string } | null> {
  if (!write.assets?.length) return null
  const chosen = await metaChosenAdAccountOf(connectionId)
  // Step 25 — a creative's ids: the chosen Page and Instagram account read once, the creative's images read by their
  // hashes once, each other list once per change.
  const creative = write.assets.some((a) => CREATIVE_ASSET_KINDS.has(a.kind))
  const mine = creative ? { pageId: await metaChosenPageOf(connectionId), instagramId: await metaChosenInstagramOf(connectionId) } : null
  const hashes = write.assets.filter((a) => a.kind === 'adimage').map((a) => a.id)
  const images = hashes.length && chosen ? await metaLibraryImages(connectionId, chosen, hashes) : null
  const lists = new Map<string, Set<string> | null>()
  // Step 26 — the chosen Page, Instagram account and the chosen ad account's portfolio (step 39's metaChosenPortfolioOf).
  let boost: { pageId: string | null; instagramId: string | null; portfolioId: string | null } | undefined
  for (const asset of write.assets) {
    if (mine && CREATIVE_ASSET_KINDS.has(asset.kind)) {
      const problem = await metaCreativeAssetProblem(connectionId, mine, asset, images, lists)
      if (problem) return problem
      continue
    }
    // Step 26 — a boost's and a partnership change's ids (meta-creative-rules.ts sourceAssets, meta-boost-rules.ts).
    if (BOOST_ASSET_KINDS.has(asset.kind)) {
      boost ??= { pageId: await metaChosenPageOf(connectionId), instagramId: await metaChosenInstagramOf(connectionId), portfolioId: await metaChosenPortfolioOf(connectionId) }
      const problem = await metaBoostAssetProblem(connectionId, boost, asset, lists)
      if (problem) return problem
      continue
    }
    if (asset.kind === 'startedvideo') {
      if (!chosen || metaVideoStartedOn(connectionId, asset.id) !== chosen) return notChosenMedia(`inside this change, video ${asset.id} is not an upload Nexus started on the chosen ad account through this connection.`)
      continue
    }
    if (asset.kind === 'creativefolder') {
      // Review A5 — the same reach as the tool's own check (META_MEDIA_LIST_MAX), failing closed past it.
      // The folder change's own object: the portfolio metaFolderPortfolioProblem confirmed before.
      const folders = await metaListedIdsUpTo(connectionId, `${write.objectId}/creative_folders`)
      if (!folders?.has(asset.id)) return notChosenMedia(`inside this change, folder ${asset.id} is not one Nexus can confirm among the chosen portfolio's media-library folders (it reads the first ${META_MEDIA_LIST_MAX}).`)
      continue
    }
    // Step 21's chosen Instagram account (metaChosenInstagramOf).
    const instagram = await metaChosenInstagramOf(connectionId)
    if (!instagram) return notChosenMedia('this business has no Instagram account chosen, so no Instagram media is brought into its ad account.')
    if (!(await metaInstagramMediaOwned(connectionId, asset.id, instagram))) {
      return notChosenMedia(`inside this change, Instagram media ${asset.id} is not one Nexus can confirm as the chosen Instagram account's.`)
    }
  }
  return null
}

/**
 * Meta step 25 — the ids INSIDE a creative (meta-creative-rules.ts), each the business's own before anything is sent:
 *   identitypage / identityinstagram  the Page and Instagram account the creative runs as: the CHOSEN ones (step 19's
 *                     metaChosenPageOf, step 21's metaChosenInstagramOf); a partnership ad may run as the partner's (creator as
 *                     main identity, master CR-321) only when the chosen one is its sponsor (`with`); a sponsor beside the
 *                     chosen identity is a partner;
 *   partnerpage / partnerinstagram  a partner's (never the chosen one itself, never one another Nexus business chose:
 *                     nexus_meta_links_taken PAGE / INSTAGRAM — Meta asks the partner's permission itself);
 *   adimage           an image of the chosen ad account's library, by its hash (one read of the change's hashes);
 *   pagepost          a post of the chosen Page (<chosen Page id>_<post id>);
 *   canvas            an Instant Experience whose owner is the chosen Page (one read); canvaselement an element of it;
 *   leadform          a lead form whose page is the chosen Page (one read);
 *   pageevent         an event whose owner is the chosen Page; igevent an upcoming event of the chosen Instagram account.
 * A library video and a call to action's Page are step 22's `video` and step 19's `page` body ids (metaBodyIdsProblem).
 * Anything Nexus cannot confirm (a read failed, a field missing) is refused: nothing is sent. The sentence never names
 * another business.
 */
const CREATIVE_ASSET_KINDS: ReadonlySet<string> = new Set(['identitypage', 'identityinstagram', 'partnerpage', 'partnerinstagram', 'adimage', 'pagepost', 'canvas', 'canvaselement', 'leadform', 'pageevent', 'igevent'])

async function metaCreativeAssetProblem(
  connectionId: string,
  mine: { pageId: string | null; instagramId: string | null },
  asset: { id: string; kind: string; with?: string },
  images: Set<string> | null,
  lists: Map<string, Set<string> | null>,
): Promise<{ code: string; sentence: string } | null> {
  const page = mine.pageId
  const ig = mine.instagramId
  const where = 'inside this creative, '
  const ownerOf = (value: unknown) => {
    const owner = value && typeof value === 'object' ? (value as { id?: unknown }).id : value
    return typeof owner === 'string' || typeof owner === 'number' ? String(owner) : null
  }
  const partner = async (product: 'PAGE' | 'INSTAGRAM', id: string, chosenId: string | null, word: string) => {
    // Review round 2 (step 26) — never a leading 0: `0<id>` is the same id to Meta and would pass the compares below.
    if (!/^[1-9]\d{0,24}$/.test(id)) return notChosenMedia(`${where}${id} is not a ${word} id.`)
    if (id === chosenId) return notChosenMedia(`${where}the partner ${word} ${id} is the business's own chosen ${word}: a partnership ad names another one.`)
    if (await metaLinkTaken(product, id)) return notChosenMedia(`${where}${word} ${id} is one another business in Nexus uses, so no creative of this business names it.`)
    return null
  }
  switch (asset.kind) {
    case 'identitypage':
    case 'identityinstagram': {
      const isPage = asset.kind === 'identitypage'
      const chosenId = isPage ? page : ig
      const word = isPage ? 'Page' : 'Instagram account'
      if (!chosenId) return notChosenMedia(`this business has no ${isPage ? 'Facebook Page' : 'Instagram account'} chosen, so Nexus makes no creative that runs as one.`)
      if (asset.id === chosenId) return asset.with ? partner(isPage ? 'PAGE' : 'INSTAGRAM', asset.with, chosenId, word) : null
      if (asset.with !== chosenId) return notChosenMedia(`${where}${word} ${asset.id} is not the one this business chose (a partner's ${word} runs a partnership ad only with the chosen one as its sponsor).`)
      return partner(isPage ? 'PAGE' : 'INSTAGRAM', asset.id, chosenId, word)
    }
    case 'partnerpage': return partner('PAGE', asset.id, page, 'Page')
    case 'partnerinstagram': return partner('INSTAGRAM', asset.id, ig, 'Instagram account')
    case 'pagepost': return page && asset.id.startsWith(`${page}_`) ? null : notChosenMedia(`${where}post ${asset.id} is not a post of the Page this business chose.`)
    case 'adimage': return images?.has(asset.id) ? null : notChosenMedia(`${where}image ${asset.id} is not one Nexus can confirm in the chosen ad account's image library (create-meta-media uploads it and answers its hash).`)
    case 'canvas':
    case 'pageevent': {
      const read = page ? await metaReadFields(connectionId, asset.id, 'id,owner') : null
      if (page && ownerOf(read?.owner) === page) return null
      return notChosenMedia(`${where}${asset.kind === 'canvas' ? 'Instant Experience' : 'event'} ${asset.id} is not one Nexus can confirm as the chosen Page's.`)
    }
    case 'canvaselement': {
      const key = `canvas:${asset.with ?? ''}`
      if (!lists.has(key)) {
        const read = asset.with ? await metaReadFields(connectionId, asset.with, 'id,body_elements') : null
        lists.set(key, read ? idsWithin(read.body_elements) : null)
      }
      return lists.get(key)?.has(asset.id) ? null : notChosenMedia(`${where}element ${asset.id} is not one Nexus can confirm in the creative's own Instant Experience.`)
    }
    case 'leadform': {
      const read = page ? await metaReadFields(connectionId, asset.id, 'id,page') : null
      return page && ownerOf(read?.page) === page ? null : notChosenMedia(`${where}lead form ${asset.id} is not one Nexus can confirm as the chosen Page's.`)
    }
    case 'igevent': {
      const key = `${ig}/upcoming_events`
      if (ig && !lists.has(key)) lists.set(key, await metaListedIdsUpTo(connectionId, key))
      return ig && lists.get(key)?.has(asset.id) ? null : notChosenMedia(`${where}event ${asset.id} is not one Nexus can confirm among the chosen Instagram account's upcoming events.`)
    }
  }
  return notChosenMedia(`${where}${asset.id} is not an id Nexus can confirm.`)
}

/**
 * Meta step 26 — the ids of a boost and of a partnership-access change, each the business's own or a creator's that no other
 * Nexus business owns, before anything is sent:
 *   partnercontent   a creator's Instagram media or Facebook post that Meta's content discovery lists for the brand
 *                    (GET /<portfolio>/partnership-ads-advertisable-content content_ids, the chosen Page / Instagram account —
 *                    one live read), whose author is neither the chosen Page or Instagram account nor one another Nexus
 *                    business chose (a Facebook post's own Page part too);
 *   adcode           a creator's ad code: the same read by ad_codes finds exactly one content, of the platform (`with`
 *                    INSTAGRAM | FACEBOOK) or exactly the media named (`with` a media id), whose author passes the same check —
 *                    the code itself is never put in a sentence;
 *   igpermalink      a post link that IS one of the chosen Instagram account's own media (its `permalink`, among the first
 *                    META_MEDIA_LIST_MAX of /<ig id>/media);
 *   collabinvite     a media among the chosen Instagram account's pending Collab invites (/<ig id>/collaboration_invites, the
 *                    first META_MEDIA_LIST_MAX).
 *   brandedpost      a post Meta's partnership host lists among the branded-content posts that tag the chosen Page, by a
 *                    creator Page no other Nexus business uses.
 * The chosen Page and Instagram account a boost names (object_id, a creator's sponsors, an Instagram app link's user id)
 * are step 19's `page` and step 31's `instagram` body ids (metaBodyIdsProblem). Anything Nexus cannot confirm (a read
 * failed, nothing found) is refused: nothing is sent.
 */
const BOOST_ASSET_KINDS: ReadonlySet<string> = new Set(['partnercontent', 'adcode', 'igpermalink', 'collabinvite', 'brandedpost'])

async function metaBoostAssetProblem(
  connectionId: string,
  mine: { pageId: string | null; instagramId: string | null; portfolioId: string | null },
  asset: { id: string; kind: string; with?: string },
  lists: Map<string, Set<string> | null>,
): Promise<{ code: string; sentence: string } | null> {
  const page = mine.pageId
  const ig = mine.instagramId
  const where = 'inside this change, '
  switch (asset.kind) {
    case 'partnercontent':
    case 'adcode': {
      const code = asset.kind === 'adcode'
      const what = code ? 'the creator\'s ad code' : `content ${asset.id}`
      if (!mine.portfolioId || (!page && !ig)) return notChosenMedia(`${where}Nexus cannot ask Meta's content discovery about ${what}: the chosen ad account names no business portfolio, or no Page or Instagram account is chosen.`)
      const rows = await metaAdvertisableContent(connectionId, mine.portfolioId, page, ig, code ? 'ad_codes' : 'content_ids', asset.id)
      if (!rows) return notChosenMedia(`${where}Nexus could not ask Meta's content discovery about ${what}, so nothing is sent.`)
      // A Facebook post may come back as its post id alone (content discovery names "Facebook post ID").
      const row = code ? (rows.length === 1 ? rows[0] : null) : rows.find((r) => r.contentId === asset.id || (asset.id.includes('_') && r.contentId === asset.id.split('_')[1])) ?? null
      if (!row) return notChosenMedia(`${where}Meta's content discovery does not list ${what} as content the chosen Page or Instagram account may advertise.`)
      if (code && asset.with && /^\d+$/.test(asset.with) && row.contentId !== asset.with) return notChosenMedia(`${where}the creator's ad code unlocks other content than media ${asset.with}.`)
      if (code && asset.with && /^(INSTAGRAM|FACEBOOK)$/.test(asset.with) && row.platform && row.platform !== asset.with) return notChosenMedia(`${where}the creator's ad code is for ${row.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} content, not ${asset.with === 'INSTAGRAM' ? 'Instagram' : 'Facebook'}.`)
      const postPage = !code && /^\d+_\d+$/.test(asset.id) ? asset.id.split('_')[0] : null
      const pages = [row.authorPage, postPage].filter((v): v is string => !!v)
      const igs = [row.authorInstagram].filter((v): v is string => !!v)
      if (!pages.length && !igs.length) return notChosenMedia(`${where}Meta's content discovery names no author for ${what}, so Nexus cannot confirm whose it is.`)
      if ((page && pages.includes(page)) || (ig && igs.includes(ig))) return notChosenMedia(`${where}${what} is the business's own: a partnership boost is a creator's content (boost the business's own post as such).`)
      for (const p of pages) if (await metaLinkTaken('PAGE', p)) return notChosenMedia(`${where}${what} is by a Page another business in Nexus uses, so no creative of this business boosts it.`)
      for (const i of igs) if (await metaLinkTaken('INSTAGRAM', i)) return notChosenMedia(`${where}${what} is by an Instagram account another business in Nexus uses, so no creative of this business boosts it.`)
      return null
    }
    case 'igpermalink': {
      if (!ig) return notChosenMedia('this business has no Instagram account chosen, so no Instagram post link is run as its ad.')
      const key = `${ig}/media:permalink`
      if (!lists.has(key)) lists.set(key, await metaListedValuesUpTo(connectionId, `${ig}/media`, 'id,permalink', 'permalink'))
      return lists.get(key)?.has(asset.id) ? null : notChosenMedia(`${where}${asset.id} is not a link to one of the chosen Instagram account's own media Nexus can confirm (it reads the first ${META_MEDIA_LIST_MAX}).`)
    }
    case 'brandedpost': {
      // Review B1 — a post Meta lists among the branded-content posts that tag the chosen Page (the first
      // META_MEDIA_LIST_MAX; one read per change), by a creator Page no other Nexus business uses.
      if (!page) return notChosenMedia('this business has no Facebook Page chosen, so no sponsor tag is removed.')
      const key = `branded:${page}`
      if (!lists.has(key)) lists.set(key, (await metaBrandedPosts(connectionId, page)) as unknown as Set<string> | null)
      const posts = lists.get(key) as unknown as Map<string, string | null> | null
      if (!posts?.has(asset.id)) return notChosenMedia(`${where}post ${asset.id} is not one Nexus can confirm among the branded-content posts that tag the chosen Page (it reads the first ${META_MEDIA_LIST_MAX}).`)
      const creator = posts.get(asset.id)
      // Review round 2 — a post whose creator Page Meta does not name: Nexus cannot tell whose it is, so nothing is sent.
      if (!creator) return notChosenMedia(`${where}Meta names no creator Page for post ${asset.id}, so Nexus cannot confirm it is no other business's in Nexus.`)
      if (await metaLinkTaken('PAGE', creator)) return notChosenMedia(`${where}post ${asset.id} is by a Page another business in Nexus uses, so Nexus does not change it.`)
      return null
    }
    case 'collabinvite': {
      if (!ig) return notChosenMedia('this business has no Instagram account chosen, so it answers no Collab invite.')
      const key = `${ig}/collaboration_invites`
      if (!lists.has(key)) lists.set(key, await metaListedValuesUpTo(connectionId, key, 'media_id', 'media_id'))
      return lists.get(key)?.has(asset.id) ? null : notChosenMedia(`${where}media ${asset.id} is not among the Collab invites the chosen Instagram account has pending (Nexus reads the first ${META_MEDIA_LIST_MAX}).`)
    }
  }
  return notChosenMedia(`${where}${asset.kind === 'adcode' ? 'the ad code' : asset.id} is not an id Nexus can confirm.`)
}

/**
 * Review B1 (step 26) — the branded-content posts that tag the chosen Page (Meta's partnership host, one read of the first
 * META_MEDIA_LIST_MAX): post id → its creator Page. Big ids are kept exact as text. Null when the read failed.
 */
async function metaBrandedPosts(connectionId: string, pageId: string): Promise<Map<string, string | null> | null> {
  const url = new URL(`https://api.facebook.com/partnership-ads/fb-branded-content/${pageId}/branded-content-posts`)
  url.searchParams.set('limit', String(META_MEDIA_LIST_MAX))
  try {
    const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', auth: 'account', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
    if (!answer.ok) return null
    let body: unknown
    try { body = JSON.parse(answer.text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')) } catch { return null }
    const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: unknown[] }).data : null
    if (!rows) return null
    const idText = (v: unknown) => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null)
    const out = new Map<string, string | null>()
    for (const row of rows) {
      const r = (row && typeof row === 'object' ? row : {}) as { fb_post_id?: unknown; creator_page_id?: unknown }
      const id = idText(r.fb_post_id)
      if (id) out.set(id, idText(r.creator_page_id))
    }
    return out
  } catch {
    return null
  }
}

/**
 * Step 26 — ONE look-up of Meta's content discovery (content-discovery-api.md: a direct look-up by content_ids or ad_codes,
 * no paging, system-user tokens supported) for the brand's chosen Page and/or Instagram account: each content's id, platform
 * and author. Null when the read failed. The URL (an ad code in its query) reaches the ledger as its path only (safePath).
 */
async function metaAdvertisableContent(connectionId: string, portfolioId: string, pageId: string | null, instagramId: string | null, key: 'content_ids' | 'ad_codes', value: string): Promise<Array<{ contentId: string | null; platform: string | null; authorPage: string | null; authorInstagram: string | null }> | null> {
  const url = new URL(`${metaGraphBase()}/${portfolioId}/partnership-ads-advertisable-content`)
  if (pageId) url.searchParams.set('fb_page_id', pageId)
  if (instagramId) url.searchParams.set('ig_user_id', instagramId)
  url.searchParams.set(key, JSON.stringify([value]))
  url.searchParams.set('fields', 'content_id,platform,author{ig_user_id,fb_page_id}')
  const idText = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^\d{1,25}(_\d{1,25})?$/.test(String(v)) ? String(v) : null
  try {
    const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
    const body = answer.ok ? answer.json<{ data?: Array<Record<string, unknown>> }>() : null
    if (!body || !Array.isArray(body.data)) return null
    return body.data.map((row) => {
      const author = (row?.author && typeof row.author === 'object' ? row.author : {}) as { ig_user_id?: unknown; fb_page_id?: unknown }
      return { contentId: idText(row?.content_id), platform: typeof row?.platform === 'string' ? row.platform : null, authorPage: idText(author.fb_page_id), authorInstagram: idText(author.ig_user_id) }
    })
  } catch {
    return null
  }
}

/**
 * Step 26 — the values of one field in the FIRST META_MEDIA_LIST_MAX rows of a Meta list (as metaListedIdsUpTo, another
 * field than `id`): seen = confirmed, not seen (past those rows, or a failed read: null) = not confirmed.
 */
async function metaListedValuesUpTo(connectionId: string, path: string, fields: string, field: string): Promise<Set<string> | null> {
  const values = new Set<string>()
  let rows = 0
  let after: string | null = null
  while (rows < META_MEDIA_LIST_MAX) {
    const url = new URL(`${metaGraphBase()}/${path}`)
    url.searchParams.set('fields', fields)
    url.searchParams.set('limit', String(Math.min(100, META_MEDIA_LIST_MAX - rows)))
    if (after) url.searchParams.set('after', after)
    let body: { data?: Array<Record<string, unknown>>; paging?: { next?: unknown; cursors?: { after?: unknown } } } | null
    try {
      const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
      body = answer.ok ? answer.json<{ data?: Array<Record<string, unknown>>; paging?: { next?: unknown; cursors?: { after?: unknown } } }>() : null
    } catch {
      return null
    }
    if (!body || !Array.isArray(body.data)) return null
    for (const row of body.data) {
      if (rows >= META_MEDIA_LIST_MAX) break
      rows++
      const value = row?.[field]
      if (typeof value === 'string' || typeof value === 'number') values.add(String(value))
    }
    const next = body.paging?.next && typeof body.paging.cursors?.after === 'string' ? body.paging.cursors.after : null
    if (!next || body.data.length === 0) break
    after = next
  }
  return values
}

/** Every `id` in a Meta answer's list (an Instant Experience's body elements and their children), a few levels deep. */
function idsWithin(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 4 || !value || typeof value !== 'object') return out
  if (Array.isArray(value)) { for (const v of value) idsWithin(v, depth + 1, out); return out }
  const row = value as Record<string, unknown>
  if (typeof row.id === 'string' || typeof row.id === 'number') out.add(String(row.id))
  for (const v of Object.values(row)) if (v && typeof v === 'object') idsWithin(v, depth + 1, out)
  return out
}

/**
 * Meta step 25 — which of these hashes are images of the chosen ad account's library (not DELETED): reads of
 * `act_<id>/adimages?hashes=[…]`, 50 hashes a read; null when a read failed (nothing is confirmed then).
 */
async function metaLibraryImages(connectionId: string, chosen: string, hashes: string[]): Promise<Set<string> | null> {
  const found = new Set<string>()
  const unique = [...new Set(hashes)]
  for (let i = 0; i < unique.length; i += 50) {
    const url = new URL(`${metaGraphBase()}/act_${chosen}/adimages`)
    url.searchParams.set('hashes', JSON.stringify(unique.slice(i, i + 50)))
    url.searchParams.set('fields', 'hash,status')
    try {
      const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
      const body = answer.ok ? answer.json<{ data?: Array<{ hash?: unknown; status?: unknown }> }>() : null
      if (!body || !Array.isArray(body.data)) return null
      for (const row of body.data) if (typeof row?.hash === 'string' && row.status !== 'DELETED') found.add(row.hash)
    } catch {
      return null
    }
  }
  return found
}

/**
 * Review round 2 — the ids in the FIRST META_MEDIA_LIST_MAX rows of one Meta list (100 a page, `after`), counted in rows;
 * null when a read failed. The tool reads the same rows (change-media.ts listPaged up to META_MEDIA_LIST_MAX): an id seen
 * there is confirmed, an id not seen is refused (fail closed: past those rows, or after a failed read, nothing is confirmed).
 */
async function metaListedIdsUpTo(connectionId: string, path: string): Promise<Set<string> | null> {
  const ids = new Set<string>()
  let rows = 0
  let after: string | null = null
  while (rows < META_MEDIA_LIST_MAX) {
    const url = new URL(`${metaGraphBase()}/${path}`)
    url.searchParams.set('fields', 'id')
    url.searchParams.set('limit', String(Math.min(100, META_MEDIA_LIST_MAX - rows)))
    if (after) url.searchParams.set('after', after)
    let body: { data?: Array<{ id?: unknown }>; paging?: { next?: unknown; cursors?: { after?: unknown } } } | null
    try {
      const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
      body = answer.ok ? answer.json<{ data?: Array<{ id?: unknown }>; paging?: { next?: unknown; cursors?: { after?: unknown } } }>() : null
    } catch {
      return null
    }
    if (!body || !Array.isArray(body.data)) return null
    for (const row of body.data) {
      if (rows >= META_MEDIA_LIST_MAX) break
      rows++
      if (typeof row?.id === 'string' || typeof row?.id === 'number') ids.add(String(row.id))
    }
    const next = body.paging?.next && typeof body.paging.cursors?.after === 'string' ? body.paging.cursors.after : null
    if (!next || body.data.length === 0) break
    after = next
  }
  return ids
}

/** One read of a field list of a Meta object (fields as given), or null when it could not be read. */
async function metaReadFields(connectionId: string, path: string, fields: string): Promise<Record<string, unknown> | null> {
  const url = new URL(`${metaGraphBase()}/${path}`)
  url.searchParams.set('fields', fields)
  try {
    const answer = await gatewayCall({ channel: 'META', operation: 'write.ownerCheck', kind: 'read', connectionId, url: url.toString(), method: 'GET', maxTransientRetries: 0, max429Retries: 0, timeoutMs: 20_000 })
    const body = answer.ok ? answer.json<Record<string, unknown>>() : null
    return body && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

/** Is this Instagram media the chosen Instagram account's (Meta's owner, else its username)? Unreadable = no. */
async function metaInstagramMediaOwned(connectionId: string, mediaId: string, instagramId: string): Promise<boolean> {
  const media = await metaReadFields(connectionId, mediaId, 'id,owner,username')
  if (!media) return false
  const ownerOf = (value: unknown) => (value && typeof value === 'object' ? (value as { id?: unknown }).id : value)
  const owner = ownerOf(media.owner)
  if (typeof owner === 'string' || typeof owner === 'number') return String(owner) === instagramId
  const username = typeof media.username === 'string' ? media.username.trim().toLowerCase() : ''
  if (!username) return false
  const account = await metaReadFields(connectionId, instagramId, 'id,username')
  return typeof account?.username === 'string' && account.username.trim().toLowerCase() === username
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
