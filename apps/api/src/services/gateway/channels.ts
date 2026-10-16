/**
 * P1.1 — what differs per channel, in one place: the publish mode, the production and sandbox hosts,
 * the login and market headers, the rate-limit reading, and the operation group a rate bucket is per.
 * The gateway (gateway.ts) runs the same steps for every channel and asks this table for the parts.
 */
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { getEtsyPublishMode } from '../etsy-publish-gate.service.js'
import { tryGetChannelSpec, type ChannelKey, type RateLimitReading } from '../cx/catalog.js'
import { amazonAdsRateReading, amazonSpRateReading, ebayRateReading, etsyRateReading, googleRateReading, shopifyRateReading } from '../cx/rate-readings.js'
import type { GatewayChannel } from './vocabulary.js'
import { customerOperationProblem } from './google-account-calls.js'
import prisma from '../../db.js'
import { languageTag, marketLanguages } from '../pim/market-languages.js'
import { normalizeLanguage } from '../pim/content-language.js'

export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'

export const SPEC_KEY: Record<GatewayChannel, ChannelKey> = {
  EBAY: 'EBAY', AMAZON_SP: 'AMAZON_SP', SHOPIFY: 'SHOPIFY', AMAZON_ADS: 'AMAZON_ADS', ETSY: 'ETSY', GOOGLE: 'GOOGLE',
}

/** The publish mode that governs WRITES on this channel today. */
export function publishModeOf(channel: GatewayChannel): PublishMode {
  switch (channel) {
    case 'EBAY': return getEbayPublishMode()
    case 'AMAZON_SP': return getAmazonPublishMode()
    case 'SHOPIFY': return getShopifyPublishMode()
    // Amazon Ads keeps its own write gate (ads-write-gate.ts: allowlist, caps, pins); the gateway only
    // honours its sandbox switch here, so a sandbox Ads write never reaches the live host.
    // Same rule as ads-api-client.ts `adsMode()` (exact 'live', else sandbox).
    case 'AMAZON_ADS': return process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live' : 'sandbox'
    // P4.6a — Etsy has a real switch now. It used to return the literal 'live', which was true of the
    // world but not of the code: the connected-account client was read-only, so nothing could use it.
    // P4.6 puts writes on that client, so the literal becomes an ungated live write path.
    case 'ETSY': return getEtsyPublishMode()
    // Google Ads writes (Owner 2026-10-15, pick A): live — each one is a change a person approved in Nexus.
    // The gateway still refuses every other Google change (googleCallKind); NEXUS_GOOGLE_ADS_WRITES=off is the brake.
    case 'GOOGLE': return googleAdsWritesMode()
  }
}

const SANDBOX_HOSTS: Record<GatewayChannel, Array<[RegExp, (m: RegExpMatchArray) => string]>> = {
  EBAY: [
    [/^api\.ebay\.com$/, () => 'api.sandbox.ebay.com'],
    [/^apiz\.ebay\.com$/, () => 'apiz.sandbox.ebay.com'],
  ],
  AMAZON_SP: [[/^sellingpartnerapi-(na|eu|fe)\.amazon\.com$/, (m) => `sandbox.sellingpartnerapi-${m[1]}.amazon.com`]],
  // Shopify has no sandbox host: a development store is a different shop, chosen by the account.
  SHOPIFY: [],
  AMAZON_ADS: [[/^advertising-api(-eu|-fe)?\.amazon\.com$/, () => 'advertising-api-test.amazon.com']],
  ETSY: [],
  // Google has no sandbox host: a Google Ads test account is a different account, chosen by the login.
  GOOGLE: [],
}

/** The URL in sandbox mode, or null when the channel has no sandbox host for it (then: no call). */
export function sandboxUrlOf(channel: GatewayChannel, url: string): string | null {
  const parsed = new URL(url)
  if (/sandbox|-test\./.test(parsed.hostname)) return url
  for (const [pattern, to] of SANDBOX_HOSTS[channel]) {
    const match = parsed.hostname.match(pattern)
    if (match) { parsed.hostname = to(match); return parsed.toString() }
  }
  return null
}

export function authHeadersOf(channel: GatewayChannel, token: string): Record<string, string> {
  switch (channel) {
    case 'EBAY': return { Authorization: `Bearer ${token}` }
    case 'AMAZON_SP': return { 'x-amz-access-token': token }
    case 'SHOPIFY': return { 'X-Shopify-Access-Token': token }
    case 'AMAZON_ADS': return { Authorization: `Bearer ${token}` }
    case 'ETSY': return { Authorization: `Bearer ${token}` }
    case 'GOOGLE': return { Authorization: `Bearer ${token}` }
  }
}

/**
 * P1.5 (folded in here) — eBay's three market headers, from the Marketplace row. Before this, one helper
 * turned EBAY_IT into en-US, bulk and the old service hard-coded en-US, the image publisher hard-coded
 * it-IT and the wizard sent no marketplace header at all.
 *
 * No market→language table here (LX.2: `Marketplace.languages` is the only authority). The row gives the
 * marketplace id (`EBAY_IT`) and the ordered languages; the first is the default, or the caller names one
 * of them. eBay wants the regional tag with a hyphen (`it-IT`, `en-GB`).
 */
export class MarketUnconfigured extends Error {
  constructor(message: string) { super(message); this.name = 'MarketUnconfigured' }
}

/**
 * P1.5 — the content language eBay expects for a market, from the Marketplace row (`EBAY_IT` / `IT` →
 * `it-IT`, `EBAY_GB` / `UK` → `en-GB`). A market Nexus has no row for answers `en-US` so a READ can still
 * be sent; a listing WRITE to such a market is refused by the gateway (MARKET_UNCONFIGURED).
 */
export async function ebayListingLanguage(market: string): Promise<string> {
  try {
    return (await ebayMarketHeaders(market))['Content-Language']
  } catch {
    return 'en-US'
  }
}

export async function ebayMarketHeaders(market: string, contentLanguage?: string | null): Promise<Record<string, string>> {
  const code = market.trim().toUpperCase().replace(/^EBAY_/, '')
  if (!/^[A-Z]{2}$/.test(code)) throw new MarketUnconfigured(`"${market}" is not an eBay market code.`)
  const coordinate = { channel: 'EBAY', code: code === 'GB' ? 'UK' : code }
  const row = await prisma.marketplace.findFirst({ where: coordinate, select: { marketplaceId: true, languages: true, language: true } })
  if (!row) throw new MarketUnconfigured(`The eBay market ${coordinate.code} is not set up in Nexus.`)
  let languages: string[]
  try {
    languages = marketLanguages(coordinate.channel, coordinate.code, [{ ...coordinate, languages: row.languages, language: row.language }])
  } catch (err) {
    throw new MarketUnconfigured(err instanceof Error ? err.message : String(err))
  }
  const language = contentLanguage ? normalizeLanguage(contentLanguage) : languages[0]
  if (!languages.includes(language)) throw new MarketUnconfigured(`${language} is not a language of the eBay market ${coordinate.code} (${languages.join(', ')}).`)
  const tag = languageTag(language, coordinate.code).replace('_', '-')
  const marketplaceId = row.marketplaceId?.startsWith('EBAY_') ? row.marketplaceId : `EBAY_${tag.split('-')[1]}`
  return { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, 'Content-Language': tag, 'Accept-Language': tag }
}

const RATE_READINGS: Record<GatewayChannel, (headers: Headers, status: number) => RateLimitReading | null> = {
  AMAZON_SP: amazonSpRateReading, EBAY: ebayRateReading, SHOPIFY: shopifyRateReading, AMAZON_ADS: amazonAdsRateReading, ETSY: etsyRateReading, GOOGLE: googleRateReading,
}

/** The rate reading of an answer — the connectors' own parsers (they existed, but nothing called them). */
export function rateReadingOf(channel: GatewayChannel, headers: Headers, status: number): RateLimitReading | null {
  try {
    return RATE_READINGS[channel](headers, status)
  } catch {
    return null
  }
}

/**
 * Shopify GraphQL reports throttling and errors INSIDE an HTTP 200, and its headroom in the body
 * (`extensions.cost.throttleStatus`). Returns what the body says, or null for any other answer.
 */
export function shopifyGraphqlBodyOf(text: string): { errors: boolean; throttled: boolean; remaining: number | null; limit: number | null; restoreRate: number | null } | null {
  let body: any
  try { body = JSON.parse(text) } catch { return null }
  if (!body || typeof body !== 'object') return null
  const throttle = body.extensions?.cost?.throttleStatus
  const errors = Array.isArray(body.errors) && body.errors.length > 0
  const throttled = errors && body.errors.some((e: any) => e?.extensions?.code === 'THROTTLED')
  if (!errors && !throttle) return null
  return {
    errors,
    throttled,
    remaining: typeof throttle?.currentlyAvailable === 'number' ? throttle.currentlyAvailable : null,
    limit: typeof throttle?.maximumAvailable === 'number' ? throttle.maximumAvailable : null,
    restoreRate: typeof throttle?.restoreRate === 'number' ? throttle.restoreRate : null,
  }
}

/**
 * Google: which API a host is, for its rate bucket (rate.ts). Google Ads has the scarce quota (a daily
 * operation budget per Cloud project); Merchant Center, Analytics and the sign-in's userinfo each have
 * their own, so one busy API never starves another.
 */
export function googleHostGroup(url: string): 'ads' | 'merchant' | 'analytics' | 'identity' | 'other' {
  const host = new URL(url).hostname
  if (host === 'googleads.googleapis.com') return 'ads'
  if (host === 'merchantapi.googleapis.com') return 'merchant'
  if (host === 'analyticsadmin.googleapis.com' || host === 'analyticsdata.googleapis.com') return 'analytics'
  if (host === 'openidconnect.googleapis.com' || host === 'www.googleapis.com' || host === 'oauth2.googleapis.com') return 'identity'
  return 'other'
}

/**
 * Google Ads writes (Owner 2026-10-15, pick A): `live` — every Google Ads change Nexus sends is one a person approved in
 * Nexus, and that approval is the gate. `NEXUS_GOOGLE_ADS_WRITES=off` is the brake: real writes are then refused before
 * anything is sent (`gated`); a check Google only validates (`validateOnly`) still runs, as it changes nothing.
 */
export function googleAdsWritesMode(): PublishMode {
  return process.env.NEXUS_GOOGLE_ADS_WRITES?.trim().toLowerCase() === 'off' ? 'gated' : 'live'
}

/**
 * Google: the one change Nexus sends — GoogleAdsService.Mutate (`POST https://googleads.googleapis.com/vNN/customers/
 * {id}/googleAds:mutate`), one customer, nothing else. Merchant Center, Analytics and every other Google method (account
 * invitations, billing, client links …) stay out.
 */
export function isGoogleAdsMutate(method: string, url: string): boolean {
  return googleAdsMutateCustomer(method, url) !== null
}

/** The customer id of a GoogleAdsService.Mutate URL, or null when the call is not one. */
export function googleAdsMutateCustomer(method: string, url: string): string | null {
  if (method.toUpperCase() !== 'POST') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== 'googleads.googleapis.com' || parsed.search) return null
  const match = /^\/v\d+\/customers\/(\d{1,20})\/googleAds:mutate$/.exec(parsed.pathname)
  return match ? match[1] : null
}

/**
 * The kinds of operation a Nexus Google Ads change may hold (MutateOperation's fields): budgets, campaigns, their
 * criteria, ad groups, their criteria, ads, assets and their campaign links, shared sets and their keywords and links;
 * labels and their links to campaigns, ad groups, ads and keywords, portfolio bid strategies, and the auto-apply
 * settings of Google's recommendations (G5, 2026-10-15; names checked in the v25 MutateOperation reference).
 * `adOperation` (AdService: an ad's content edited in place — a responsive search ad's texts, its URLs and tracking;
 * MutateOperation.ad_operation in v25, update only) is edit-google-rsa's and set-google-urls'.
 * `customerOperation` (G8b) is set-google-account-settings': an update of the account's own settings only.
 * Anything else in a mutate (a user, a conversion action …) is refused before anything is sent.
 */
export const GOOGLE_ADS_MUTATE_KINDS: ReadonlySet<string> = new Set([
  'campaignBudgetOperation', 'campaignOperation', 'campaignCriterionOperation', 'adGroupOperation', 'adGroupCriterionOperation',
  'adGroupAdOperation', 'adOperation', 'assetOperation', 'campaignAssetOperation', 'sharedSetOperation', 'sharedCriterionOperation',
  'campaignSharedSetOperation',
  // An ad group's device bid adjustment (AdGroupBidModifier; set-google-targeting, programme 2 G2).
  'adGroupBidModifierOperation',
  'labelOperation', 'campaignLabelOperation', 'adGroupLabelOperation', 'adGroupAdLabelOperation', 'adGroupCriterionLabelOperation',
  'biddingStrategyOperation', 'recommendationSubscriptionOperation',
  // G7 (2026-10-15): the account's own exclusions and the lists on the whole account (CustomerNegativeCriterion: create
  // or remove only; MutateOperation.customer_negative_criterion_operation in v25).
  'customerNegativeCriterionOperation',
  // G8b: the account's own settings — an UPDATE of exactly the fields set-google-account-settings writes, never a create
  // or a remove (customerOperationProblem, google-account-calls.ts).
  'customerOperation',
  // An asset linked at an ad group or at the account (AdGroupAsset / CustomerAsset; add-google-assets and
  // set-google-asset-links, programme 2 G6; MutateOperation.ad_group_asset_operation / customer_asset_operation in v25).
  'adGroupAssetOperation', 'customerAssetOperation',
  // G9 (2026-10-15): experiments, their arms and campaign drafts (v25 MutateOperation.experiment_operation,
  // experiment_arm_operation, campaign_draft_operation).
  'experimentOperation', 'experimentArmOperation', 'campaignDraftOperation',
  // Conversion tracking (G8a, 2026-10-15; v25 MutateOperation fields): conversion actions, the account's and campaigns'
  // conversion goals, a campaign's goal level, conversion value rules and rule sets.
  'conversionActionOperation', 'customerConversionGoalOperation', 'campaignConversionGoalOperation',
  'conversionGoalCampaignConfigOperation', 'conversionValueRuleOperation', 'conversionValueRuleSetOperation',
  // G10 (2026-10-16): Performance Max — asset groups, their assets, listing group filters and signals, and audiences made
  // for audience signals (v25 MutateOperation.asset_group_operation, asset_group_asset_operation,
  // asset_group_listing_group_filter_operation, asset_group_signal_operation, audience_operation). PMAX_OPERATION_ACTIONS
  // narrows them to what set-google-pmax and build-google-pmax send.
  'assetGroupOperation', 'assetGroupAssetOperation', 'assetGroupListingGroupFilterOperation', 'assetGroupSignalOperation', 'audienceOperation',
  // G14a (2026-10-16): custom conversion goals (create, update, remove) and user lists — the lists set-google-user-lists
  // makes and changes (userListOperationProblem: never a Customer Match list), v25 MutateOperation.custom_conversion_goal_
  // operation and user_list_operation.
  'customConversionGoalOperation', 'userListOperation',
  // G14b (2026-10-16): page feeds (URL inclusions) — a PAGE_FEED asset set made, its URLs added and taken away, and its link
  // to a campaign (v25 MutateOperation.asset_set_operation, asset_set_asset_operation, campaign_asset_set_operation).
  // PMAX_OPERATION_ACTIONS narrows them to what set-google-page-feed, set-google-pmax and build-google-pmax send, and an
  // asset set made is a PAGE_FEED one only (assetSetCreateProblem).
  'assetSetOperation', 'assetSetAssetOperation', 'campaignAssetSetOperation',
])

/**
 * G10: the actions Nexus sends for the Performance Max kinds — never an asset group removed (Google refuses to remove
 * the last one, and no tool asks), never an audience removed (AudienceOperation v25 has create and update only; G14a's
 * set-google-reusable-audiences changes one), never a listing group filter or signal updated (made and removed only).
 */
export const PMAX_OPERATION_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  assetGroupOperation: ['create', 'update'],
  assetGroupAssetOperation: ['create', 'remove'],
  assetGroupListingGroupFilterOperation: ['create', 'remove'],
  assetGroupSignalOperation: ['create', 'remove'],
  audienceOperation: ['create', 'update'],
  // G14b: a page feed is made (never changed or removed here), its URLs linked and unlinked, the feed linked to a campaign
  // and unlinked (AssetSetAssetOperation / CampaignAssetSetOperation have create and remove only).
  assetSetOperation: ['create'],
  assetSetAssetOperation: ['create', 'remove'],
  campaignAssetSetOperation: ['create', 'remove'],
}

/** G14b: an asset set Nexus makes is a page feed (type PAGE_FEED), with a name and a temporary resource name only. */
function assetSetCreateProblem(op: unknown): string | null {
  const create = (op as { create?: unknown } | null)?.create
  if (!isObject(create)) return null
  if (create.type !== 'PAGE_FEED') return `it makes an asset set of type ${String(create.type ?? 'none')} (Nexus makes PAGE_FEED asset sets only)`
  if (onlyKeys(create, ['resourceName', 'name', 'type']).length) return 'it makes an asset set with more than a name and its type'
  return null
}

/** G14b: a campaign asset set link Nexus makes names exactly its campaign and its asset set (resource names), nothing else. */
function campaignAssetSetCreateProblem(op: unknown): string | null {
  const create = (op as { create?: unknown } | null)?.create
  if (create === undefined) return null
  if (!isObject(create) || onlyKeys(create, ['campaign', 'assetSet']).length || typeof create.campaign !== 'string' || typeof create.assetSet !== 'string'
    || !/^customers\/\d{1,20}\/campaigns\/-?\d{1,20}$/.test(create.campaign) || !/^customers\/\d{1,20}\/assetSets\/-?\d{1,20}$/.test(create.assetSet)) {
    return 'it links an asset set to a campaign without exactly the campaign and the asset set'
  }
  return null
}

/**
 * G14a (2026-10-16): the user lists Nexus makes and changes (reference/rpc/v25/UserList, UserListOperation): a create holds
 * exactly ONE list kind of rule_based_user_list (website visitors), logical_user_list (a combination), basic_user_list
 * (people who converted) or lookalike_user_list — never crm_based_user_list (Customer Match: personal data, which
 * Nexus never uploads), never similar_user_list (Output only). An update writes only the name, description, membership
 * status and life span, eligible_for_search and the rules of those kinds; a remove names a list of this account.
 */
const USER_LIST_KINDS = ['ruleBasedUserList', 'logicalUserList', 'basicUserList', 'lookalikeUserList'] as const
const USER_LIST_FIELDS = ['resourceName', 'name', 'description', 'membershipStatus', 'membershipLifeSpan', 'eligibleForSearch', ...USER_LIST_KINDS]
export const USER_LIST_UPDATE_MASK: ReadonlySet<string> = new Set([
  'name', 'description', 'membership_status', 'membership_life_span', 'eligible_for_search',
  'rule_based_user_list.flexible_rule_user_list', 'logical_user_list.rules', 'basic_user_list.actions',
])

export function userListOperationProblem(op: unknown, customer?: string | null): string | null {
  if (!isObject(op)) return 'the user list operation is not an object'
  const own = (v: unknown) => typeof v === 'string' && new RegExp(`^customers/${customer ?? '\\d{1,20}'}/userLists/\\d{1,20}$`).test(v)
  if ('remove' in op) return Object.keys(op).length === 1 && own(op.remove) ? null : 'a user list remove does not name a list of this account'
  const create = isObject(op.create) ? op.create : null
  const update = isObject(op.update) ? op.update : null
  if (!create === !update) return 'a user list operation is not one create, update or remove'
  const list = (create ?? update) as Record<string, unknown>
  const extra = Object.keys(list).filter((k) => !USER_LIST_FIELDS.includes(k))
  if (extra.length) return `a user list names ${extra.join(', ')} (Nexus never makes or fills a Customer Match list)`
  const kinds = USER_LIST_KINDS.filter((k) => k in list)
  if (create) {
    if (Object.keys(op).length !== 1 || list.resourceName !== undefined || kinds.length !== 1) return 'a new user list is exactly one of a rule-based, combination, converters or lookalike list'
    return null
  }
  if (Object.keys(op).some((k) => k !== 'update' && k !== 'updateMask') || !own(list.resourceName)) return 'a user list update does not name a list of this account'
  if ('lookalikeUserList' in list) return 'a lookalike list cannot be changed (Immutable)'
  const mask = typeof op.updateMask === 'string' ? op.updateMask.split(',') : []
  return mask.length && mask.every((m) => USER_LIST_UPDATE_MASK.has(m)) ? null : 'a user list update masks a field Nexus does not change'
}

// ── G8a: sales sent to Google, and their adjustments ────────────────────────────────────────────────────────────

/**
 * Google: the Data Manager API's event ingestion (G8a, 2026-10-15) — the way sales reach a Google Ads conversion action
 * now that the Google Ads API's UploadClickConversions is closed to Cloud projects that never used it
 * (developers.google.com/google-ads/api/docs/deprecations, 2026-06-15). One exact URL; a POST; its own host.
 */
export const DATA_MANAGER_INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest'

export function isGoogleDataManagerIngest(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  return parsed.hostname === 'datamanager.googleapis.com' && !parsed.search && parsed.pathname === '/v1/events:ingest'
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).filter((k) => !allowed.includes(k))
const SHA256_HEX = /^[0-9a-f]{64}$/
const ORDER_ID = /^[A-Za-z0-9_\-]{1,64}$/
const CLICK_VALUE = /^[A-Za-z0-9_\-.~]{8,1024}$/
/** Google's limit per request (IngestEventsRequest.events, UploadConversionAdjustmentsRequest). */
export const GOOGLE_SALES_MAX_PER_REQUEST = 2000

function productAccountProblem(v: unknown, what: string): string | null {
  if (!isObject(v)) return `${what} is not an object`
  if (onlyKeys(v, ['accountType', 'accountId']).length) return `${what} names more than accountType and accountId`
  if (v.accountType !== 'GOOGLE_ADS' || typeof v.accountId !== 'string' || !/^\d{1,20}$/.test(v.accountId)) return `${what} is not a Google Ads account id`
  return null
}

/**
 * An ingest body as the gateway judges it, or why it is refused: ONE destination (a Google Ads account and a conversion
 * action of it), 1–2000 events, each a sale (transactionId, eventTimestamp, eventSource WEB, value, currency) with exactly
 * one click id and/or user data that is HASHED only (emailAddress / phoneNumber as 64 hex characters: a plain email or
 * phone is never sent) and only with the buyer's consent to ad user data GRANTED on the event; consent ad user data and
 * ad personalization only; encoding HEX; validateOnly a boolean (true = Google's check: it takes nothing). Nothing else.
 * The parsed body is what is sent; `customer` is the account it goes to.
 */
export function googleDataManagerBodyOf(body: unknown): { check: boolean; body: string; customer: string } | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!isObject(parsed)) return { refusal: 'the body is not a JSON object' }
  const extra = onlyKeys(parsed, ['destinations', 'events', 'encoding', 'validateOnly'])
  if (extra.length) return { refusal: `it names ${extra.join(', ')}` }
  if (parsed.validateOnly !== undefined && typeof parsed.validateOnly !== 'boolean') return { refusal: 'validateOnly is not true or false' }
  if (parsed.encoding !== undefined && parsed.encoding !== 'HEX') return { refusal: 'encoding is not HEX' }
  const destinations = parsed.destinations
  if (!Array.isArray(destinations) || destinations.length !== 1 || !isObject(destinations[0])) return { refusal: 'it does not name exactly one destination' }
  const destination = destinations[0]
  if (onlyKeys(destination, ['operatingAccount', 'loginAccount', 'productDestinationId']).length) return { refusal: 'its destination names more than an account and a conversion action' }
  const accountProblem = productAccountProblem(destination.operatingAccount, 'its operating account')
    ?? (destination.loginAccount === undefined ? null : productAccountProblem(destination.loginAccount, 'its login account'))
  if (accountProblem) return { refusal: accountProblem }
  if (typeof destination.productDestinationId !== 'string' || !/^\d{1,20}$/.test(destination.productDestinationId)) return { refusal: 'its destination is not a conversion action id' }
  const events = parsed.events
  if (!Array.isArray(events) || events.length === 0) return { refusal: 'it holds no events' }
  if (events.length > GOOGLE_SALES_MAX_PER_REQUEST) return { refusal: `it holds more than ${GOOGLE_SALES_MAX_PER_REQUEST} events` }
  for (const event of events) {
    if (!isObject(event)) return { refusal: 'an event is not a JSON object' }
    const more = onlyKeys(event, ['transactionId', 'eventTimestamp', 'eventSource', 'conversionValue', 'currency', 'adIdentifiers', 'userData', 'consent'])
    if (more.length) return { refusal: `an event names ${more.join(', ')}` }
    if (typeof event.transactionId !== 'string' || !ORDER_ID.test(event.transactionId)) return { refusal: 'an event has no order id (transactionId)' }
    if (typeof event.eventTimestamp !== 'string' || Number.isNaN(Date.parse(event.eventTimestamp))) return { refusal: 'an event has no time' }
    if (event.eventSource !== 'WEB') return { refusal: 'an event is not a web sale (eventSource WEB)' }
    if (typeof event.conversionValue !== 'number' || !(event.conversionValue >= 0)) return { refusal: 'an event has no value' }
    if (typeof event.currency !== 'string' || !/^[A-Z]{3}$/.test(event.currency)) return { refusal: 'an event has no currency' }
    if (event.adIdentifiers !== undefined) {
      const ids = event.adIdentifiers
      if (!isObject(ids)) return { refusal: 'an event\'s click id is not an object' }
      const kinds = Object.keys(ids)
      if (kinds.length !== 1 || !['gclid', 'gbraid', 'wbraid'].includes(kinds[0]) || typeof ids[kinds[0]] !== 'string' || !CLICK_VALUE.test(ids[kinds[0]] as string)) {
        return { refusal: 'an event does not carry exactly one click id (gclid, gbraid or wbraid)' }
      }
    }
    if (event.userData !== undefined) {
      const data = event.userData
      if (!isObject(data) || onlyKeys(data, ['userIdentifiers']).length || !Array.isArray(data.userIdentifiers) || !data.userIdentifiers.length || data.userIdentifiers.length > 10) {
        return { refusal: 'an event\'s user data is not 1 to 10 identifiers' }
      }
      for (const id of data.userIdentifiers) {
        const keys = isObject(id) ? Object.keys(id) : []
        if (keys.length !== 1 || !['emailAddress', 'phoneNumber'].includes(keys[0]) || typeof (id as Record<string, unknown>)[keys[0]] !== 'string' || !SHA256_HEX.test((id as Record<string, unknown>)[keys[0]] as string)) {
          return { refusal: 'an event\'s user data is not a hashed email or phone (SHA-256, hex): Nexus never sends them in plain text' }
        }
      }
    }
    if (event.adIdentifiers === undefined && event.userData === undefined) return { refusal: 'an event carries neither a click id nor user data' }
    if (event.consent !== undefined) {
      const consent = event.consent
      const status = (v: unknown) => v === undefined || v === 'CONSENT_GRANTED' || v === 'CONSENT_DENIED'
      if (!isObject(consent) || onlyKeys(consent, ['adUserData', 'adPersonalization']).length || consent.adUserData === undefined || !status(consent.adUserData) || !status(consent.adPersonalization)) {
        return { refusal: 'an event\'s consent is not ad user data (and ad personalization) granted or denied' }
      }
    }
    // Defence in depth: a buyer's (hashed) contact goes only with their consent to ad user data, said on the event.
    if (event.userData !== undefined && (event.consent as Record<string, unknown> | undefined)?.adUserData !== 'CONSENT_GRANTED') {
      return { refusal: 'an event carries user data without the buyer\'s consent to ad user data (CONSENT_GRANTED)' }
    }
  }
  return { check: parsed.validateOnly === true, body: JSON.stringify(parsed), customer: (destination.operatingAccount as Record<string, string>).accountId }
}

/**
 * Google: ConversionAdjustmentUploadService.UploadConversionAdjustments (`POST https://googleads.googleapis.com/vNN/
 * customers/{id}:uploadConversionAdjustments`, G8a) — retract a sale or restate its value. One customer.
 */
export function googleAdsAdjustmentCall(method: string, url: string): { customer: string } | null {
  if (method.toUpperCase() !== 'POST') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== 'googleads.googleapis.com' || parsed.search) return null
  const match = /^\/v\d+\/customers\/(\d{1,20}):uploadConversionAdjustments$/.exec(parsed.pathname)
  return match ? { customer: match[1] } : null
}

/**
 * An adjustment body as the gateway judges it, or why it is refused: 1–2000 adjustments, each a RETRACTION or a
 * RESTATEMENT (with its new value) named by order id, with its time; partialFailure true (Google: always), validateOnly a
 * boolean (true = Google's check). No enhancement, no user data, no gclid pair. Each action must be written under THIS
 * customer, but that is tidiness, not the guard: Google ignores the customer id in `conversion_action` and uses only the
 * action id (v25 ConversionAdjustment.conversion_action). The guard is the customer in the URL, which must be the account
 * this business chose through this connection (gateway.ts, googleAdsCustomerLinked).
 */
export function googleAdjustmentBodyOf(call: { customer: string }, body: unknown): { check: boolean; body: string } | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!isObject(parsed)) return { refusal: 'the body is not a JSON object' }
  const extra = onlyKeys(parsed, ['conversionAdjustments', 'partialFailure', 'validateOnly'])
  if (extra.length) return { refusal: `it names ${extra.join(', ')}` }
  if (parsed.partialFailure !== true) return { refusal: 'partialFailure is not true (Google takes adjustments one by one)' }
  if (parsed.validateOnly !== undefined && typeof parsed.validateOnly !== 'boolean') return { refusal: 'validateOnly is not true or false' }
  const adjustments = parsed.conversionAdjustments
  if (!Array.isArray(adjustments) || adjustments.length === 0) return { refusal: 'it holds no adjustments' }
  if (adjustments.length > GOOGLE_SALES_MAX_PER_REQUEST) return { refusal: `it holds more than ${GOOGLE_SALES_MAX_PER_REQUEST} adjustments` }
  const prefix = `customers/${call.customer}/conversionActions/`
  for (const a of adjustments) {
    if (!isObject(a)) return { refusal: 'an adjustment is not a JSON object' }
    const more = onlyKeys(a, ['conversionAction', 'adjustmentType', 'orderId', 'adjustmentDateTime', 'restatementValue'])
    if (more.length) return { refusal: `an adjustment names ${more.join(', ')}` }
    if (typeof a.conversionAction !== 'string' || !a.conversionAction.startsWith(prefix) || !/^\d{1,20}$/.test(a.conversionAction.slice(prefix.length))) {
      return { refusal: 'an adjustment does not name a conversion action of this account' }
    }
    if (typeof a.orderId !== 'string' || !ORDER_ID.test(a.orderId)) return { refusal: 'an adjustment has no order id' }
    if (typeof a.adjustmentDateTime !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(a.adjustmentDateTime)) return { refusal: 'an adjustment has no time' }
    if (a.adjustmentType === 'RETRACTION') {
      if (a.restatementValue !== undefined) return { refusal: 'a retraction names a value' }
    } else if (a.adjustmentType === 'RESTATEMENT') {
      const v = a.restatementValue
      if (!isObject(v) || onlyKeys(v, ['adjustedValue', 'currencyCode']).length || typeof v.adjustedValue !== 'number' || !(v.adjustedValue > 0)
        || (v.currencyCode !== undefined && (typeof v.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(v.currencyCode)))) {
        return { refusal: 'a restatement has no new value' }
      }
    } else {
      return { refusal: 'an adjustment is not a retraction or a restatement' }
    }
  }
  return { check: parsed.validateOnly === true, body: JSON.stringify(parsed) }
}

/**
 * Google: the third change Nexus sends (G9, 2026-10-15) — ExperimentService's actions on ONE experiment and
 * CampaignDraftService's promote of ONE draft, each on its exact path, one customer, nothing else:
 *   POST /vNN/customers/{id}/experiments/{experimentId}:scheduleExperiment | :endExperiment | :promoteExperiment | :graduateExperiment
 *   POST /vNN/customers/{id}/campaignDrafts/{baseCampaignId}~{draftId}:promote
 * Checked 2026-10-15 in the v25 protos the v25 reference links (googleapis google/ads/googleads/v25/services/
 * experiment_service.proto and campaign_draft_service.proto, `google.api.http` with `body: "*"`; the same paths and
 * request bodies in Google Ads' v25 REST discovery document, customers.experiments.* and customers.campaignDrafts.promote):
 * EVERY one of these requests has validate_only, so a check goes as a read (Google changes nothing) and a real one as a
 * write under the publish mode. Their async errors and long-running operations are read with GETs (reads).
 */
export type GoogleExperimentAction = 'scheduleExperiment' | 'endExperiment' | 'promoteExperiment' | 'graduateExperiment' | 'promoteCampaignDraft'

export function googleAdsExperimentCall(method: string, url: string): { customer: string; action: GoogleExperimentAction } | null {
  if (method.toUpperCase() !== 'POST') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== 'googleads.googleapis.com' || parsed.search) return null
  const experiment = /^\/v\d+\/customers\/(\d{1,20})\/experiments\/\d{1,20}:(scheduleExperiment|endExperiment|promoteExperiment|graduateExperiment)$/.exec(parsed.pathname)
  if (experiment) return { customer: experiment[1], action: experiment[2] as GoogleExperimentAction }
  const draft = /^\/v\d+\/customers\/(\d{1,20})\/campaignDrafts\/\d{1,20}~\d{1,20}:promote$/.exec(parsed.pathname)
  return draft ? { customer: draft[1], action: 'promoteCampaignDraft' } : null
}

/**
 * The most experiment campaigns one graduate maps to a budget: GraduateExperimentRequest.campaign_budget_mappings, "The
 * maximum size is one" (v25 reference, 2026-10-15).
 */
export const GOOGLE_GRADUATE_MAX_MAPPINGS = 1

/**
 * An experiment / draft action body as the gateway judges it, or why it is refused: a JSON object holding `validateOnly`
 * (a boolean, camelCase only) and, for a graduate only, `campaignBudgetMappings` — exactly one `{ experimentCampaign,
 * campaignBudget }`, a campaign and a budget of THIS customer (GraduateExperimentRequest.campaign_budget_mappings,
 * CampaignBudgetMapping). Nothing else. The parsed body is what is sent.
 */
export function googleExperimentBodyOf(call: { customer: string; action: GoogleExperimentAction }, body: unknown): GoogleMutateBody | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { refusal: 'the body is not a JSON object' }
  const allowed = call.action === 'graduateExperiment' ? ['validateOnly', 'campaignBudgetMappings'] : ['validateOnly']
  const extra = Object.keys(parsed).filter((k) => !allowed.includes(k))
  if (extra.length) return { refusal: `it names ${extra.join(', ')} (an experiment or draft action holds ${allowed.join(' and ')} only)` }
  if (parsed.validateOnly !== undefined && typeof parsed.validateOnly !== 'boolean') return { refusal: 'validateOnly is not true or false' }
  if (call.action === 'graduateExperiment') {
    const mappings = parsed.campaignBudgetMappings
    if (!Array.isArray(mappings) || mappings.length === 0) return { refusal: 'a graduate names no campaignBudgetMappings' }
    if (mappings.length > GOOGLE_GRADUATE_MAX_MAPPINGS) return { refusal: `a graduate maps more than ${GOOGLE_GRADUATE_MAX_MAPPINGS} campaign` }
    const campaign = new RegExp(`^customers/${call.customer}/campaigns/\\d{1,20}$`)
    const budget = new RegExp(`^customers/${call.customer}/campaignBudgets/\\d{1,20}$`)
    for (const mapping of mappings) {
      const m = (mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? mapping : {}) as Record<string, unknown>
      const keys = Object.keys(m).sort().join(',')
      if (keys !== 'campaignBudget,experimentCampaign' || typeof m.experimentCampaign !== 'string' || typeof m.campaignBudget !== 'string'
        || !campaign.test(m.experimentCampaign) || !budget.test(m.campaignBudget)) {
        return { refusal: 'a campaign budget mapping does not name a campaign and a budget of this account' }
      }
    }
  }
  return { check: parsed.validateOnly === true, body: JSON.stringify(parsed) }
}

/**
 * Google: the second change Nexus sends (G5, 2026-10-15) — RecommendationService.ApplyRecommendation and
 * DismissRecommendation (`POST https://googleads.googleapis.com/vNN/customers/{id}/recommendations:apply` / `:dismiss`),
 * one customer, nothing else. Google has no validate_only for them (v25 ApplyRecommendationRequest and
 * DismissRecommendationRequest: customer_id, operations, partial_failure only): each one is a real change.
 */
export function googleAdsRecommendationCall(method: string, url: string): { customer: string; action: 'apply' | 'dismiss' } | null {
  if (method.toUpperCase() !== 'POST') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== 'googleads.googleapis.com' || parsed.search) return null
  const match = /^\/v\d+\/customers\/(\d{1,20})\/recommendations:(apply|dismiss)$/.exec(parsed.pathname)
  return match ? { customer: match[1], action: match[2] as 'apply' | 'dismiss' } : null
}

/**
 * The apply parameters Nexus sends (ApplyRecommendationOperation's `apply_parameters`, v25, in REST's camelCase): the
 * overrides a person may give for budgets, keywords and bidding targets. Any other is refused before anything is sent.
 */
export const GOOGLE_RECOMMENDATION_APPLY_PARAMETERS: ReadonlySet<string> = new Set([
  'campaignBudget', 'keyword', 'targetCpaOptIn', 'targetRoasOptIn', 'raiseTargetCpa', 'lowerTargetRoas', 'moveUnusedBudget',
  'useBroadMatchKeyword', 'setTargetCpa', 'setTargetRoas', 'forecastingSetTargetCpa', 'forecastingSetTargetRoas',
  'raiseTargetCpaBidTooLow', 'raiseTargetCpaPerformanceBidTooLow', 'lowerTargetRoasPerformanceBidTooLow',
])

/** Google allows 100 operations per apply or dismiss request (v25 ApplyRecommendationRequest.operations). */
export const GOOGLE_RECOMMENDATION_MAX_OPERATIONS = 100

/**
 * An apply / dismiss body as the gateway judges it, or why it is refused: a JSON object holding `operations` only (and
 * `partialFailure: false` when said: all or nothing), 1 to 100 operations, each naming a recommendation of THIS customer
 * by `resourceName` and, for an apply, at most one known apply parameter. No `validateOnly` (Google has none for these
 * methods: a body that names it would read as a check and is refused). The parsed body is what is sent.
 */
export function googleRecommendationBodyOf(call: { customer: string; action: 'apply' | 'dismiss' }, body: unknown): { body: string } | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { refusal: 'the body is not a JSON object' }
  const extra = Object.keys(parsed).filter((k) => k !== 'operations' && k !== 'partialFailure')
  if (extra.length) return { refusal: `it names ${extra.join(', ')} (an apply or dismiss holds operations only; Google cannot check one first)` }
  if (parsed.partialFailure !== undefined && parsed.partialFailure !== false) return { refusal: 'partialFailure is not false (Nexus sends all or nothing)' }
  const operations = parsed.operations
  if (!Array.isArray(operations) || operations.length === 0) return { refusal: 'it holds no operations' }
  if (operations.length > GOOGLE_RECOMMENDATION_MAX_OPERATIONS) return { refusal: `it holds more than ${GOOGLE_RECOMMENDATION_MAX_OPERATIONS} operations` }
  const prefix = `customers/${call.customer}/recommendations/`
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return { refusal: 'an operation is not a JSON object' }
    const op = operation as Record<string, unknown>
    const name = op.resourceName
    if (typeof name !== 'string' || !name.startsWith(prefix) || !/^[^\s'"\\/]{1,200}$/.test(name.slice(prefix.length))) {
      return { refusal: 'an operation does not name a recommendation of this account' }
    }
    const params = Object.keys(op).filter((k) => k !== 'resourceName')
    if (call.action === 'dismiss' && params.length) return { refusal: `a dismiss names ${params.join(', ')}` }
    if (params.length > 1 || (params.length === 1 && !GOOGLE_RECOMMENDATION_APPLY_PARAMETERS.has(params[0]))) {
      return { refusal: `an apply holds a parameter Nexus does not send (${params.join(', ')})` }
    }
  }
  return { body: JSON.stringify(parsed) }
}

export interface GoogleMutateBody {
  /** True only for a body that asks Google to check it and change nothing. */
  check: boolean
  /** The body as it is sent: the parsed JSON written again, so what was judged is what goes. */
  body: string
}

/**
 * A GoogleAdsService.Mutate body as the gateway judges it, or why it is refused: JSON, `mutateOperations` a list of
 * known kinds (one kind per operation), and `validateOnly` a boolean said once in camelCase (Google also reads
 * `validate_only`: a body that names it is refused). Duplicate keys collapse in the parse; the parsed body is what is sent.
 * A `customerOperation` updates THIS customer (`customer`, the URL's, when the gateway judges it) and nothing else.
 */
export function googleMutateBodyOf(body: unknown, customer?: string | null): GoogleMutateBody | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { refusal: 'the body is not a JSON object' }
  if ('validate_only' in parsed || 'mutate_operations' in parsed || 'partial_failure' in parsed) return { refusal: 'the body names a field in snake_case' }
  if (parsed.validateOnly !== undefined && typeof parsed.validateOnly !== 'boolean') return { refusal: 'validateOnly is not true or false' }
  const operations = parsed.mutateOperations
  if (!Array.isArray(operations) || operations.length === 0) return { refusal: 'it holds no mutateOperations' }
  for (const operation of operations) {
    const kinds = operation && typeof operation === 'object' ? Object.keys(operation) : []
    if (kinds.length !== 1 || !GOOGLE_ADS_MUTATE_KINDS.has(kinds[0])) return { refusal: `it holds an operation Nexus does not send (${kinds.join(', ') || 'none'})` }
    if (kinds[0] === 'customerOperation') {
      const problem = customerOperationProblem((operation as Record<string, unknown>).customerOperation, customer)
      if (problem) return { refusal: problem }
    }
    if (kinds[0] === 'userListOperation') {
      const problem = userListOperationProblem((operation as Record<string, unknown>).userListOperation, customer)
      if (problem) return { refusal: problem }
    }
    const allowed = PMAX_OPERATION_ACTIONS[kinds[0]]
    if (allowed) {
      const inner = (operation as Record<string, unknown>)[kinds[0]]
      const actions = inner && typeof inner === 'object' ? Object.keys(inner).filter((k) => k !== 'updateMask') : []
      if (actions.length !== 1 || !allowed.includes(actions[0])) return { refusal: `it holds a ${kinds[0]} ${actions.join('/') || 'without an action'} (Nexus sends ${allowed.join(' or ')} only)` }
    }
    if (kinds[0] === 'assetSetOperation' || kinds[0] === 'campaignAssetSetOperation') {
      const inner = (operation as Record<string, unknown>)[kinds[0]]
      const problem = kinds[0] === 'assetSetOperation' ? assetSetCreateProblem(inner) : campaignAssetSetCreateProblem(inner)
      if (problem) return { refusal: problem }
    }
  }
  return { check: parsed.validateOnly === true, body: JSON.stringify(parsed) }
}

/** Google: a mutate body that only asks Google to check it (`validateOnly: true`): Google changes nothing. */
export function isGoogleValidateOnly(body: unknown): boolean {
  const judged = googleMutateBodyOf(body)
  return !('refusal' in judged) && judged.check
}

/**
 * Google: whether a call only reads. GET reads; so does a POST to a `…:search` / `…:searchStream` method
 * (Google Ads GAQL, Merchant reports), which takes its query in the body, and Google Ads' brand lookup
 * (isGoogleAdsBrandSuggestion, G7). Anything else — `…:mutate`,
 * `…:registerGcp`, PATCH, DELETE — is a change. The gateway lets through only a Google Ads mutate
 * (isGoogleAdsMutate): as a check when it is validate-only, else as a write under the publish mode; an apply or a
 * dismiss of Google's recommendations (googleAdsRecommendationCall), always as a write under the publish mode; an
 * experiment's schedule / end / promote / graduate or a campaign draft's promote (googleAdsExperimentCall, G9), like a
 * mutate: a check when validate-only, else a write; and (G8a) sales sent to Google (isGoogleDataManagerIngest) and
 * their adjustments (googleAdsAdjustmentCall), each a check when validate-only, else a write under the publish mode.
 */
export function googleCallKind(method: string, url: string): 'read' | 'action' {
  const m = method.toUpperCase()
  if (m === 'GET') return 'read'
  if (m !== 'POST') return 'action'
  let pathname: string
  try { pathname = new URL(url).pathname } catch { return 'action' }
  if (isGoogleAdsBrandSuggestion(m, url)) return 'read'
  return /:(search|searchStream)$/.test(pathname) ? 'read' : 'action'
}

/**
 * G7 (2026-10-15): BrandSuggestionService.SuggestBrands (`POST https://googleads.googleapis.com/vNN/customers/{id}
 * :suggestBrands`, body brand_prefix / selected_brands; googleapis brand_suggestion_service.proto v25) only looks brands
 * up by name, so it goes as a read. Exactly that path on the Google Ads host; any other `:suggest…` stays refused.
 */
export function isGoogleAdsBrandSuggestion(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  return parsed.hostname === 'googleads.googleapis.com' && !parsed.search && /^\/v\d+\/customers\/\d{1,20}:suggestBrands$/.test(parsed.pathname)
}

/**
 * The operation group a rate bucket is per. Amazon limits each operation on its own, so the path with
 * ids dropped; Google per API (its host); the others limit per app / per account, so one group.
 */
export function bucketGroupOf(channel: GatewayChannel, method: string, url: string): string {
  if (channel === 'SHOPIFY') return /\/graphql\.json$/.test(new URL(url).pathname) ? 'graphql' : 'rest'
  if (channel === 'GOOGLE') return googleHostGroup(url)
  if (channel !== 'AMAZON_SP') return 'all'
  // `/{api}/{version}/{resource}` — e.g. `/listings/2021-08-01/items`, `/orders/v0/orders` — never
  // the seller id or SKU that follow, so one bucket per operation family, not per SKU.
  const kept = new URL(url).pathname.split('/').filter(Boolean).slice(0, 3)
  return `${method.toUpperCase()} /${kept.join('/')}`
}

/**
 * A stable operation name from a URL when the caller has none: the method and the path, with every part
 * that is not a plain word or an API version replaced by `:id` (ids, SKUs, order numbers never reach a
 * dashboard key).
 */
export function operationOfPath(method: string, url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean).slice(0, 8)
    .map((part) => (/^[A-Za-z]+$/.test(part) || /^(v\d+(\.\d+)?|\d{4}-\d{2}(-\d{2})?)$/.test(part) ? part : ':id'))
  return `${method.toUpperCase()} /${parts.join('/')}`
}

/** The API version a URL carries (`2021-08-01`, `v1`, `v1beta`, `2026-07`), else the connector's declared one. */
export function apiVersionOf(channel: GatewayChannel, url: string): string | null {
  const match = new URL(url).pathname.match(/\/(v\d+(?:\.\d+)?(?:alpha|beta)?\d*|\d{4}-\d{2}(?:-\d{2})?)(?=\/|$)/)
  if (match) return match[1]
  return tryGetChannelSpec(SPEC_KEY[channel])?.apiVersion ?? null
}
