import { workspaceKey, workspaceContext, withWorkspace, LEGACY_WORKSPACE_ID, WorkspaceError } from '@nexus/database/workspace-context'
import { createWorkspaceService } from '../workspace.service.js'
/**
 * CX.1 — the OAuth service (docs/2026-08-29-cx1-connection-core.md §5).
 *
 * `start()` mints an OAuthSession row whose id IS the `state` we send to the
 * channel: single use, 10-minute TTL, bound to the user who started it and to a
 * double-submit cookie nonce, holding the PKCE verifier server-side. `complete()`
 * consumes the session in one UPDATE (replay-proof), exchanges the code with the
 * catalogue's parameters, records the granted scopes, asks the channel who
 * consented, applies the MAP placement rules and stores the grant through the
 * token service. Every outcome is a ledger row.
 *
 * Nothing here is eBay-specific: the catalogue entry decides URLs, params,
 * PKCE, the code parameter name and which callback/token fields to keep.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { logger } from '../../utils/logger.js'
import { getChannelApp, type Environment } from './apps.service.js'
import { ChannelAppConfigurationError } from './app-configuration-error.js'
import { CredentialsDecryptError } from '../../lib/crypto.js'
import { getChannelSpec, scopeDriftOf, type ChannelKey, type ConnectionIdentity } from './catalog.js'
import { recordConnectionEvent, type Actor } from './events.service.js'
import { IdentityRefusal, placeGrant } from './identity.service.js'
import { handleOf, storeGrant, type GrantResult } from './token.service.js'
import { shopifyShopDomain, verifyShopifyCallbackHmac } from './connectors/shopify/auth.js'
import { parseTokenResponse, tokenLifetime, TOKEN_REQUEST_TIMEOUT_MS } from './token-response.js'

export const SESSION_TTL_MS = 10 * 60 * 1000
export const COOKIE_PREFIX = 'nexus_oauth_'

export type Intent = 'connect' | 'reconnect' | 'adopt'

export class OAuthFlowError extends Error {
  constructor(
    readonly code:
      | 'unknown_channel'
      | 'channel_unavailable'
      | 'invalid_intent'
      | 'state_missing'
      | 'state_unknown'
      | 'state_expired'
      | 'state_consumed'
      | 'state_cookie_missing'
      | 'state_cookie_mismatch'
      | 'code_missing'
      | 'provider_error'
      | 'exchange_failed'
      | 'identity_refused',
    message: string,
    readonly status = 400,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function apiBaseUrl(): string {
  return (process.env.NEXUS_PUBLIC_API_URL ?? process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '')
}

/** The callback URL registered with the channel — the API host, never the web page. */
export function callbackUrlFor(channelKey: ChannelKey): string {
  return `${apiBaseUrl()}/api/cx/callback/${channelKey.toLowerCase()}`
}

/** Shared by the read-only setup check and start; never creates an OAuth session. */
async function oauthConfiguration(channelKey: ChannelKey, environment: Environment) {
  const spec = getChannelSpec(channelKey)
  if (!spec.available) throw new OAuthFlowError('channel_unavailable', `${spec.displayName} connect is not available yet.`)
  if (!spec.auth.authorizeUrl) throw new OAuthFlowError('invalid_intent', `${spec.displayName} does not use a browser consent flow.`)
  if (environment === 'sandbox' && !spec.sandbox?.available) {
    throw new OAuthFlowError('invalid_intent', `${spec.displayName} does not provide a sandbox sign-in.`)
  }
  let app
  try {
    app = await getChannelApp(channelKey, environment)
  } catch (err) {
    if (err instanceof ChannelAppConfigurationError) {
      throw new OAuthFlowError('channel_unavailable', `${spec.displayName} is not set up on this Nexus server. Ask your Nexus administrator to configure the app credentials before connecting an account.`, 503)
    }
    if (err instanceof CredentialsDecryptError) {
      throw new OAuthFlowError('channel_unavailable', `Nexus cannot read the ${spec.displayName} app credentials. Ask your Nexus administrator to check the server encryption configuration.`, 503)
    }
    throw err
  }
  if ((channelKey === 'SHOPIFY' || channelKey === 'ETSY') && (!app.clientId.trim() || !app.clientSecret.trim())) {
    throw new OAuthFlowError('channel_unavailable', `${spec.displayName} setup is incomplete on this Nexus server. Ask your Nexus administrator to configure both the app key and secret.`, 503)
  }
  const amazonApplicationId = channelKey === 'AMAZON_SP' && typeof app.extra.applicationId === 'string' ? app.extra.applicationId.trim() : ''
  if (channelKey === 'AMAZON_SP' && !amazonApplicationId) {
    throw new OAuthFlowError('channel_unavailable', 'Configure the Amazon application ID before connecting sellers.', 503)
  }
  // eBay uses its RuName; other channels use the provider-registered callback URL.
  const redirectUri = app.redirectUris[0] ?? callbackUrlFor(channelKey)
  let localCallback = false
  if (channelKey === 'SHOPIFY' || channelKey === 'ETSY') {
    const message = `${spec.displayName} needs a secure return address for sign-in. Ask your Nexus administrator to configure and register the public HTTPS callback URL.`
    let callback: URL
    try { callback = new URL(redirectUri) } catch { throw new OAuthFlowError('channel_unavailable', message, 503) }
    // Shopify supports a loopback callback for standalone local development.
    // Explicit opt-in, development only, and limited to this exact callback route.
    localCallback = channelKey === 'SHOPIFY'
      && process.env.NODE_ENV === 'development'
      && process.env.NEXUS_SHOPIFY_LOCAL_OAUTH === '1'
      && callback.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
      && callback.pathname === '/api/cx/callback/shopify'
      && !callback.search
    if ((!localCallback && callback.protocol !== 'https:') || callback.username || callback.password || callback.hash) {
      throw new OAuthFlowError('channel_unavailable', message, 503)
    }
  }
  return { app, redirectUri, amazonApplicationId, localCallback }
}

/** Reports server setup only; provider acceptance still requires actual consent. */
export async function connectionReadiness(channelKey: ChannelKey): Promise<{ ready: true } | { ready: false; code: string; error: string }> {
  try {
    await oauthConfiguration(channelKey, 'production')
    return { ready: true }
  } catch (err) {
    if (err instanceof OAuthFlowError) return { ready: false, code: err.code, error: err.message }
    throw err
  }
}

export interface StartResult {
  authorizeUrl: string
  state: string
  cookie: { name: string; value: string; maxAgeSec: number; secure?: boolean }
  expiresInSec: number
}

export async function start(input: {
  channelKey: ChannelKey
  intent: Intent
  targetConnectionId?: string | null
  region?: string | null
  environment?: Environment
  actor: Actor
}): Promise<StartResult> {
  const scope = workspaceContext()
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1' && (!scope || !input.actor.userId || scope.actorUserId !== input.actor.userId)) {
    throw new WorkspaceError('workspace_required', 'Select a business profile before connecting an account.', 400)
  }
  const spec = getChannelSpec(input.channelKey)
  if (!spec.available) throw new OAuthFlowError('channel_unavailable', `${spec.displayName} connect is not available yet.`)
  if (!spec.auth.authorizeUrl) throw new OAuthFlowError('invalid_intent', `${spec.displayName} does not use a browser consent flow.`)
  if ((input.intent === 'adopt' || input.intent === 'reconnect') && !input.targetConnectionId) {
    throw new OAuthFlowError('invalid_intent', 'reconnect/adopt needs the connection to reconnect.')
  }
  if (input.targetConnectionId) {
    const target = await prisma.channelConnection.findUnique({ where: { id: input.targetConnectionId }, select: { channelType: true, managedBy: true } })
    if (!target || target.channelType !== spec.channelType || target.managedBy === 'transferred') {
      throw new OAuthFlowError('invalid_intent', 'The account to reconnect does not belong to this channel.')
    }
  }

  const environment = input.environment ?? 'production'
  const { app, redirectUri, amazonApplicationId, localCallback } = await oauthConfiguration(input.channelKey, environment)
  const state = b64url(randomBytes(32))
  const cookieNonce = b64url(randomBytes(24))
  const codeVerifier = spec.auth.pkce ? b64url(randomBytes(48)) : null
  const requestedRegion = input.region ?? spec.defaultRegion ?? null
  const region = input.channelKey === 'SHOPIFY' ? shopifyShopDomain(requestedRegion) : requestedRegion
  if (input.channelKey === 'SHOPIFY' && !region) {
    throw new OAuthFlowError('invalid_intent', 'Enter the store’s permanent domain, for example your-store.myshopify.com.')
  }
  if (input.channelKey !== 'SHOPIFY' && region && spec.regions?.length && !spec.regions.some((candidate) => candidate.key === region)) {
    throw new OAuthFlowError('invalid_intent', `Choose a supported ${spec.displayName} region.`)
  }
  await prisma.oAuthSession.create({
    data: {
      id: state,
      channelKey: input.channelKey,
      intent: input.intent,
      targetConnectionId: input.targetConnectionId ?? null,
      startedByUserId: input.actor.userId ?? null,
      workspaceId: scope?.workspaceId ?? LEGACY_WORKSPACE_ID,
      codeVerifier,
      redirectUri,
      cookieNonce,
      region,
      environment,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })

  const approvedScopes = new Set(Array.isArray(app.extra.approvedScopes) ? app.extra.approvedScopes.filter((scope): scope is string => typeof scope === 'string') : [])
  const requestedScopes = input.channelKey === 'SHOPIFY'
    ? [...new Set([...spec.auth.requiredScopes, ...(spec.auth.reviewGatedScopes ?? []).filter(({ scope }) => approvedScopes.has(scope)).map(({ scope }) => scope)])]
    : spec.auth.requiredScopes
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    scope: requestedScopes.join(spec.auth.scopeSeparator),
    state,
    ...(spec.auth.authorizationParams ?? {}),
    ...(spec.auth.promptParam ?? {}),
  })
  if (input.channelKey === 'AMAZON_SP') {
    params.delete('client_id')
    params.delete('redirect_uri')
    params.delete('scope')
    params.set('application_id', amazonApplicationId)
    if (app.extra.authorizationVersion === 'beta') params.set('version', 'beta')
  }
  if (codeVerifier) {
    params.set('code_challenge', b64url(createHash('sha256').update(codeVerifier).digest()))
    params.set('code_challenge_method', 'S256')
  }
  const authorizeUrl = `${spec.auth.authorizeUrl({ region, environment })}?${params.toString()}`

  logger.info('[cx-oauth] session started', { channelKey: input.channelKey, intent: input.intent, statePrefix: state.slice(0, 8) })
  return {
    authorizeUrl,
    state,
    cookie: { name: `${COOKIE_PREFIX}${state}`, value: cookieNonce, maxAgeSec: SESSION_TTL_MS / 1000, ...(localCallback ? { secure: false } : {}) },
    expiresInSec: SESSION_TTL_MS / 1000,
  }
}

export interface CompleteResult {
  workspaceId: string
  connectionId: string
  placement: 'new' | 'reconsent' | 'adopt'
  identity: ConnectionIdentity | null
  grantedScopes: string[]
  scopeDrift: string[]
  channelKey: ChannelKey
}

export async function complete(input: {
  channelKey: ChannelKey
  query: Record<string, string | undefined>
  cookies: Record<string, string | undefined>
  actorUserId?: string | null
}): Promise<CompleteResult> {
  const spec = getChannelSpec(input.channelKey)
  const state = input.query.state
  if (!state) throw new OAuthFlowError('state_missing', 'The sign-in did not return a state parameter. Start the connection again.')

  const session = await prisma.oAuthSession.findUnique({ where: { id: state } })
  if (!session || session.channelKey !== input.channelKey) {
    throw new OAuthFlowError('state_unknown', 'The sign-in could not be verified as coming from Nexus. Start the connection again.')
  }
  if (session.consumedAt) {
    throw new OAuthFlowError('state_consumed', 'This sign-in was already completed. Start the connection again if you need a new one.')
  }
  const fail = async (code: OAuthFlowError['code'], message: string, status = 400, detail?: Record<string, unknown>) => {
    await prisma.oAuthSession.update({ where: { id: state }, data: { error: `${code}: ${message}`.slice(0, 500) } }).catch(() => undefined)
    return new OAuthFlowError(code, message, status, detail)
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw await fail('state_expired', 'This sign-in took too long and the request expired. Start the connection again.')
  }

  // Double-submit cookie: the browser that started the flow must be the one finishing it.
  const cookie = input.cookies[`${COOKIE_PREFIX}${state}`]
  const enforce = process.env.NEXUS_OAUTH_COOKIE_ENFORCE !== '0'
  if (!cookie) {
    if (enforce || process.env.NEXUS_WORKSPACES_ENABLED === '1') throw await fail('state_cookie_missing', 'This sign-in did not come back to the browser that started it. Start the connection again.')
  } else if (cookie !== session.cookieNonce) {
    throw await fail('state_cookie_mismatch', 'This sign-in did not come back to the browser that started it. Start the connection again.')
  }
  if (input.channelKey === 'SHOPIFY') {
    const callbackShop = shopifyShopDomain(input.query.shop)
    if (!callbackShop || callbackShop !== session.region) {
      throw await fail('provider_error', 'Shopify returned a different or invalid store domain. Start the connection again.', 403)
    }
    const app = await getChannelApp(input.channelKey, session.environment === 'sandbox' ? 'sandbox' : 'production')
    if (!verifyShopifyCallbackHmac(input.query, app.clientSecret)) {
      throw await fail('provider_error', 'Shopify’s callback signature could not be verified. Start the connection again.', 403)
    }
  }
  const consumed = await prisma.oAuthSession.updateMany({ where: { id: state, channelKey: input.channelKey, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } })
  if (consumed.count !== 1) throw await fail('state_consumed', 'This sign-in was already completed or expired. Start the connection again.')

  if (input.query.error) {
    const description = input.query.error_description ?? input.query.error
    throw await fail('provider_error', `${spec.displayName} declined the authorisation: ${description}`, 400, {
      providerError: input.query.error,
      providerDescription: input.query.error_description ?? null,
    })
  }
  const code = input.query[spec.auth.codeParamInCallback]
  if (!code) throw await fail('code_missing', `${spec.displayName} did not return an authorization code.`)

  // The initiating membership owns the callback. A later tab selection never changes it.
  if (input.actorUserId && input.actorUserId !== session.startedByUserId) throw await fail('identity_refused', 'Finish this connection with the login that started it.', 403)
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1' && (!session.workspaceId || !session.startedByUserId)) throw await fail('state_expired', 'Start this connection again from its business profile.')
  const access = (process.env.NEXUS_WORKSPACES_ENABLED === '1' || workspaceContext()) && session.workspaceId && session.startedByUserId
    ? await createWorkspaceService(prisma).membership(session.startedByUserId, session.workspaceId)
    : undefined
  if (access && !access.isOwner && !access.permissions.has('channels.connect')) throw await fail('identity_refused', 'Your permission to connect accounts has changed.', 403)
  const scope = access?.context ?? { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
  return withWorkspace(scope, async () => {

  // ── exchange ──
  const environment: Environment = session.environment === 'sandbox' ? 'sandbox' : 'production'
  const app = await getChannelApp(input.channelKey, environment)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: session.redirectUri,
    ...(spec.auth.tokenParams ?? {}),
    ...(session.codeVerifier ? { code_verifier: session.codeVerifier } : {}),
  })
  // Shopify's authorization-code exchange accepts client_id, client_secret and code;
  // unlike RFC-generic providers it does not take grant_type or redirect_uri here.
  if (input.channelKey === 'SHOPIFY') {
    body.delete('grant_type')
    body.delete('redirect_uri')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (spec.auth.tokenRequestAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', app.clientId)
    if (app.clientSecret && spec.auth.includeClientSecretInTokenRequest !== false) body.set('client_secret', app.clientSecret)
  }
  let text: string
  let ok: boolean
  let status: number
  try {
    const res = await fetch(spec.auth.tokenUrl({ region: session.region, environment }), { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), redirect: 'error' })
    text = await res.text()
    ok = res.ok
    status = res.status
  } catch (err) {
    throw await fail('exchange_failed', `Could not reach ${spec.displayName}'s token endpoint.`, 502, { error: err instanceof Error ? err.message : String(err) })
  }
  if (!ok) {
    logger.warn('[cx-oauth] code exchange rejected', { channelKey: input.channelKey, status })
    throw await fail('exchange_failed', `${spec.displayName} rejected the authorization code (${status}).`, 502, { status })
  }
  let token: ReturnType<typeof parseTokenResponse>
  try { token = parseTokenResponse(text) } catch { throw await fail('exchange_failed', 'The provider returned an invalid token response.', 502) }
  const accessToken = token.access_token
  const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : null
  if (spec.auth.refreshTokenRequired && !refreshToken) {
    throw await fail('exchange_failed', `${spec.displayName} returned no refresh token. No connection was changed.`, 502)
  }
  const configuredLifetime = spec.auth.accessTokenLifetimeSec === null ? null : (spec.auth.accessTokenLifetimeSec ?? 3600)
  let expiresInSec: number | null
  let refreshExpiresInSec: number | null
  try {
    expiresInSec = tokenLifetime(token.expires_in, configuredLifetime)
    refreshExpiresInSec = tokenLifetime(token.refresh_token_expires_in, null)
  } catch { throw await fail('exchange_failed', 'The provider returned an invalid token lifetime.', 502) }
  if (input.channelKey === 'SHOPIFY' && expiresInSec !== null && !refreshToken) {
    throw await fail('exchange_failed', 'Shopify returned an expiring token without a refresh token. No connection was changed.', 502)
  }
  if (input.channelKey === 'SHOPIFY' && typeof token.scope !== 'string') {
    throw await fail('exchange_failed', 'Shopify did not report the granted permissions. No connection was changed.', 502)
  }
  const grantedScopes = typeof token.scope === 'string'
    ? token.scope.split(/[\s,]+/).filter(Boolean)
    : spec.auth.requiredScopes // channels that echo nothing (eBay code grant) grant exactly what was asked or fail
  const metadata: Record<string, unknown> = {}
  for (const k of spec.auth.tokenResponseMetadata ?? []) if (token[k] !== undefined) metadata[k] = token[k]
  for (const k of spec.auth.callbackMetadata ?? []) if (input.query[k] !== undefined) metadata[k] = input.query[k]

  // ── who consented ──
  // A throwaway handle whose token() returns the fresh access token (no row yet).
  const probe = {
    id: session.targetConnectionId ?? 'pending',
    channelKey: input.channelKey,
    channelType: spec.channelType,
    region: session.region,
    grantedScopes,
    identity: input.channelKey === 'AMAZON_SP' && typeof metadata.selling_partner_id === 'string' ? { userId: metadata.selling_partner_id } : null,
    environment,
    token: async () => accessToken,
  }
  let identity: ConnectionIdentity | null = null
  try {
    identity = await spec.identity(probe)
  } catch (err) {
    logger.warn('[cx-oauth] identity lookup failed', { channelKey: input.channelKey, error: err instanceof Error ? err.message : String(err) })
  }
  if (!identity?.userId && (spec.auth.identityRequired || process.env.NEXUS_WORKSPACES_ENABLED === '1')) {
    throw await fail('identity_refused', 'The provider could not verify this account identity. No connection was changed.', 409)
  }
  if (identity && metadata.selling_partner_id && !identity.userId) identity.userId = String(metadata.selling_partner_id)

  // ── where the grant goes ──
  const saved = await inDatabaseTransaction(prisma, async () => {
  let placement
  try {
    placement = await placeGrant({
      channelType: spec.channelType,
      channelLabel: spec.displayName,
      identity,
      targetConnectionId: session.targetConnectionId,
    })
  } catch (err) {
    if (err instanceof IdentityRefusal) {
      throw await fail('identity_refused', err.message, 409, { code: err.code, identity: err.identityUsername ?? null })
    }
    throw err
  }

  let connectionId: string
  let eventType: 'grant' | 'reconsent' | 'adopt'
  if (placement.kind === 'new') {
    const created = await prisma.channelConnection.create({
      data: { channelType: spec.channelType, managedBy: 'oauth', isActive: false, authStatus: 'unknown', region: session.region, connectionMetadata: { environment } },
      select: { id: true },
    })
    connectionId = created.id
    eventType = 'grant'
  } else {
    connectionId = placement.connectionId
    eventType = placement.kind
    const existing = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { connectionMetadata: true } })
    const storedEnvironment = (existing?.connectionMetadata as { environment?: string } | null)?.environment ?? 'production'
    if (storedEnvironment !== environment) throw await fail('identity_refused', 'Reconnect this account in its original environment.', 409)
  }

  const grant: GrantResult = {
    accessToken,
    refreshToken,
    expiresInSec,
    refreshExpiresInSec,
    grantedScopes,
    identity,
    region: session.region,
    tokenResponseMetadata: metadata,
  }
  const actor: Actor = { kind: 'operator', userId: input.actorUserId ?? session.startedByUserId ?? null }
  await storeGrant(connectionId, grant, actor, eventType)
  const stored = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { connectionMetadata: true } })
  const previousMetadata = stored?.connectionMetadata && typeof stored.connectionMetadata === 'object' && !Array.isArray(stored.connectionMetadata) ? stored.connectionMetadata : {}
  await prisma.channelConnection.update({ where: { id: connectionId }, data: { connectionMetadata: { ...previousMetadata, environment } } })
  return { connectionId, placement }
  }).catch(async error => {
    if ((error as { code?: string }).code === 'P2002') throw await fail('identity_refused', 'This seller account already belongs to a business profile. Reconnect it from that profile.', 409)
    throw error
  })
  const { connectionId, placement } = saved

  // Scopes the grant covers (Amazon marketplaces, Ads profiles …).
  if (spec.discoverScopes) {
    try {
      const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
      if (row) {
        const scopes = await spec.discoverScopes(handleOf(row))
        for (const s of scopes) {
          await prisma.connectionScope.upsert({
            where: { connectionId_kind_externalId: workspaceKey({ connectionId, kind: s.kind, externalId: s.externalId }) },
            create: { connectionId, kind: s.kind, externalId: s.externalId, label: s.label ?? null, region: s.region ?? null, isActive: s.isActive ?? true, metadata: (s.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
            update: { label: s.label ?? null, region: s.region ?? null, isActive: s.isActive ?? true, metadata: (s.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
          })
        }
      }
    } catch (err) {
      logger.warn('[cx-oauth] scope discovery failed (grant stored)', { connectionId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const drift = scopeDriftOf(spec, grantedScopes)
  if (drift.length) await recordConnectionEvent({ connectionId, channelKey: input.channelKey, type: 'scope_drift', actor: { kind: 'operator', userId: scope.actorUserId }, detail: { missing: drift } })
  await prisma.oAuthSession.update({ where: { id: state }, data: { resultConnectionId: connectionId } }).catch(() => undefined)

  return { workspaceId: scope.workspaceId, connectionId, placement: placement.kind, identity, grantedScopes, scopeDrift: drift, channelKey: input.channelKey }
  })
}

/** Sweep expired sessions (called by the heartbeat job). */
export async function sweepSessions(): Promise<number> {
  const r = await prisma.oAuthSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
  return r.count
}
