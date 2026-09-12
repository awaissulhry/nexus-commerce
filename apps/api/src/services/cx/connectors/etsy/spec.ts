/** Etsy Open API v3 connector: authorization-code + mandatory PKCE and a live shop heartbeat. */
import { CredentialsDecryptError } from '../../../../lib/crypto.js'
import { getChannelApp } from '../../apps.service.js'
import { ChannelAppConfigurationError } from '../../app-configuration-error.js'
import { RefreshFailed } from '../../token.service.js'
import {
  classifyAuthError,
  registerChannel,
  type ChannelSpec,
  type ConnectionHandle,
  type ConnectionIdentity,
  type HeartbeatResult,
  type RateLimitReading,
} from '../../catalog.js'

const API_BASE = 'https://api.etsy.com/v3/application'

/** Every OAuth scope currently published by Etsy. Retired scopes must not be reintroduced. */
export const ETSY_REQUIRED_SCOPES = [
  'address_r',
  'address_w',
  'email_r',
  'listings_d',
  'listings_r',
  'listings_w',
  'profile_r',
  'profile_w',
  'shops_r',
  'shops_w',
  'transactions_r',
  'transactions_w',
]

interface EtsySelf {
  user_id?: unknown
  shop_id?: unknown
}

interface EtsyShop {
  shop_id?: unknown
  user_id?: unknown
  shop_name?: unknown
  login_name?: unknown
  currency_code?: unknown
  shop_location_country_iso?: unknown
  shipping_from_country_iso?: unknown
}

interface EtsyConnectionData {
  response: Response
  body: string
  self: EtsySelf | null
  shop: EtsyShop | null
}

function positiveId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  return value
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseJson<T>(body: string): T | null {
  try { return JSON.parse(body) as T } catch { return null }
}

async function connectionData(handle: ConnectionHandle): Promise<EtsyConnectionData> {
  const environment = handle.environment ?? 'production'
  const app = await getChannelApp('ETSY', environment)
  if (!app.clientId.trim() || !app.clientSecret.trim()) {
    throw new Error('The Etsy Seller App API key and shared secret are not configured.')
  }

  const token = await handle.token()
  const apiKey = `${app.clientId}:${app.clientSecret}`
  const commonHeaders = { Accept: 'application/json', 'x-api-key': apiKey }
  const selfResponse = await fetch(`${API_BASE}/users/me`, {
    headers: { ...commonHeaders, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  const selfBody = await selfResponse.text()
  const self = parseJson<EtsySelf>(selfBody)
  if (!selfResponse.ok) return { response: selfResponse, body: selfBody, self, shop: null }

  const shopId = positiveId(self?.shop_id)
  if (!positiveId(self?.user_id) || !shopId) return { response: selfResponse, body: selfBody, self, shop: null }

  const shopResponse = await fetch(`${API_BASE}/shops/${encodeURIComponent(shopId)}`, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  const shopBody = await shopResponse.text()
  return { response: shopResponse, body: shopBody, self, shop: parseJson<EtsyShop>(shopBody) }
}

function identityOf(data: Pick<EtsyConnectionData, 'self' | 'shop'>): ConnectionIdentity | null {
  const userId = positiveId(data.self?.user_id)
  const shopId = positiveId(data.self?.shop_id)
  const shopUserId = positiveId(data.shop?.user_id)
  const returnedShopId = positiveId(data.shop?.shop_id)
  if (!userId || !shopId || shopUserId !== userId || returnedShopId !== shopId) return null

  const shopName = textValue(data.shop?.shop_name)
  const loginName = textValue(data.shop?.login_name)
  const label = shopName ?? loginName ?? `Etsy shop ${shopId}`
  return {
    userId,
    username: loginName ?? shopName,
    storeName: label,
    storeUrl: shopName ? `https://www.etsy.com/shop/${encodeURIComponent(shopName)}` : undefined,
    extra: {
      shopId,
      shopName: shopName ?? null,
      currencyCode: textValue(data.shop?.currency_code) ?? null,
      countryCode: textValue(data.shop?.shop_location_country_iso) ?? textValue(data.shop?.shipping_from_country_iso) ?? null,
    },
  }
}

async function identity(handle: ConnectionHandle): Promise<ConnectionIdentity | null> {
  const result = await connectionData(handle)
  return result.response.ok ? identityOf(result) : null
}

async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  try {
    const result = await connectionData(handle)
    const latencyMs = Date.now() - started
    const verifiedIdentity = identityOf(result)
    if (result.response.ok && verifiedIdentity) {
      // Etsy's identity endpoints do not introspect OAuth scopes.
      return { ok: true, latencyMs, identity: verifiedIdentity }
    }
    return {
      ok: false,
      latencyMs,
      status: result.response.status,
      errorClass: result.response.ok ? 'unknown' : classifyAuthError(result.response.status, result.body),
      message: result.response.ok
        ? 'Etsy returned an invalid or mismatched shop identity.'
        : `Etsy account check ${result.response.status}: ${result.body.slice(0, 200)}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RefreshFailed) return { ok: false, latencyMs: Date.now() - started, errorClass: error.errorClass, message }
    if (error instanceof ChannelAppConfigurationError || error instanceof CredentialsDecryptError || /NEXUS_CREDENTIAL_ENC_KEY|No ChannelApp row|Etsy Seller App/i.test(message)) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        errorClass: 'configuration',
        message: 'The server cannot use this account’s credentials. Check the deployment encryption key and Etsy Seller App configuration.',
      }
    }
    return {
      ok: false,
      latencyMs: Date.now() - started,
      errorClass: /needs_reauth|no credentials/i.test(message) ? 'auth_expired' : 'network',
      message,
    }
  }
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export const etsySpec: ChannelSpec = {
  key: 'ETSY',
  channelType: 'ETSY',
  displayName: 'Etsy',
  available: true,
  auth: {
    mode: 'oauth2_pkce',
    identityRequired: true,
    authorizeUrl: () => 'https://www.etsy.com/oauth/connect',
    tokenUrl: () => 'https://api.etsy.com/v3/public/oauth/token',
    authorizationParams: { response_type: 'code' },
    tokenRequestAuth: 'body',
    // Etsy's OAuth endpoint takes the public keystring as client_id; the shared
    // secret belongs only in the x-api-key header on Open API requests.
    includeClientSecretInTokenRequest: false,
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: true,
    requiredScopes: ETSY_REQUIRED_SCOPES,
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 90 * 86_400,
    refreshTokenRequired: true,
    rotatesRefreshToken: true,
  },
  identity,
  heartbeat,
  discoverScopes: async (handle) => {
    const shopId = positiveId(handle.identity?.extra?.shopId)
    if (!shopId) return []
    return [{
      kind: 'shop',
      externalId: shopId,
      label: handle.identity?.storeName ?? handle.identity?.username ?? `Etsy shop ${shopId}`,
      metadata: { storeUrl: handle.identity?.storeUrl ?? null },
    }]
  },
  rateLimit: {
    parse: (headers: Headers, status: number): RateLimitReading | null => {
      const remaining = numericHeader(headers, 'x-remaining-today')
      const limit = numericHeader(headers, 'x-limit-per-day')
      if (remaining !== undefined || limit !== undefined || status === 429) {
        return {
          model: 'daily_quota',
          remaining,
          limit,
          retryAfterSec: status === 429 ? numericHeader(headers, 'retry-after') ?? 1 : undefined,
        }
      }
      return null
    },
    model: 'daily_quota',
  },
  webhooks: { scheme: 'standard-webhooks', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: '3.0.0',
  sandbox: { available: false },
}

registerChannel(etsySpec)
