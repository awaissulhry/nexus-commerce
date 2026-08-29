/**
 * CX.1 — the ChannelCatalog.
 *
 * One declarative entry per channel: how it authenticates, what we must ask for,
 * how long its tokens live, how to prove a grant is alive, how to name the
 * account, how to parse its rate-limit headers, which calls it makes us sign.
 * The OAuth service, the token service, the heartbeat job and the Channels page
 * all read this — adding a channel is one entry here plus one connector
 * directory (docs/2026-08-29-cx1-connection-core.md §2).
 *
 * Unlike Nango's commerce entries (research R8 §2) ours carry the things a
 * marketplace connector actually needs: refresh-token lifetimes, whether the
 * refresh token rotates, rate-limit headers, request-signing rules and the
 * review-gated scopes so the UI can say exactly what is missing and why.
 */

export type ChannelKey = 'EBAY' | 'AMAZON_SP' | 'AMAZON_ADS' | 'SHOPIFY' | 'ETSY'

/** The `channelType` value stored on ChannelConnection for a catalogue key. */
export const CHANNEL_TYPE_OF: Record<ChannelKey, string> = {
  EBAY: 'EBAY',
  AMAZON_SP: 'AMAZON',
  AMAZON_ADS: 'AMAZON_ADS',
  SHOPIFY: 'SHOPIFY',
  ETSY: 'ETSY',
}

export function channelKeyOf(channelType: string): ChannelKey | null {
  const hit = (Object.keys(CHANNEL_TYPE_OF) as ChannelKey[]).find((k) => CHANNEL_TYPE_OF[k] === channelType)
  return hit ?? null
}

export type AuthMode = 'oauth2_code' | 'oauth2_pkce' | 'oauth2_cc' | 'api_key' | 'hmac_key'
/**
 * auth_revoked / auth_expired → the grant itself is dead (needs_reauth).
 * forbidden → the grant is alive but this call is not allowed (scope, policy) — degrade by count, never reauth.
 * signature  → OUR request signing is wrong (eBay 215000–215122) — an engineering defect, never the operator's.
 * transient  → the channel is unwell (5xx) — degrade by count.
 */
export type ErrorClass = 'auth_revoked' | 'auth_expired' | 'forbidden' | 'signature' | 'rate_limited' | 'transient' | 'network' | 'unknown'

export interface RateLimitReading {
  /** Remaining calls in the current window, when the channel reports it. */
  remaining?: number
  /** Window ceiling, when reported. */
  limit?: number
  /** Seconds until the window resets / until a retry is allowed. */
  retryAfterSec?: number
  model: 'token_bucket' | 'daily_quota' | 'leaky_bucket' | 'points'
}

export interface HeartbeatOk {
  ok: true
  latencyMs: number
  /** Scopes the channel reports for this token, when it can tell us. */
  scopes?: string[]
  identity?: ConnectionIdentity
}
export interface HeartbeatFailed {
  ok: false
  latencyMs: number
  errorClass: ErrorClass
  status?: number
  message: string
}
export type HeartbeatResult = HeartbeatOk | HeartbeatFailed

export interface ConnectionIdentity {
  /** Stable, immutable id at the channel (eBay userId, Amazon sellerId, shop domain). */
  userId: string
  username?: string
  storeName?: string
  storeUrl?: string
  extra?: Record<string, unknown>
}

export interface ScopeInput {
  kind: 'marketplace' | 'shop' | 'profile' | 'storefront'
  externalId: string
  label?: string
  region?: string
  isActive?: boolean
  metadata?: Record<string, unknown>
}

/** What a connector receives instead of a row with tokens. */
export interface ConnectionHandle {
  id: string
  channelKey: ChannelKey
  channelType: string
  region: string | null
  grantedScopes: string[]
  identity: ConnectionIdentity | null
  /** Resolves a live access token (refreshing under the lease when needed). */
  token(): Promise<string>
}

export interface AuthSpec {
  mode: AuthMode
  /** Builds the consent URL; `region` is a catalogue region key. */
  authorizeUrl?: (ctx: { region: string | null; environment: 'production' | 'sandbox' }) => string
  tokenUrl: (ctx: { region: string | null; environment: 'production' | 'sandbox' }) => string
  /** Extra query params on the consent URL. */
  authorizationParams?: Record<string, string>
  tokenParams?: Record<string, string>
  refreshParams?: Record<string, string>
  /** How client credentials reach the token endpoint. */
  tokenRequestAuth: 'basic' | 'body'
  scopeSeparator: ' ' | ','
  /** The query param that carries the authorization code on the callback. */
  codeParamInCallback: string
  /** Callback query params worth keeping (SP-API `selling_partner_id`, Walmart `sellerId`). */
  callbackMetadata?: string[]
  /** Token-response fields worth keeping beyond the standard ones. */
  tokenResponseMetadata?: string[]
  pkce: boolean
  /** Forces a real sign-in page (eBay `prompt=login`). */
  promptParam?: Record<string, string>
  /** Every scope we are eligible for — rule 4 (maximal scopes). */
  requiredScopes: string[]
  reviewGatedScopes?: { scope: string; reason: string }[]
  accessTokenLifetimeSec?: number
  /** null = never expires (Shopify offline token); undefined = unknown. */
  refreshTokenLifetimeSec?: number | null
  rotatesRefreshToken: boolean
  revokeUrl?: (ctx: { environment: 'production' | 'sandbox' }) => string
  introspectUrl?: (ctx: { environment: 'production' | 'sandbox' }) => string
  /** Token-endpoint minting limits per day, where published (eBay). */
  tokenEndpointDailyLimits?: { authorization_code?: number; refresh_token?: number; client_credentials?: number }
}

export interface ChannelSpec {
  key: ChannelKey
  channelType: string
  displayName: string
  /** false until the connector phase ships — the UI renders an honest "not yet available". */
  available: boolean
  auth: AuthSpec
  regions?: { key: string; label: string; hosts: Record<string, string> }[]
  defaultRegion?: string
  identity: (handle: ConnectionHandle) => Promise<ConnectionIdentity | null>
  heartbeat: (handle: ConnectionHandle) => Promise<HeartbeatResult>
  /** Amazon participations, Ads profiles, TikTok shops … */
  discoverScopes?: (handle: ConnectionHandle) => Promise<ScopeInput[]>
  signing?: { scheme: 'ebay-rfc9421' | 'kaufland-hmac' | 'tiktok-sign'; appliesTo: (method: string, url: string) => boolean }
  rateLimit: { parse: (headers: Headers, status: number) => RateLimitReading | null; model: RateLimitReading['model'] }
  webhooks: {
    scheme: 'ebay-ecdsa' | 'shopify-hmac' | 'sqs' | 'standard-webhooks' | 'none'
    subscriptionApi: boolean
    lifecycleTopics: string[]
  }
  apiVersion: string
  sandbox: { available: boolean }
  /** Present only on key-paste exception channels (rule 3 exception list). */
  connectException?: { reason: string; deepLink: string }
  /** Access-token refresh buffer; default 15 min. */
  tokenExpirationBufferSec?: number
}

// ── registry ──────────────────────────────────────────────────────────────────

const specs = new Map<ChannelKey, ChannelSpec>()

export function registerChannel(spec: ChannelSpec): void {
  specs.set(spec.key, spec)
}

export function getChannelSpec(key: ChannelKey): ChannelSpec {
  const s = specs.get(key)
  if (!s) throw new Error(`No ChannelSpec registered for ${key}`)
  return s
}

export function tryGetChannelSpec(key: string): ChannelSpec | null {
  return specs.get(key as ChannelKey) ?? null
}

export function listChannelSpecs(): ChannelSpec[] {
  return [...specs.values()]
}

/** `required − granted`, honouring eBay's rule that a manage scope implies its readonly twin. */
export function scopeDriftOf(spec: ChannelSpec, granted: string[]): string[] {
  const have = new Set(granted)
  const implied = new Set<string>()
  for (const g of granted) {
    if (g.endsWith('.readonly')) continue
    implied.add(`${g}.readonly`)
    if (g.startsWith('write_')) implied.add(g.replace(/^write_/, 'read_')) // Shopify: write_x ⇒ read_x
  }
  return spec.auth.requiredScopes.filter((s) => !have.has(s) && !implied.has(s))
}

/** Generic OAuth error classification shared by connectors. */
export function classifyAuthError(status: number | undefined, body: string): ErrorClass {
  const b = body.toLowerCase()
  if (status === 429) return 'rate_limited'
  // eBay's request-signature family (215000–215122) is a defect in OUR signing,
  // not a revoked grant: it must never push a healthy connection to needs_reauth.
  if (/"errorid"\s*:\s*(?:2150\d\d|2151[01]\d|21512[0-2])(?!\d)/.test(b)) return 'signature'
  if (b.includes('invalid_grant') || b.includes('revoked') || b.includes('invalid refresh token')) return 'auth_revoked'
  if (b.includes('expired')) return 'auth_expired'
  if (status === 401) return 'auth_revoked'
  if (status === 403) return 'forbidden'
  if (status === undefined) return 'network'
  if (status >= 500) return 'transient'
  return 'unknown'
}
