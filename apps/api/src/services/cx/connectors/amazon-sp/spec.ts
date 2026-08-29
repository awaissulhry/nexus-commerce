/**
 * CX.1 — Amazon Selling Partner API catalogue entry (research R1).
 *
 * Connect is CX.3 (`available: false` here); what CX.1 needs from this entry is
 * the heartbeat for the env-managed row — `getMarketplaceParticipations`, which
 * is the only call that proves the env refresh token is alive and which also
 * refreshes the Marketplace participation columns (stale since June on prod) —
 * and scope discovery (one grant = one region = many marketplaces).
 */

import { registerChannel, type ChannelSpec, type HeartbeatResult, type RateLimitReading, type ScopeInput } from '../../catalog.js'

const REGION_HOSTS = {
  EU: { api: 'https://sellingpartnerapi-eu.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-eu.amazon.com', consent: 'https://sellercentral-europe.amazon.com' },
  NA: { api: 'https://sellingpartnerapi-na.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-na.amazon.com', consent: 'https://sellercentral.amazon.com' },
  FE: { api: 'https://sellingpartnerapi-fe.amazon.com', sandbox: 'https://sandbox.sellingpartnerapi-fe.amazon.com', consent: 'https://sellercentral.amazon.co.jp' },
} as const

async function heartbeat(): Promise<HeartbeatResult> {
  const started = Date.now()
  try {
    const { refreshAmazonParticipations } = await import('../../../amazon-participations.service.js')
    const r = await refreshAmazonParticipations()
    return { ok: true, latencyMs: Date.now() - started, identity: process.env.AMAZON_SELLER_ID ? { userId: process.env.AMAZON_SELLER_ID } : undefined, scopes: undefined, ...(r.warnings.length ? {} : {}) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const m = message.toLowerCase()
    const errorClass = m.includes('invalid_grant') || m.includes('401') || m.includes('403') ? 'auth_revoked' : m.includes('429') ? 'rate_limited' : 'network'
    return { ok: false, latencyMs: Date.now() - started, errorClass, message }
  }
}

async function discoverScopes(): Promise<ScopeInput[]> {
  const prisma = (await import('../../../../db.js')).default
  const rows = await prisma.marketplace.findMany({ where: { channel: 'AMAZON', marketplaceId: { not: null } }, select: { code: true, name: true, region: true, marketplaceId: true, isParticipating: true, participationStatus: true } })
  return rows.map((r) => ({ kind: 'marketplace' as const, externalId: r.code, label: r.name, region: r.region, isActive: !!r.isParticipating, metadata: { marketplaceId: r.marketplaceId, participationStatus: r.participationStatus } }))
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
  available: false, // CX.3
  auth: {
    mode: 'oauth2_code',
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
    rotatesRefreshToken: false,
  },
  regions: [
    { key: 'EU', label: 'Europe (UK DE FR IT ES NL PL SE BE IE TR)', hosts: REGION_HOSTS.EU },
    { key: 'NA', label: 'North America', hosts: REGION_HOSTS.NA },
    { key: 'FE', label: 'Far East', hosts: REGION_HOSTS.FE },
  ],
  defaultRegion: 'EU',
  identity: async () => (process.env.AMAZON_SELLER_ID ? { userId: process.env.AMAZON_SELLER_ID } : null),
  heartbeat,
  discoverScopes,
  rateLimit: { parse: parseRateLimit, model: 'token_bucket' },
  webhooks: { scheme: 'sqs', subscriptionApi: true, lifecycleTopics: [] },
  apiVersion: 'orders-2026-01-01 · listings-2021-08-01 · finances-2024-06-19',
  sandbox: { available: true },
}

registerChannel(amazonSpSpec)
