/**
 * CX.1 — the eBay catalogue entry (research R2).
 *
 * Auth: OAuth 2.0 authorization-code at auth.ebay.com, `redirect_uri` = the
 * RuName (the real URL lives at eBay), `prompt=login` so the operator is always
 * asked WHICH account; access tokens 7200 s; refresh tokens ~18 months and NOT
 * rotated; adding a scope later requires a new consent from every user, so the
 * full EU-seller set is requested up front (rule 4).
 *
 * Signing: EU/UK-domiciled sellers must sign Finances, `issueRefund`, Trading
 * `GetAccount` and Post-Order refunds with RFC 9421 digital signatures — the
 * 215xxx 403 family the prod financial sync has been hitting daily.
 */

import { registerChannel, type ChannelSpec, type ConnectionHandle, type HeartbeatResult, type RateLimitReading } from '../../catalog.js'
import { ebaySignatureAppliesTo } from './signing.js'

const S = 'https://api.ebay.com/oauth/api_scope'

/** Every scope an EU seller connector needs (research B1.3 / R2 §B). */
export const EBAY_REQUIRED_SCOPES: string[] = [
  S,
  `${S}/sell.inventory`,
  `${S}/sell.inventory.readonly`,
  `${S}/sell.account`,
  `${S}/sell.account.readonly`,
  `${S}/sell.marketing`,
  `${S}/sell.marketing.readonly`,
  `${S}/sell.fulfillment`,
  `${S}/sell.fulfillment.readonly`,
  `${S}/sell.finances`,
  `${S}/sell.payment.dispute`,
  `${S}/sell.analytics.readonly`,
  `${S}/sell.logistics`,
  `${S}/sell.stores`,
  `${S}/sell.stores.readonly`,
  `${S}/commerce.identity.readonly`,
  `${S}/commerce.notification.subscription`,
  `${S}/commerce.notification.subscription.readonly`,
  `${S}/commerce.catalog.readonly`,
  `${S}/commerce.message`,
  `${S}/commerce.feedback`,
  `${S}/commerce.shipping`,
]

export const EBAY_HOSTS = {
  production: { auth: 'https://auth.ebay.com', api: 'https://api.ebay.com', apiz: 'https://apiz.ebay.com' },
  sandbox: { auth: 'https://auth.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com', apiz: 'https://apiz.sandbox.ebay.com' },
} as const

export const EBAY_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'AT', 'IE', 'PL', 'US'] as const

async function identity(handle: ConnectionHandle) {
  const token = await handle.token()
  const base = process.env.EBAY_IDENTITY_BASE ?? EBAY_HOSTS.production.apiz
  const res = await fetch(`${base}/commerce/identity/v1/user/`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { userId?: string; username?: string }
  if (!data?.userId && !data?.username) return null
  return { userId: data.userId ?? data.username!, username: data.username ?? data.userId! }
}

async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  try {
    const token = await handle.token()
    const base = process.env.EBAY_IDENTITY_BASE ?? EBAY_HOSTS.production.apiz
    const res = await fetch(`${base}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    const latencyMs = Date.now() - started
    if (res.ok) {
      const data = (await res.json()) as { userId?: string; username?: string }
      return {
        ok: true,
        latencyMs,
        identity: data?.userId ? { userId: data.userId, username: data.username ?? data.userId } : undefined,
      }
    }
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      latencyMs,
      status: res.status,
      errorClass: res.status === 401 ? 'auth_revoked' : res.status === 429 ? 'rate_limited' : 'unknown',
      message: `identity ${res.status}: ${text.slice(0, 200)}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cls = message.includes('needs_reauth') || message.includes('no credentials') ? 'auth_expired' : 'network'
    return { ok: false, latencyMs: Date.now() - started, errorClass: cls, message }
  }
}

function parseRateLimit(headers: Headers, status: number): RateLimitReading | null {
  const retryAfter = headers.get('retry-after')
  if (status === 429 || retryAfter) {
    return { model: 'daily_quota', retryAfterSec: retryAfter ? Number(retryAfter) : undefined }
  }
  return null
}

export const ebaySpec: ChannelSpec = {
  key: 'EBAY',
  channelType: 'EBAY',
  displayName: 'eBay',
  available: true,
  auth: {
    mode: 'oauth2_code',
    authorizeUrl: ({ environment }) => `${EBAY_HOSTS[environment].auth}/oauth2/authorize`,
    tokenUrl: ({ environment }) => `${EBAY_HOSTS[environment].api}/identity/v1/oauth2/token`,
    revokeUrl: ({ environment }) => `${EBAY_HOSTS[environment].api}/identity/v1/oauth2/token/revoke`,
    introspectUrl: ({ environment }) => `${EBAY_HOSTS[environment].api}/identity/v1/oauth2/token/introspect`,
    authorizationParams: { response_type: 'code' },
    tokenParams: {},
    refreshParams: {},
    tokenRequestAuth: 'basic',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    tokenResponseMetadata: ['refresh_token_expires_in', 'token_type'],
    pkce: false,
    promptParam: { prompt: 'login' },
    requiredScopes: EBAY_REQUIRED_SCOPES,
    reviewGatedScopes: [
      { scope: `${S}/buy.*`, reason: 'Buy APIs require a separate licence' },
      { scope: `${S}/commerce.vero`, reason: 'VeRO programme members only' },
    ],
    accessTokenLifetimeSec: 7200,
    refreshTokenLifetimeSec: 47_304_000,
    rotatesRefreshToken: false,
    tokenEndpointDailyLimits: { client_credentials: 1000, authorization_code: 10_000, refresh_token: 50_000 },
  },
  regions: [{ key: 'GLOBAL', label: 'All eBay marketplaces', hosts: EBAY_HOSTS.production }],
  defaultRegion: 'GLOBAL',
  identity,
  heartbeat,
  signing: { scheme: 'ebay-rfc9421', appliesTo: (method, url) => ebaySignatureAppliesTo(url, method) },
  rateLimit: { parse: parseRateLimit, model: 'daily_quota' },
  webhooks: {
    scheme: 'ebay-ecdsa',
    subscriptionApi: true,
    lifecycleTopics: ['AUTHORIZATION_REVOCATION', 'MARKETPLACE_ACCOUNT_DELETION'],
  },
  apiVersion: 'sell-v1 · trading-1477',
  sandbox: { available: true },
  tokenExpirationBufferSec: 10 * 60,
}

registerChannel(ebaySpec)
