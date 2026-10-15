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
 * Anything else in a mutate (a customer, a user, a conversion action …) is refused before anything is sent.
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
])

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
 */
export function googleMutateBodyOf(body: unknown): GoogleMutateBody | { refusal: string } {
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
 * (isGoogleAdsMutate): as a check when it is validate-only, else as a write under the publish mode; and an apply or a
 * dismiss of Google's recommendations (googleAdsRecommendationCall), always as a write under the publish mode.
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
