/**
 * CX.1 — Amazon Selling Partner API catalogue entry (research R1).
 *
 * Seller Central website authorisation returns the seller id beside the code.
 * `getMarketplaceParticipations` then proves the fresh grant works in the chosen
 * region and discovers the marketplaces reached by it. SP-API permissions are
 * application roles approved by Amazon, not OAuth scopes chosen in this flow.
 */

import { classifyAuthError, registerChannel, type ChannelSpec, type ConnectionHandle, type HeartbeatResult, type RateLimitReading, type ScopeInput } from '../../catalog.js'

const REGION_HOSTS = {
  EU: { api: 'https://sellingpartnerapi-eu.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-eu.amazon.com', consent: 'https://sellercentral-europe.amazon.com' },
  NA: { api: 'https://sellingpartnerapi-na.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-na.amazon.com', consent: 'https://sellercentral.amazon.com' },
  FE: { api: 'https://sellingpartnerapi-fe.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-fe.amazon.com', consent: 'https://sellercentral.amazon.co.jp' },
} as const

function apiHost(handle: ConnectionHandle) {
  const region = (handle.region ?? 'EU') as keyof typeof REGION_HOSTS
  if (!REGION_HOSTS[region]) throw new Error('Choose a supported Amazon region.')
  return handle.environment === 'sandbox' ? REGION_HOSTS[region].sandbox : REGION_HOSTS[region].api
}

export async function amazonParticipations(handle: ConnectionHandle): Promise<any[]> {
  const response = await fetch(`${apiHost(handle)}/sellers/v1/marketplaceParticipations`, {
    signal: AbortSignal.timeout(25_000),
    headers: { 'x-amz-access-token': await handle.token() },
  })
  if (!response.ok) throw new Error(`Amazon seller verification failed (${response.status}).`)
  const data = await response.json() as { payload?: any[] }
  if (!Array.isArray(data.payload)) throw new Error('Amazon returned an invalid seller verification response.')
  return data.payload
}

async function identity(handle: ConnectionHandle) {
  const sellerId = handle.identity?.userId
  if (!sellerId || !/^[A-Z0-9]{6,40}$/.test(sellerId)) throw new Error('Amazon did not return a valid seller identity.')
  const markets = await amazonParticipations(handle)
  if (!markets.some((row) => row.participation?.isParticipating && row.marketplace?.id)) {
    throw new Error('This Amazon seller has no participating marketplaces in the selected region.')
  }
  return { userId: sellerId }
}

async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  try {
    await amazonParticipations(handle)
    return { ok: true, latencyMs: Date.now() - started, identity: handle.identity ?? undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = Number(message.match(/\((\d{3})\)/)?.[1]) || undefined
    return { ok: false, latencyMs: Date.now() - started, errorClass: classifyAuthError(status, message), message }
  }
}

async function discoverScopes(handle: ConnectionHandle): Promise<ScopeInput[]> {
  const rows = await amazonParticipations(handle)
  return rows.map((row) => ({
    kind: 'marketplace' as const,
    externalId: row.marketplace.countryCode ?? row.marketplace.id,
    label: row.marketplace.name,
    region: handle.region ?? undefined,
    isActive: !!row.participation?.isParticipating,
    metadata: { marketplaceId: row.marketplace.id, currency: row.marketplace.defaultCurrencyCode },
  }))
}

function parseRateLimit(headers: Headers, status: number): RateLimitReading | null {
  const rate = headers.get('x-amzn-ratelimit-limit')
  if (status === 429) return { model: 'token_bucket', retryAfterSec: rate ? Math.ceil(1 / Number(rate)) : undefined }
  return rate ? { model: 'token_bucket', limit: Number(rate) } : null
}

export const amazonSpSpec: ChannelSpec = {
  key: 'AMAZON_SP',
  channelType: 'AMAZON',
  displayName: 'Amazon Seller',
  available: true,
  auth: {
    mode: 'oauth2_code',
    permissionModel: 'application_roles',
    identityRequired: true,
    authorizeUrl: ({ region }) => `${REGION_HOSTS[(region as keyof typeof REGION_HOSTS) ?? 'EU'].consent}/apps/authorize/consent`,
    tokenUrl: () => 'https://api.amazon.com/auth/o2/token',
    authorizationParams: {},
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'spapi_oauth_code',
    callbackMetadata: ['selling_partner_id'],
    pkce: false,
    requiredScopes: [],
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 365 * 86_400,
    refreshTokenRequired: true,
    rotatesRefreshToken: false,
  },
  regions: [
    { key: 'EU', label: 'Europe (UK DE FR IT ES NL PL SE BE IE TR)', hosts: REGION_HOSTS.EU },
    { key: 'NA', label: 'North America', hosts: REGION_HOSTS.NA },
    { key: 'FE', label: 'Far East', hosts: REGION_HOSTS.FE },
  ],
  defaultRegion: 'EU',
  identity,
  heartbeat,
  discoverScopes,
  rateLimit: { parse: parseRateLimit, model: 'token_bucket' },
  webhooks: { scheme: 'sqs', subscriptionApi: true, lifecycleTopics: [] },
  apiVersion: 'orders-2026-01-01 · listings-2021-08-01 · finances-2024-06-19',
  sandbox: { available: true },
}

registerChannel(amazonSpSpec)
