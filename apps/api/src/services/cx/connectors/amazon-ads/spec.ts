/**
 * Amazon Ads — the catalogue entry, on the connection core (CX.3a).
 *
 * One LWA grant covers N advertising profiles, so the shape is ONE connection and one
 * `ConnectionScope` per profile — not one connection per profile. Measured on prod
 * 2026-08-29: nine `AmazonAdsConnection` rows carried **one** distinct encrypted
 * credential between them, which is the same fact stored nine times.
 *
 * The hosts below are the ones the flow that actually works uses today
 * (`routes/amazon-ads-auth.routes.ts`), not the regional ones this file guessed while
 * it was a stub: consent at `www.amazon.com/ap/oa`, tokens at `api.amazon.com`. A
 * catalogue that disagrees with the working flow is worse than no catalogue.
 */
import { registerChannel, type ChannelSpec, type ConnectionHandle, type ScopeInput } from '../../catalog.js'
import { amazonAdsRateReading } from '../../rate-readings.js'
import { logger } from '../../../../utils/logger.js'
import { ADS_REGION_HOSTS, ADS_REGIONS, adsConsentUrl } from '../../../ads-core/ads-regions.js'

/** P4.5b — re-exported from the one accessor so this file cannot drift from the client. */
export { ADS_REGION_HOSTS }

interface AdsProfile {
  profileId: number | string
  countryCode?: string
  currencyCode?: string
  timezone?: string
  accountInfo?: { id?: string; name?: string; type?: string; marketplaceStringId?: string }
}

/**
 * `GET /v2/profiles` on one regional host.
 *
 * Returns `null` (rather than throwing) when the host answers anything but 2xx, so a
 * region we have no profiles in cannot fail the whole discovery — the live callback's
 * EU-only hard-coding is exactly why NA/FE profiles were invisible until now.
 */
async function profilesForRegion(
  region: string,
  token: string,
  clientId: string,
): Promise<{ profiles: AdsProfile[]; status: number; latencyMs: number } | null> {
  const host = ADS_REGION_HOSTS[region]
  if (!host) return null
  const started = Date.now()
  try {
    // gateway-exempt: connector identity / heartbeat: runs while the account is made or checked; it decides the state the gateway reads
    const res = await fetch(`${host}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Content-Type': 'application/json',
      },
    })
    const latencyMs = Date.now() - started
    if (!res.ok) return { profiles: [], status: res.status, latencyMs }
    const body = (await res.json().catch(() => [])) as AdsProfile[]
    return { profiles: Array.isArray(body) ? body : [], status: res.status, latencyMs }
  } catch {
    return null
  }
}

/** The LWA client id the Ads API wants in its own header — the app's, never the grant's. */
async function adsClientId(): Promise<string | null> {
  try {
    const { getChannelApp } = await import('../../apps.service.js')
    const app = await getChannelApp('AMAZON_ADS', 'production')
    return app?.clientId ?? null
  } catch {
    return null
  }
}

async function identity(handle: ConnectionHandle) {
  const clientId = await adsClientId()
  if (!clientId) return null
  const token = await handle.token()
  const region = handle.region ?? 'EU'
  const result = await profilesForRegion(region, token, clientId)
  const first = result?.profiles.find((p) => p.accountInfo?.id) ?? result?.profiles[0]
  if (!first) return null
  const account = first.accountInfo
  return {
    // The ADVERTISING ACCOUNT is the identity; a profile is a market within it, which
    // is why profiles are scopes and not identities.
    userId: account?.id ?? String(first.profileId),
    username: account?.name ?? undefined,
    extra: { accountType: account?.type, profileCount: result?.profiles.length ?? 0 },
  }
}

async function heartbeat(handle: ConnectionHandle) {
  const started = Date.now()
  const clientId = await adsClientId()
  if (!clientId) {
    return {
      ok: false as const,
      latencyMs: Date.now() - started,
      errorClass: 'auth_expired' as const,
      message: 'No Amazon Ads app credentials are configured (ChannelApp AMAZON_ADS)',
    }
  }
  let token: string
  try {
    token = await handle.token()
  } catch (err) {
    return {
      ok: false as const,
      latencyMs: Date.now() - started,
      errorClass: 'auth_expired' as const,
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const region = handle.region ?? 'EU'
  const result = await profilesForRegion(region, token, clientId)
  if (!result) {
    return { ok: false as const, latencyMs: Date.now() - started, errorClass: 'network' as const, message: `Amazon Ads ${region} did not answer` }
  }
  if (result.status !== 200) {
    const { classifyAuthError } = await import('../../catalog.js')
    return {
      ok: false as const,
      latencyMs: result.latencyMs,
      errorClass: classifyAuthError(result.status, ''),
      status: result.status,
      message: `GET /v2/profiles returned ${result.status}`,
    }
  }
  return { ok: true as const, latencyMs: result.latencyMs }
}

/**
 * Every profile the grant reaches, across ALL three regional hosts.
 *
 * The live callback discovers on `advertising-api-eu` only, so an NA or FE profile has
 * never been visible to this system. Sweeping all three means the account's reach is
 * measured rather than assumed — and a region with no profiles simply contributes none.
 */
async function discoverScopes(handle: ConnectionHandle): Promise<ScopeInput[]> {
  const clientId = await adsClientId()
  if (!clientId) return []
  const token = await handle.token()
  const out: ScopeInput[] = []
  for (const region of ADS_REGIONS) {
    const result = await profilesForRegion(region, token, clientId)
    if (!result || result.status !== 200) continue
    for (const p of result.profiles) {
      const account = p.accountInfo
      const market = p.countryCode ?? account?.marketplaceStringId ?? region
      out.push({
        kind: 'profile',
        externalId: String(p.profileId),
        label: `${account?.name ?? 'Ads profile'} · ${market}`,
        region,
        // Presence at the channel is what discovery measures. Whether WE write to it
        // is the operator's mode/writes decision, which lives in the scope metadata
        // the migration seeded and in the Ads write gate — never inferred here.
        isActive: true,
        metadata: {
          marketplace: market,
          marketplaceStringId: account?.marketplaceStringId,
          accountId: account?.id,
          // CX.3c — the profile's own name from Amazon, so `accountLabel` has a
          // source that is the channel's current answer rather than a column last
          // written at connect time.
          accountName: account?.name,
          accountType: account?.type,
          currencyCode: p.currencyCode,
          timezone: p.timezone,
        },
      })
    }
  }
  if (out.length === 0) logger.warn('[cx-ads] profile discovery found no profiles in any region')
  return out
}

export const amazonAdsSpec: ChannelSpec = {
  key: 'AMAZON_ADS',
  channelType: 'AMAZON_ADS',
  displayName: 'Amazon Ads',
  available: true,
  auth: {
    mode: 'oauth2_pkce',
    // P4.5c — one function decides the consent host, shared with the live route.
    // Unless NEXUS_ADS_CONSENT_REGIONAL=1 it answers the North American page for
    // every region, which is the page this account was actually granted through —
    // the regional hosts this file once guessed as a stub are not.
    authorizeUrl: (ctx) => adsConsentUrl(ctx.region),
    tokenUrl: () => 'https://api.amazon.com/auth/o2/token',
    authorizationParams: { response_type: 'code' },
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: true,
    // Exactly what the live flow asks for. Asking for more here would render as
    // permanent "scope drift" against a grant that is in fact complete.
    requiredScopes: ['profile', 'advertising::campaign_management'],
    reviewGatedScopes: [
      { scope: 'advertising::test:create_account', reason: 'Sandbox account creation — separate Amazon approval' },
      { scope: 'advertising::audiences', reason: 'Data Provider API needs separate approval' },
    ],
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 365 * 86_400,
    revokeHint: {
      url: 'https://www.amazon.com/ap/adam',
      label: 'Amazon account → Login with Amazon → Manage apps',
      detail: 'Amazon Ads grants are removed from the Amazon account that gave consent, not through an API.',
    },
    rotatesRefreshToken: false,
  },
  regions: [
    { key: 'EU', label: 'Europe', hosts: { api: ADS_REGION_HOSTS.EU } },
    { key: 'NA', label: 'North America', hosts: { api: ADS_REGION_HOSTS.NA } },
    { key: 'FE', label: 'Far East', hosts: { api: ADS_REGION_HOSTS.FE } },
  ],
  defaultRegion: 'EU',
  identity,
  heartbeat,
  discoverScopes,
  rateLimit: { parse: amazonAdsRateReading, model: 'token_bucket' },
  webhooks: { scheme: 'sqs', subscriptionApi: true, lifecycleTopics: [] },
  apiVersion: 'ads-v1 · reporting-v3',
  sandbox: { available: true },
  tokenExpirationBufferSec: 600,
}

registerChannel(amazonAdsSpec)
