/** CX.1 — Amazon Ads catalogue entry (research R1 §F). Connect lands in CX.3. */
import { registerChannel, type ChannelSpec, type RateLimitReading } from '../../catalog.js'

export const amazonAdsSpec: ChannelSpec = {
  key: 'AMAZON_ADS',
  channelType: 'AMAZON_ADS',
  displayName: 'Amazon Ads',
  available: false, // CX.3
  auth: {
    mode: 'oauth2_pkce',
    authorizeUrl: ({ region }) => (region === 'NA' ? 'https://www.amazon.com/ap/oa' : region === 'FE' ? 'https://apac.account.amazon.com/ap/oa' : 'https://eu.account.amazon.com/ap/oa'),
    tokenUrl: ({ region }) => (region === 'NA' ? 'https://api.amazon.com/auth/o2/token' : region === 'FE' ? 'https://api.amazon.co.jp/auth/o2/token' : 'https://api.amazon.co.uk/auth/o2/token'),
    authorizationParams: { response_type: 'code' },
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: true,
    requiredScopes: ['profile', 'advertising::campaign_management', 'advertising::test:create_account'],
    reviewGatedScopes: [{ scope: 'advertising::audiences', reason: 'Data Provider API needs separate approval' }],
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 365 * 86_400, // tokens issued ≥ 2026-07-30
    rotatesRefreshToken: false,
  },
  regions: [
    { key: 'EU', label: 'Europe', hosts: { api: 'https://advertising-api-eu.amazon.com' } },
    { key: 'NA', label: 'North America', hosts: { api: 'https://advertising-api.amazon.com' } },
    { key: 'FE', label: 'Far East', hosts: { api: 'https://advertising-api-fe.amazon.com' } },
  ],
  defaultRegion: 'EU',
  identity: async () => null,
  heartbeat: async () => ({ ok: false, latencyMs: 0, errorClass: 'unknown', message: 'Amazon Ads connections move onto the connection core in CX.3' }),
  rateLimit: {
    parse: (headers: Headers, status: number): RateLimitReading | null => (status === 429 ? { model: 'token_bucket', retryAfterSec: Number(headers.get('retry-after') ?? 0) || undefined } : null),
    model: 'token_bucket',
  },
  webhooks: { scheme: 'sqs', subscriptionApi: true, lifecycleTopics: [] },
  apiVersion: 'ads-v1 · reporting-v3',
  sandbox: { available: true },
}

registerChannel(amazonAdsSpec)
