/**
 * Google — the catalogue entry (2026-10-13, Google Ads step 1).
 *
 * ONE Google sign-in per business covers Google Ads, Merchant Center and Google Analytics (read-only):
 * one connection (`channelType` GOOGLE), its reachable accounts as `ConnectionScope` rows, and the
 * business's picks in `GoogleAccountLink` (they survive a reconnect).
 *
 * - Consent at accounts.google.com with `access_type=offline` + `prompt=consent`: Google hands out a
 *   refresh token only on a consent, and a reconnect must get a new one. PKCE (S256) on top of the secret.
 * - Who consented comes from the `id_token` in the token answer (id-token.ts), so no call is needed at
 *   connect; the heartbeat asks Google's userinfo through the gateway.
 * - Discovery (discovery.ts) runs at connect and on demand, never on the heartbeat (Ads quota is scarce).
 * - Every Google call goes through the gateway (`googleCall`), which refuses any Google change in step 1.
 * - Refresh tokens do not rotate. An app in Google's "Testing" state gets refresh tokens that die after 7
 *   days; Google then says so in `refresh_token_expires_in`, which the token service records.
 */
import { classifyAuthError, registerChannel, type ChannelSpec, type ConnectionHandle, type HeartbeatResult } from '../../catalog.js'
import { googleRateReading } from '../../rate-readings.js'
import { RefreshFailed } from '../../token.service.js'
import { ChannelAppConfigurationError } from '../../app-configuration-error.js'
import { CredentialsDecryptError } from '../../../../lib/crypto.js'
import { googleCall } from '../../../gateway/google.js'
import { GatewayNoAnswer, GatewayRefusal } from '../../../gateway/gateway.js'
import { GOOGLE_ADS_API_VERSION } from '../../../google/api-version.js'
import { identityFromGoogleIdToken } from './id-token.js'
import { discoverGoogleScopes } from './discovery.js'
import { GOOGLE_REQUIRED_SCOPES } from './scopes.js'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

/** The heartbeat: Google's userinfo (who this token belongs to), through the gateway. One cheap call. */
async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  const failed = (errorClass: Extract<HeartbeatResult, { ok: false }>['errorClass'], message: string, status?: number): HeartbeatResult =>
    ({ ok: false, latencyMs: Date.now() - started, errorClass, message, ...(status ? { status } : {}) })
  // The token first, so a refresh Google refused keeps its own class (revoked vs unreachable).
  try {
    await handle.token()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof RefreshFailed) return failed(err.errorClass, message)
    // Our side, not the person's sign-in: the Google client is not set, or the server cannot read it.
    if (err instanceof ChannelAppConfigurationError || err instanceof CredentialsDecryptError) {
      return failed('configuration', 'Nexus cannot use its Google sign-in app. An Owner checks the Google client in Settings → Channels → Diagnostics → App secrets.')
    }
    return failed(/needs_reauth|revoked|disconnected|no credentials/i.test(message) ? 'auth_expired' : 'network', message)
  }
  try {
    const res = await googleCall({ connectionId: handle.id, operation: 'identity.userinfo', method: 'GET', url: GOOGLE_USERINFO_URL, timeoutMs: 20_000 })
    const body = await res.text()
    if (!res.ok) return failed(classifyAuthError(res.status, body), `Google account check ${res.status}`, res.status)
    let info: { sub?: unknown; email?: unknown } | null = null
    try { info = JSON.parse(body) } catch { info = null }
    if (typeof info?.sub !== 'string' || !info.sub) return failed('unknown', 'Google answered the account check without an account id.')
    return {
      ok: true,
      latencyMs: Date.now() - started,
      identity: { userId: info.sub, username: typeof info.email === 'string' ? info.email : undefined },
    }
  } catch (err) {
    if (err instanceof GatewayRefusal) {
      if (err.outcome === 'held') return failed('auth_expired', err.message)
      return failed(err.code === 'RATE_LIMITED_LOCAL' ? 'rate_limited' : 'unknown', err.message)
    }
    if (err instanceof GatewayNoAnswer) return failed('network', err.message)
    return failed('unknown', err instanceof Error ? err.message : String(err))
  }
}

export const googleSpec: ChannelSpec = {
  key: 'GOOGLE',
  channelType: 'GOOGLE',
  displayName: 'Google',
  available: true,
  auth: {
    mode: 'oauth2_pkce',
    identityRequired: true,
    identityFromTokenResponse: (token, ctx) => identityFromGoogleIdToken(token.id_token, { clientId: ctx.clientId }),
    authorizeUrl: () => GOOGLE_AUTHORIZE_URL,
    tokenUrl: () => GOOGLE_TOKEN_URL,
    authorizationParams: { response_type: 'code', access_type: 'offline', prompt: 'consent' },
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: true,
    requiredScopes: GOOGLE_REQUIRED_SCOPES,
    accessTokenLifetimeSec: 3600,
    // Google's refresh tokens do not expire by date (an app in "Testing" is the exception, and Google
    // then names the lifetime in the token answer).
    refreshTokenLifetimeSec: null,
    refreshTokenRequired: true,
    rotatesRefreshToken: false,
    revokeUrl: () => GOOGLE_REVOKE_URL,
  },
  identity: async () => null, // the id_token is the identity; with none, the grant is refused (identityRequired)
  heartbeat,
  discoverScopes: discoverGoogleScopes,
  discoverOnHeartbeat: false,
  rateLimit: { parse: googleRateReading, model: 'token_bucket' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: GOOGLE_ADS_API_VERSION,
  sandbox: { available: false },
}

registerChannel(googleSpec)
