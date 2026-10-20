/**
 * Meta — the catalogue entry (Meta ads M1, 2026-10-20).
 *
 * ONE Meta connection per business: the business's own Meta app (app id + app secret) and the token of a system user
 * of its business portfolio, entered by a person in Settings → Channels → Meta (connect.ts). There is no Facebook Login
 * screen in Nexus (research R3 §1, "Recommended auth design"): a system-user token is made in Meta Business settings
 * → System users → Generate token. Every Meta call goes through the gateway (`metaCall`), GET only in M1.
 *
 * - Lifetime: a system-user token either never expires or lasts 60 days (`set_token_expires_in_60_days`). Meta gives
 *   no refresh token: a 60-day token is renewed with itself (token.service.ts `renewMetaToken`) once 30 days are left
 *   (`tokenExpirationBufferSec`), the "refresh about every 30 days" of research R3 §3. A never-expiring token has no
 *   expiry date and is never renewed.
 * - Health: the heartbeat checks the token with `debug_token` (valid, which app, expiry, permissions) at most every
 *   CHECK_EVERY_MS — the daily check of the plan, a little more often — and keeps the answer, never the token, in
 *   `connectionMetadata.metaToken`.
 * - One system user may be connected in many businesses (migration 20261020e), each with its own row and token; every
 *   Meta ad account, Page and Instagram id is picked by ONE business (MetaAccountLink).
 * - Disconnect never revokes at Meta: the same system user may serve other businesses, and revoking is the Owner's in
 *   Meta Business settings (`revokeHint`).
 * - Discovery (ad accounts, Pages, Instagram accounts) at connect and on demand, never on the heartbeat.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../../db.js'
import { registerChannel, type ChannelSpec, type ConnectionHandle, type HeartbeatResult } from '../../catalog.js'
import { metaRateReading } from '../../rate-readings.js'
import { RefreshFailed, metaAppIdOf } from '../../token.service.js'
import { CredentialsDecryptError } from '../../../../lib/crypto.js'
import { metaCall, metaUrl } from '../../../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal } from '../../../gateway/gateway.js'
import { metaGraphApiVersion } from '../../../meta/api-version.js'
import { checkMetaToken, MetaTokenCheckError, type MetaTokenHealth } from './token-check.js'
import { discoverMetaChoices, metaScopeRows } from './discovery.js'
import { META_OPTIONAL_SCOPES, META_REQUIRED_SCOPES } from './scopes.js'

/** debug_token at most this often per connection (the plan's daily check; twice a day so a broken token shows sooner). */
export const CHECK_EVERY_MS = 12 * 3_600_000
/** A 60-day token is renewed once this much is left. */
export const META_RENEW_WITHIN_SEC = 30 * 86_400

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** The last token check kept on the connection, or null. */
export function storedTokenHealth(connectionMetadata: unknown): MetaTokenHealth | null {
  const health = record(connectionMetadata).metaToken
  return health && typeof health === 'object' ? health as MetaTokenHealth : null
}

/** Keep a token check on the connection (merged into its metadata; never the token). */
export async function saveTokenHealth(connectionId: string, health: MetaTokenHealth): Promise<void> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { connectionMetadata: true } })
  const metadata = { ...record(row?.connectionMetadata), metaToken: health }
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: { connectionMetadata: metadata as unknown as Prisma.InputJsonValue, grantedScopes: health.scopes },
  })
}

/**
 * The heartbeat: the token first (a renewal Meta refused keeps its own class), then debug_token when the last check is
 * older than CHECK_EVERY_MS. A token Meta calls invalid is a dead sign-in (needs a new token); a check that could not
 * be made is a network or rate problem, never a dead sign-in.
 */
async function heartbeat(handle: ConnectionHandle): Promise<HeartbeatResult> {
  const started = Date.now()
  const failed = (errorClass: Extract<HeartbeatResult, { ok: false }>['errorClass'], message: string, status?: number): HeartbeatResult =>
    ({ ok: false, latencyMs: Date.now() - started, errorClass, message, ...(status ? { status } : {}) })
  let token: string
  try {
    token = await handle.token()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof RefreshFailed) return failed(err.errorClass, message)
    if (err instanceof CredentialsDecryptError) return failed('configuration', 'Nexus cannot read the stored Meta credentials. An Owner checks the server encryption configuration.')
    return failed(/needs_reauth|revoked|disconnected|no credentials/i.test(message) ? 'auth_expired' : 'network', message)
  }
  const row = await prisma.channelConnection.findUnique({ where: { id: handle.id }, select: { connectionMetadata: true } })
  const kept = storedTokenHealth(row?.connectionMetadata)
  if (kept?.isValid && Date.now() - Date.parse(kept.checkedAt) < CHECK_EVERY_MS && (!kept.expiresAt || Date.parse(kept.expiresAt) > Date.now())) {
    return { ok: true, latencyMs: Date.now() - started, scopes: kept.scopes, ...(kept.userId ? { identity: { userId: kept.userId } } : {}) }
  }
  let health: MetaTokenHealth
  try {
    health = await checkMetaToken({ token, connectionId: handle.id, expectedAppId: await metaAppIdOf(handle.id) })
  } catch (err) {
    if (err instanceof MetaTokenCheckError) {
      if (err.reason === 'no_answer') return failed('network', err.message)
      if (err.reason === 'refused') return failed(/RATE_LIMITED/.test(err.message) ? 'rate_limited' : 'unknown', err.message)
      // Meta refused the APP token: the app id or secret entered for this business is wrong — setup, not the token.
      return failed('configuration', `${err.message} Check the Meta app id and secret in Settings → Channels → Meta.`)
    }
    if (err instanceof GatewayRefusal) return failed(err.outcome === 'held' ? 'auth_expired' : 'unknown', err.message)
    if (err instanceof GatewayNoAnswer) return failed('network', err.message)
    return failed('unknown', err instanceof Error ? err.message : String(err))
  }
  await saveTokenHealth(handle.id, health)
  if (!health.isValid) {
    return failed(health.appMatches ? 'auth_revoked' : 'identity_mismatch', `${health.problem ?? 'Meta says the token is not valid.'} Make a new system-user token in Meta Business settings and enter it in Settings → Channels → Meta.`)
  }
  return { ok: true, latencyMs: Date.now() - started, scopes: health.scopes, ...(health.userId ? { identity: { userId: health.userId } } : {}) }
}

/** Who the token acts as (`GET /me`), through the gateway, for a connection that already holds it. */
async function identity(handle: ConnectionHandle) {
  const answer = await metaCall({ connectionId: handle.id, operation: 'identity.me', path: 'me', query: { fields: 'id,name' }, timeoutMs: 20_000 })
  const body = answer.ok ? answer.json<{ id?: unknown; name?: unknown }>() : null
  return body?.id ? { userId: String(body.id), ...(typeof body.name === 'string' ? { username: body.name } : {}) } : null
}

export const metaSpec: ChannelSpec = {
  key: 'META',
  channelType: 'META',
  displayName: 'Meta',
  available: true,
  auth: {
    // No consent screen: the business's system-user token is entered by a person (connect.ts).
    mode: 'api_key',
    identityRequired: true,
    tokenUrl: () => metaUrl('oauth/access_token'),
    tokenRequestAuth: 'body',
    scopeSeparator: ',',
    codeParamInCallback: 'code',
    pkce: false,
    requiredScopes: META_REQUIRED_SCOPES,
    optionalScopes: META_OPTIONAL_SCOPES,
    // A never-expiring token has no date; a 60-day one carries its own (from debug_token / the renewal answer).
    accessTokenLifetimeSec: null,
    refreshTokenLifetimeSec: null,
    refreshTokenRequired: false,
    rotatesRefreshToken: false,
    revokeHint: {
      url: 'https://business.facebook.com/settings/system-users',
      label: 'Meta Business settings → Users → System users',
      detail: 'Nexus does not end the token at Meta, because the same system user may serve your other businesses. To end it, open the system user in Meta Business settings and revoke its token, or remove the app from it.',
    },
  },
  identity,
  heartbeat,
  discoverScopes: async (handle) => metaScopeRows(await discoverMetaChoices(handle.id)),
  discoverOnHeartbeat: false,
  rateLimit: { parse: metaRateReading, model: 'points' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: metaGraphApiVersion(),
  sandbox: { available: false },
  connectException: {
    reason: 'Meta is connected with a system-user token of your business portfolio and your own Meta app (app id and secret), entered in Nexus; there is no Facebook sign-in page.',
    deepLink: 'https://business.facebook.com/settings/system-users',
  },
  tokenExpirationBufferSec: META_RENEW_WITHIN_SEC,
}

registerChannel(metaSpec)
