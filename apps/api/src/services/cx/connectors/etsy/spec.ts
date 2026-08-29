/** CX.1 — Etsy catalogue entry (research R4). Connect lands in CX.6 (Seller App, PKCE mandatory, refresh rotates every refresh, 90-day refresh tokens). */
import { registerChannel, type ChannelSpec, type RateLimitReading } from '../../catalog.js'

export const ETSY_REQUIRED_SCOPES = ['listings_r', 'listings_w', 'listings_d', 'shops_r', 'shops_w', 'transactions_r', 'transactions_w', 'email_r', 'address_r']

export const etsySpec: ChannelSpec = {
  key: 'ETSY',
  channelType: 'ETSY',
  displayName: 'Etsy',
  available: false, // CX.6
  auth: {
    mode: 'oauth2_pkce',
    authorizeUrl: () => 'https://www.etsy.com/oauth/connect',
    tokenUrl: () => 'https://api.etsy.com/v3/public/oauth/token',
    authorizationParams: { response_type: 'code' },
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: true,
    requiredScopes: ETSY_REQUIRED_SCOPES,
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 90 * 86_400,
    rotatesRefreshToken: true,
  },
  identity: async () => null,
  heartbeat: async () => ({ ok: false, latencyMs: 0, errorClass: 'unknown', message: 'Etsy connector lands in CX.6' }),
  rateLimit: {
    parse: (headers: Headers, status: number): RateLimitReading | null => {
      const remaining = headers.get('x-remaining-today')
      const limit = headers.get('x-limit-per-day')
      if (remaining || status === 429) return { model: 'daily_quota', remaining: remaining ? Number(remaining) : undefined, limit: limit ? Number(limit) : undefined, retryAfterSec: status === 429 ? Number(headers.get('retry-after') ?? 1) : undefined }
      return null
    },
    model: 'daily_quota',
  },
  webhooks: { scheme: 'standard-webhooks', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: '3.0.0',
  sandbox: { available: false },
}

registerChannel(etsySpec)
