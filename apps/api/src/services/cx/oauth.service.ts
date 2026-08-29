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
import { logger } from '../../utils/logger.js'
import { getChannelApp, type Environment } from './apps.service.js'
import { getChannelSpec, scopeDriftOf, type ChannelKey, type ConnectionIdentity } from './catalog.js'
import { recordConnectionEvent, type Actor } from './events.service.js'
import { IdentityRefusal, placeGrant } from './identity.service.js'
import { handleOf, storeGrant, type GrantResult } from './token.service.js'

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

export interface StartResult {
  authorizeUrl: string
  state: string
  cookie: { name: string; value: string; maxAgeSec: number }
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
  const spec = getChannelSpec(input.channelKey)
  if (!spec.available) throw new OAuthFlowError('channel_unavailable', `${spec.displayName} connect is not available yet.`)
  if (!spec.auth.authorizeUrl) throw new OAuthFlowError('invalid_intent', `${spec.displayName} does not use a browser consent flow.`)
  if ((input.intent === 'adopt' || input.intent === 'reconnect') && !input.targetConnectionId) {
    throw new OAuthFlowError('invalid_intent', 'reconnect/adopt needs the connection to reconnect.')
  }
  if (input.targetConnectionId) {
    const target = await prisma.channelConnection.findUnique({ where: { id: input.targetConnectionId }, select: { channelType: true } })
    if (!target || target.channelType !== spec.channelType) {
      throw new OAuthFlowError('invalid_intent', 'The account to reconnect does not belong to this channel.')
    }
  }

  const environment = input.environment ?? 'production'
  const app = await getChannelApp(input.channelKey, environment)
  const state = b64url(randomBytes(32))
  const cookieNonce = b64url(randomBytes(24))
  const codeVerifier = spec.auth.pkce ? b64url(randomBytes(48)) : null
  const region = input.region ?? spec.defaultRegion ?? null
  // eBay's redirect_uri is the RuName (redirectUris[0]); everyone else gets the API callback.
  const redirectUri = app.redirectUris[0] ?? callbackUrlFor(input.channelKey)

  await prisma.oAuthSession.create({
    data: {
      id: state,
      channelKey: input.channelKey,
      intent: input.intent,
      targetConnectionId: input.targetConnectionId ?? null,
      startedByUserId: input.actor.userId ?? null,
      codeVerifier,
      redirectUri,
      cookieNonce,
      region,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })

  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    scope: spec.auth.requiredScopes.join(spec.auth.scopeSeparator),
    state,
    ...(spec.auth.authorizationParams ?? {}),
    ...(spec.auth.promptParam ?? {}),
  })
  if (codeVerifier) {
    params.set('code_challenge', b64url(createHash('sha256').update(codeVerifier).digest()))
    params.set('code_challenge_method', 'S256')
  }
  const authorizeUrl = `${spec.auth.authorizeUrl({ region, environment })}?${params.toString()}`

  logger.info('[cx-oauth] session started', { channelKey: input.channelKey, intent: input.intent, statePrefix: state.slice(0, 8) })
  return {
    authorizeUrl,
    state,
    cookie: { name: `${COOKIE_PREFIX}${state}`, value: cookieNonce, maxAgeSec: SESSION_TTL_MS / 1000 },
    expiresInSec: SESSION_TTL_MS / 1000,
  }
}

export interface CompleteResult {
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

  // Consume in ONE statement: whoever flips consumedAt wins; a replay finds it set.
  const consumed = await prisma.oAuthSession.updateMany({
    where: { id: state, channelKey: input.channelKey, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  const session = await prisma.oAuthSession.findUnique({ where: { id: state } })
  if (!session || session.channelKey !== input.channelKey) {
    throw new OAuthFlowError('state_unknown', 'The sign-in could not be verified as coming from Nexus. Start the connection again.')
  }
  if (consumed.count !== 1) {
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
    await recordConnectionEvent({ channelKey: input.channelKey, type: 'status_change', detail: { oauth: 'state_cookie_missing', enforced: enforce } })
    if (enforce) throw await fail('state_cookie_missing', 'This sign-in did not come back to the browser that started it. Start the connection again.')
  } else if (cookie !== session.cookieNonce) {
    throw await fail('state_cookie_mismatch', 'This sign-in did not come back to the browser that started it. Start the connection again.')
  }

  if (input.query.error) {
    const description = input.query.error_description ?? input.query.error
    throw await fail('provider_error', `${spec.displayName} declined the authorisation: ${description}`, 400, {
      providerError: input.query.error,
      providerDescription: input.query.error_description ?? null,
    })
  }
  const code = input.query[spec.auth.codeParamInCallback]
  if (!code) throw await fail('code_missing', `${spec.displayName} did not return an authorization code.`)

  // ── exchange ──
  const environment: Environment = 'production'
  const app = await getChannelApp(input.channelKey, environment)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: session.redirectUri,
    ...(spec.auth.tokenParams ?? {}),
    ...(session.codeVerifier ? { code_verifier: session.codeVerifier } : {}),
  })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (spec.auth.tokenRequestAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', app.clientId)
    if (app.clientSecret) body.set('client_secret', app.clientSecret)
  }
  let text: string
  let ok: boolean
  let status: number
  try {
    const res = await fetch(spec.auth.tokenUrl({ region: session.region, environment }), { method: 'POST', headers, body: body.toString() })
    text = await res.text()
    ok = res.ok
    status = res.status
  } catch (err) {
    throw await fail('exchange_failed', `Could not reach ${spec.displayName}'s token endpoint.`, 502, { error: err instanceof Error ? err.message : String(err) })
  }
  if (!ok) {
    logger.warn('[cx-oauth] code exchange rejected', { channelKey: input.channelKey, status })
    throw await fail('exchange_failed', `${spec.displayName} rejected the authorization code (${status}).`, 502, { status, body: text.slice(0, 300) })
  }
  const token = JSON.parse(text) as Record<string, unknown>
  const accessToken = String(token.access_token ?? '')
  if (!accessToken) throw await fail('exchange_failed', `${spec.displayName} returned no access token.`, 502)
  const expiresInSec = Number(token.expires_in ?? spec.auth.accessTokenLifetimeSec ?? 3600)
  const refreshExpiresInSec = typeof token.refresh_token_expires_in === 'number' ? token.refresh_token_expires_in : null
  const grantedScopes = typeof token.scope === 'string' && token.scope.length > 0
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
    identity: null,
    token: async () => accessToken,
  }
  let identity: ConnectionIdentity | null = null
  try {
    identity = await spec.identity(probe)
  } catch (err) {
    logger.warn('[cx-oauth] identity lookup failed; continuing without it', { channelKey: input.channelKey, error: err instanceof Error ? err.message : String(err) })
  }
  if (identity && metadata.selling_partner_id && !identity.userId) identity.userId = String(metadata.selling_partner_id)

  // ── where the grant goes ──
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
      data: { channelType: spec.channelType, managedBy: 'oauth', isActive: false, authStatus: 'unknown', region: session.region },
      select: { id: true },
    })
    connectionId = created.id
    eventType = 'grant'
  } else {
    connectionId = placement.connectionId
    eventType = placement.kind
  }

  const grant: GrantResult = {
    accessToken,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
    expiresInSec,
    refreshExpiresInSec,
    grantedScopes,
    identity,
    region: session.region,
    tokenResponseMetadata: metadata,
  }
  const actor: Actor = { kind: 'operator', userId: input.actorUserId ?? session.startedByUserId ?? null }
  await storeGrant(connectionId, grant, actor, eventType)

  // Scopes the grant covers (Amazon marketplaces, Ads profiles …).
  if (spec.discoverScopes) {
    try {
      const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
      if (row) {
        const scopes = await spec.discoverScopes(handleOf(row))
        for (const s of scopes) {
          await prisma.connectionScope.upsert({
            where: { connectionId_kind_externalId: { connectionId, kind: s.kind, externalId: s.externalId } },
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
  if (drift.length) await recordConnectionEvent({ connectionId, channelKey: input.channelKey, type: 'scope_drift', actor, detail: { missing: drift } })
  await prisma.oAuthSession.update({ where: { id: state }, data: { resultConnectionId: connectionId } }).catch(() => undefined)

  return { connectionId, placement: placement.kind, identity, grantedScopes, scopeDrift: drift, channelKey: input.channelKey }
}

/** Sweep expired sessions (called by the heartbeat job). */
export async function sweepSessions(): Promise<number> {
  const r = await prisma.oAuthSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
  return r.count
}
