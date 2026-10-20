/**
 * Meta (M1, 2026-10-20) — connect Meta for ONE business, or replace its credentials, with what a person enters in
 * Settings → Channels → Meta: the business's Meta app id, its app secret and a system-user token. No Facebook Login.
 *
 * In order, before anything is stored (every Meta call through the gateway, GET only):
 *   1. the three values have Meta's shape (app id digits; app secret hex; a token with no spaces);
 *   2. `debug_token`, asked with the app's own app token: the token is valid, belongs to THIS app, and carries
 *      `ads_read` or `ads_management` (reading needs one of them); a type Meta names that is plainly not a system
 *      user's (PAGE, APP) is refused — `type` is not on Meta's v26 reference, so any other value, or none, is kept
 *      as Meta said it and shown;
 *   3. `GET /me` with the token: the system user it acts as (its id is the connection's identity). That debug_token's
 *      user_id and /me's id are the same for a system user is not on a Meta page: both are kept, and a difference is
 *      a warning, never a refusal. Replacing credentials keeps the same system user (identity.service, by /me's id);
 *   4. the grant is placed like an OAuth grant (identity.service placeGrant: this business's own row for this system
 *      user, or a new row; one system user may be connected in many businesses, each with its own row and token) and
 *      stored by the token service — the token, the app id and the app secret sealed together in
 *      ChannelConnection.credentialsEnc (KMS envelope), never returned and never logged;
 *   5. the token check is kept on the connection (`connectionMetadata.metaToken`, no token in it) and the ad accounts,
 *      Pages and Instagram accounts the system user sees become the connection's scope rows.
 * The answer names the connection, the system user, the token's expiry and the permissions it lacks. A refusal is a
 * MetaConnectError with a plain sentence; nothing is changed by a refused connect.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../../db.js'
import { inDatabaseTransaction } from '../../../../lib/database-context.js'
import { workspaceKey } from '../../../../lib/workspace-context.js'
import { logger } from '../../../../utils/logger.js'
import { metaCall } from '../../../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../../../gateway/gateway.js'
import { recordConnectionEvent, type Actor } from '../../events.service.js'
import { IdentityRefusal, placeGrant } from '../../identity.service.js'
import { handleOf, metaAppIdOf, storeGrant, type GrantResult } from '../../token.service.js'
import { checkMetaToken, MetaTokenCheckError, REFUSED_TOKEN_TYPES, tokenTypeText, type MetaTokenHealth } from './token-check.js'
import { saveTokenHealth } from './spec.js'
import { discoverMetaChoices, metaScopeRows } from './discovery.js'
import { META_SCOPE } from './scopes.js'

export class MetaConnectError extends Error {
  constructor(
    readonly code: 'invalid_app_id' | 'invalid_app_secret' | 'invalid_token' | 'token_refused' | 'wrong_app' | 'not_system_user'
      | 'missing_permission' | 'meta_unreachable' | 'already_connected' | 'not_found',
    message: string,
    readonly statusCode = 400,
  ) {
    super(message)
    this.name = 'MetaConnectError'
  }
}

export interface MetaConnectResult {
  connectionId: string
  placement: 'new' | 'reconsent' | 'adopt'
  systemUser: { id: string; name: string | null }
  token: MetaTokenHealth
  adAccountsSeen: number
  /** Things a person should know that did not stop the connect (a token type that is not SYSTEM_USER, two user ids). */
  warnings: string[]
}

const APP_ID = /^\d{5,25}$/
const APP_SECRET = /^[A-Fa-f0-9]{16,128}$/
const TOKEN = /^[A-Za-z0-9._|-]{20,2048}$/

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The values as entered, checked for Meta's shape (the words never repeat a secret). */
export function parseMetaCredentials(body: unknown): { appId: string; appSecret: string; token: string } {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const appId = trimmed(input.appId)
  const appSecret = trimmed(input.appSecret)
  const token = trimmed(input.systemUserToken ?? input.token)
  if (!APP_ID.test(appId)) throw new MetaConnectError('invalid_app_id', 'Paste the App ID of your Meta app (digits only), from developers.facebook.com → your app → App settings → Basic.')
  if (!APP_SECRET.test(appSecret)) throw new MetaConnectError('invalid_app_secret', 'Paste the App secret of the same Meta app (letters a–f and digits, no spaces), from App settings → Basic → App secret.')
  if (!TOKEN.test(token)) throw new MetaConnectError('invalid_token', 'Paste the system-user token exactly as Meta showed it (Meta Business settings → System users → Generate token), with no spaces.')
  return { appId, appSecret, token }
}

/** Who the token acts as, asked with the token and app secret the person entered (no connection holds them yet). */
async function systemUserOf(token: string, appSecret: string): Promise<{ id: string; name: string | null }> {
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId: null, operation: 'identity.me', path: 'me', query: { fields: 'id,name' }, auth: { token, appSecret }, timeoutMs: 20_000 })
  } catch (err) {
    if (err instanceof GatewayRefusal || err instanceof GatewayNoAnswer) throw new MetaConnectError('meta_unreachable', `Nexus could not ask Meta who the token belongs to (${err.message}).`, 502)
    throw err
  }
  const body = answer.ok ? answer.json<{ id?: unknown; name?: unknown }>() : null
  if (!body?.id) {
    throw new MetaConnectError('token_refused', `Meta did not say who the token belongs to${answer.verdict?.channelMessage ? `: ${answer.verdict.channelMessage}` : '.'}`, 409)
  }
  return { id: String(body.id), name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null }
}

/**
 * Connect Meta for the business the request works in, or replace the credentials of its connection
 * (`targetConnectionId`). Idempotent for the same values: a second save re-checks and stores the same grant.
 */
export async function connectMeta(input: { body: unknown; targetConnectionId?: string | null; actor: Actor }): Promise<MetaConnectResult> {
  const { appId, appSecret, token } = parseMetaCredentials(input.body)

  // 2 — debug_token with the app's own token.
  let health: MetaTokenHealth
  try {
    health = await checkMetaToken({ token, app: { appId, appSecret } })
  } catch (err) {
    if (err instanceof MetaTokenCheckError) {
      if (err.reason === 'meta_error') throw new MetaConnectError('wrong_app', `${err.message} Check that the App ID and App secret are those of the Meta app the token was made for.`, 409)
      throw new MetaConnectError('meta_unreachable', `Nexus could not check the token with Meta (${err.message}). Nothing was saved.`, 502)
    }
    throw err
  }
  if (!health.appMatches) throw new MetaConnectError('wrong_app', 'This token was made for another Meta app than the App ID entered. Make the token for this app, or enter that app\'s id and secret.', 409)
  if (!health.isValid) throw new MetaConnectError('token_refused', `${health.problem ?? 'Meta says the token is not valid.'} Make a new system-user token and paste it again.`, 409)
  if (health.type && REFUSED_TOKEN_TYPES.has(health.type)) {
    throw new MetaConnectError('not_system_user', `This is a ${health.type.toLowerCase().replace(/_/g, ' ')} token. Nexus takes a system-user token: Meta Business settings → Users → System users → choose the system user → Generate token.`, 409)
  }
  if (!health.scopes.includes(META_SCOPE.ads_read) && !health.scopes.includes(META_SCOPE.ads_management)) {
    throw new MetaConnectError('missing_permission', 'The token carries neither ads_read nor ads_management, so Nexus cannot read your ads. Generate the token again and tick ads_read.', 409)
  }
  const warnings: string[] = []
  if (health.type !== 'SYSTEM_USER') warnings.push(`${tokenTypeText(health.type)}.`)

  // 3 — the system user the token acts as.
  const systemUser = await systemUserOf(token, appSecret)
  if (health.userId && health.userId !== systemUser.id) {
    warnings.push('Meta named one user in the token check and another for the token itself; Nexus keeps the token\'s own (/me).')
  }

  // 4 — place and store the grant (the token service seals token + app id + app secret together).
  const previousAppId = input.targetConnectionId ? await metaAppIdOf(input.targetConnectionId) : null
  const grant: GrantResult = {
    accessToken: token,
    refreshToken: null,
    expiresInSec: health.expiresAt ? Math.max(1, Math.floor((Date.parse(health.expiresAt) - Date.now()) / 1000)) : null,
    grantedScopes: health.scopes,
    identity: { userId: systemUser.id, ...(systemUser.name ? { username: systemUser.name } : {}) },
    region: null,
    tokenResponseMetadata: { metaApp: { appId, appSecret }, tokenType: health.type, debugUserId: health.userId, authorizationMode: 'system_user_token' },
  }
  let placed: { connectionId: string; placement: 'new' | 'reconsent' | 'adopt' }
  try {
    placed = await inDatabaseTransaction(prisma, async () => {
      const placement = await placeGrant({ channelType: 'META', channelLabel: 'Meta', identity: grant.identity, targetConnectionId: input.targetConnectionId ?? null, region: null })
      let connectionId: string
      let event: 'grant' | 'reconsent' | 'adopt'
      if (placement.kind === 'new') {
        const created = await prisma.channelConnection.create({
          data: { channelType: 'META', managedBy: 'oauth', isActive: false, authStatus: 'unknown', connectionMetadata: { environment: 'production' } },
          select: { id: true },
        })
        connectionId = created.id
        event = 'grant'
      } else {
        connectionId = placement.connectionId
        event = placement.kind
      }
      await storeGrant(connectionId, grant, input.actor, event)
      return { connectionId, placement: placement.kind }
    })
  } catch (err) {
    if (err instanceof IdentityRefusal) throw new MetaConnectError('already_connected', err.message, 409)
    if ((err as { code?: string }).code === 'P2002') throw new MetaConnectError('already_connected', 'This Meta system user is already connected in this business. Use Replace on its card to enter new credentials.', 409)
    throw err
  }
  const { connectionId, placement } = placed

  // 5 — what Nexus keeps of the check, and what the system user sees.
  await saveTokenHealth(connectionId, health)
  await recordConnectionEvent({
    connectionId, channelKey: 'META', type: 'app_credentials_set', actor: input.actor,
    detail: { appId, appIdChanged: previousAppId !== null && previousAppId !== appId, first: placement === 'new', tokenExpiresAt: health.expiresAt, neverExpires: health.neverExpires },
  })
  let adAccountsSeen = 0
  try {
    const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
    if (row) {
      const choices = await discoverMetaChoices(handleOf(row).id)
      adAccountsSeen = choices.adAccounts.items.length
      for (const s of metaScopeRows(choices)) {
        await prisma.connectionScope.upsert({
          where: { connectionId_kind_externalId: workspaceKey({ connectionId, kind: s.kind, externalId: s.externalId }) },
          create: { connectionId, kind: s.kind, externalId: s.externalId, label: s.label ?? null, region: null, isActive: s.isActive ?? true, metadata: (s.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
          update: { label: s.label ?? null, isActive: s.isActive ?? true, metadata: (s.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
        })
      }
    }
  } catch (err) {
    logger.warn('[meta-connect] discovery failed (grant stored)', { connectionId, error: err instanceof Error ? err.message : String(err) })
  }
  // Review A2 — a read that lost the old token no longer stands: cleared, and read again at once.
  if (health.isValid) await (await import('../../../marketing/meta-ads/enqueue.js')).metaReadAfterGoodToken(connectionId)
  return { connectionId, placement, systemUser, token: health, adAccountsSeen, warnings }
}

/**
 * Ask Meta about this connection's token now (debug_token), keep the answer, and say it — the "Check now" of the
 * Settings card and of meta-connection. A token Meta calls invalid moves the connection to needs_reauth through the
 * heartbeat's own state machine the next time it runs; this only reads and keeps.
 */
export async function recheckMetaToken(connectionId: string): Promise<MetaTokenHealth> {
  const row = await prisma.channelConnection.findFirst({ where: { id: connectionId, channelType: 'META' }, select: { id: true } })
  if (!row) throw new MetaConnectError('not_found', 'This Meta connection is not connected to this business.', 404)
  const { getAccessToken } = await import('../../token.service.js')
  let token: string
  try {
    token = await getAccessToken(connectionId)
  } catch (err) {
    throw new MetaConnectError('token_refused', `Nexus cannot use this connection's token (${err instanceof Error ? err.message : String(err)}). Enter a new system-user token.`, 409)
  }
  let health: MetaTokenHealth
  try {
    health = await checkMetaToken({ token, connectionId, expectedAppId: await metaAppIdOf(connectionId) })
  } catch (err) {
    if (err instanceof MetaTokenCheckError) throw new MetaConnectError(err.reason === 'meta_error' ? 'wrong_app' : 'meta_unreachable', err.message, err.reason === 'meta_error' ? 409 : 502)
    throw err
  }
  await saveTokenHealth(connectionId, health)
  // Review A2 — a valid token now: a read that lost the token no longer stands (cleared, read again at once).
  if (health.isValid) await (await import('../../../marketing/meta-ads/enqueue.js')).metaReadAfterGoodToken(connectionId)
  return health
}
