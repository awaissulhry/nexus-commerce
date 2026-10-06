/**
 * MCP.5 — the OAuth 2.1 authorization server that lets a person connect Claude to one business.
 *
 *   authorize  Claude sends the person to the web app's /oauth/authorize page. The page asks this
 *              server to check the request (checkAuthorize), and the person approves with a fresh
 *              2FA code (consent). A one-time code goes back to Claude's redirect URI.
 *   token      Claude swaps the code and its PKCE verifier for an access token (1 hour) and a
 *              refresh token (30 days). A refresh token works once; presenting it again means a
 *              copy was stolen, so the whole connection is revoked (OAuth 2.1 §4.3.1). W4-3 — except
 *              the same app within 2 minutes, before anything the first answer bought was used (a
 *              lost answer, two refreshes at once): those unused tokens end and it gets a new pair.
 *   /mcp       verifyAccessToken finds the person, the business and their permissions — fresh
 *              on every call, so a removed member or a changed role takes effect at once.
 *
 * One connection per person, business and app (OAuthGrant): a new consent replaces the old one
 * and ends its tokens. Codes and tokens are random 256-bit values, stored as sha256 only. Every
 * connect and revoke is written to WorkspaceAudit.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import prisma from '../../db.js'
import { FEATURES } from '@nexus/shared/permissions'
import { generateToken, hashToken } from '../../lib/auth/tokens.js'
import { verifyStepUpCode } from '../../lib/auth/step-up.js'
import type { ResolvedPermissions } from '../../lib/auth/rbac.js'
import type { WorkspaceContext } from '../../lib/workspace-context.js'
import { createWorkspaceService } from '../workspace.service.js'
import { actorLabel } from '../agents/call-tool.js'
import {
  ACCESS_TOKEN_SECONDS,
  CODE_SECONDS,
  MCP_SCOPES,
  REFRESH_GRACE_SECONDS,
  REFRESH_TOKEN_SECONDS,
  mcpResource,
  mcpResourceTarget,
  mcpWorkspaceAllowList,
  oauthIssuer,
  parseScopes,
  type McpScope,
} from './oauth-config.js'
import { clientRedirects, OAuthClientError, resolveClient, type OAuthClientRecord } from './oauth-clients.js'
import { logger } from '../../utils/logger.js'

const workspaces = createWorkspaceService(prisma)
const LAST_USED_EVERY_MS = 5 * 60_000

/** An OAuth error with its RFC code. `redirectTo` = it may go back to the client, at this URL. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly redirectTo?: string,
  ) {
    super(description)
    this.name = 'OAuthError'
  }
}

export interface AuthorizeParams {
  response_type?: unknown
  client_id?: unknown
  redirect_uri?: unknown
  code_challenge?: unknown
  code_challenge_method?: unknown
  state?: unknown
  scope?: unknown
  resource?: unknown
}

export interface ValidAuthorize {
  client: OAuthClientRecord
  redirectUri: string
  state: string | null
  codeChallenge: string
  scopes: McpScope[]
  resource: string
  /** C4 — the business the request's MCP URL names (its own URL): the consent may connect that one only. */
  lockedWorkspaceId: string | null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * Check an authorization request. Until the client and its redirect URI are known good, an error
 * is shown on the page (never sent to an unchecked URI); after that it goes back to the client.
 */
export async function validateAuthorize(params: AuthorizeParams): Promise<ValidAuthorize> {
  let client: OAuthClientRecord
  try {
    client = await resolveClient(params.client_id)
  } catch (error) {
    if (error instanceof OAuthClientError) throw new OAuthError('invalid_client', error.message)
    throw error
  }
  const redirectUri = text(params.redirect_uri)
  if (!redirectUri || !clientRedirects(client, redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not one this app registered')
  }
  const state = typeof params.state === 'string' ? params.state.slice(0, 1000) : null
  const fail = (error: string, description: string) =>
    new OAuthError(error, description, 400, redirectWith({ redirectUri, state }, { error, error_description: description }))
  if (text(params.response_type) !== 'code') throw fail('unsupported_response_type', 'response_type must be code')
  const codeChallenge = text(params.code_challenge)
  if (text(params.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw fail('invalid_request', 'PKCE with code_challenge_method S256 is required')
  }
  // C4 — the plain MCP URL, or one business's own URL (which locks the consent to that business).
  const target = mcpResourceTarget(text(params.resource))
  if (!target) throw fail('invalid_target', `resource must be ${mcpResource()} or ${mcpResource()}/w/<business id>`)
  const scopes = parseScopes(params.scope)
  if (scopes.length === 0) throw fail('invalid_scope', `scope must be ${MCP_SCOPES.join(' and/or ')}`)
  return { client, redirectUri, state, codeChallenge, scopes, resource: target.resource, lockedWorkspaceId: target.workspaceId }
}

/** The redirect URI with the answer on it, and `iss` for mix-up protection (RFC 9207). */
export function redirectWith(valid: Pick<ValidAuthorize, 'redirectUri' | 'state'>, answer: Record<string, string>): string {
  const url = new URL(valid.redirectUri)
  for (const [key, value] of Object.entries(answer)) url.searchParams.set(key, value)
  if (valid.state != null) url.searchParams.set('state', valid.state)
  url.searchParams.set('iss', oauthIssuer())
  return url.toString()
}

function canConnect(access: { isOwner: boolean; permissions: Set<string> }): boolean {
  return access.isOwner || access.permissions.has(FEATURES.aiRun)
}

export interface AuthorizeView {
  clientName: string
  redirectHost: string
  loopback: boolean
  scopes: McpScope[]
  mfaEnrolled: boolean
  businesses: Array<{ id: string; name: string; canConnect: boolean }>
  /** C4 — set when the MCP URL is one business's own: `businesses` then holds that one at most. */
  lockedWorkspaceId: string | null
}

/**
 * What the consent page shows: the app, where it returns, and the person's businesses — or, for a business's own MCP
 * URL (C4), that business alone (none when the person is not in it or it is outside the allow-list).
 */
export async function checkAuthorize(userId: string, params: AuthorizeParams): Promise<AuthorizeView> {
  const valid = await validateAuthorize(params)
  const user = await prisma.userProfile.findUnique({ where: { id: userId }, select: { twoFactorEnabledAt: true } })
  const allow = mcpWorkspaceAllowList()
  const listed = (await workspaces.list(userId, 50)) as Array<{ id: string; name: string }>
  const locked = valid.lockedWorkspaceId
  const businesses = await Promise.all(
    listed
      .filter((business) => (!allow || allow.has(business.id)) && (!locked || business.id === locked))
      .map(async (business) => {
        const access = await workspaces.membership(userId, business.id).catch(() => null)
        return { id: business.id, name: business.name, canConnect: !!access && canConnect(access) }
      }),
  )
  const redirect = new URL(valid.redirectUri)
  return {
    clientName: valid.client.clientName,
    redirectHost: redirect.host,
    loopback: redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1',
    scopes: valid.scopes,
    mfaEnrolled: !!user?.twoFactorEnabledAt,
    businesses,
    lockedWorkspaceId: locked,
  }
}

export interface ConsentInput {
  userId: string
  params: AuthorizeParams
  decision: 'approve' | 'deny'
  workspaceId?: unknown
  scopes?: unknown
  code?: unknown
}

/** The person's answer. Returns where to send the browser: the client's redirect URI. */
export async function consent(input: ConsentInput): Promise<{ redirectTo: string }> {
  const valid = await validateAuthorize(input.params)
  if (input.decision === 'deny') {
    return { redirectTo: redirectWith(valid, { error: 'access_denied', error_description: 'The person declined.' }) }
  }
  const user = await prisma.userProfile.findUnique({
    where: { id: input.userId },
    select: { id: true, status: true, email: true, displayName: true, twoFactorEnabledAt: true, twoFactorSecret: true },
  })
  if (!user || user.status !== 'active') throw new OAuthError('access_denied', 'This account cannot connect apps.', 403)
  if (!user.twoFactorEnabledAt || !user.twoFactorSecret) {
    throw new OAuthError('mfa_not_enrolled', 'Turn on two-factor authentication before connecting Claude.', 403)
  }
  const verdict = await verifyStepUpCode(user.id, user.twoFactorSecret, input.code)
  if (verdict === 'locked') throw new OAuthError('mfa_locked', 'Too many wrong codes. Try again in 15 minutes.', 429)
  if (verdict === 'reused') throw new OAuthError('mfa_invalid', 'That code was already used. Wait for the next one.', 400)
  if (verdict !== 'ok') throw new OAuthError('mfa_invalid', 'That code is not right. Check your authenticator app.', 400)

  // C4 — a business's own MCP URL decides the business; the page cannot pick another one.
  const picked = text(input.workspaceId)
  if (valid.lockedWorkspaceId && picked && picked !== valid.lockedWorkspaceId) {
    throw new OAuthError('access_denied', 'This connection is for another business. Add Claude again with that business’s own address.', 403)
  }
  const workspaceId = valid.lockedWorkspaceId ?? picked
  const allow = mcpWorkspaceAllowList()
  if (!workspaceId || (allow && !allow.has(workspaceId))) {
    throw new OAuthError('access_denied', 'Claude cannot be connected to this business yet.', 403)
  }
  const access = await workspaces.membership(user.id, workspaceId).catch(() => null)
  if (!access) throw new OAuthError('access_denied', 'You are not an active member of this business.', 403)
  if (!canConnect(access)) throw new OAuthError('access_denied', 'Connecting Claude needs the ai.run permission in this business.', 403)

  // The person may narrow what the app asked for; write implies read. C5 — run needs write: a change Claude may not
  // ask for cannot run by rule, so run without write is dropped (narrowed), never widened into write.
  const chosen = Array.isArray(input.scopes) ? new Set(input.scopes.filter((s): s is string => typeof s === 'string')) : new Set(valid.scopes)
  let scopes = valid.scopes.filter((scope) => chosen.has(scope))
  if (scopes.includes('nexus.write') && !scopes.includes('nexus.read')) scopes.unshift('nexus.read')
  if (scopes.includes('nexus.run') && !scopes.includes('nexus.write')) scopes = scopes.filter((scope) => scope !== 'nexus.run')
  if (scopes.length === 0) throw new OAuthError('invalid_scope', 'Choose what Claude may do.', 400)

  const rawCode = generateToken(32)
  await prisma.$transaction(async (tx) => {
    const key = { workspaceId, userId: user.id, clientId: valid.client.id }
    const existing = await tx.oAuthGrant.findUnique({ where: { workspaceId_userId_clientId: key } })
    const now = new Date()
    if (existing) await endTokens(tx, existing.id, now)
    const grant = existing
      ? await tx.oAuthGrant.update({
          where: { id: existing.id },
          data: { scopes, revokedAt: null, revokedBy: null, revokeReason: null, lastUsedAt: null },
        })
      : await tx.oAuthGrant.create({ data: { ...key, scopes } })
    await tx.oAuthAuthorizationCode.create({
      data: {
        codeHash: hashToken(rawCode),
        grantId: grant.id,
        redirectUri: valid.redirectUri,
        codeChallenge: valid.codeChallenge,
        resource: valid.resource,
        scopes,
        expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000),
      },
    })
    await tx.workspaceAudit.create({
      data: {
        workspaceId,
        actorUserId: user.id,
        action: 'oauth.connected',
        targetId: grant.id,
        metadata: { app: valid.client.clientName, clientId: valid.client.clientId, scopes, replaced: !!existing },
      },
    })
  })
  return { redirectTo: redirectWith(valid, { code: rawCode }) }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** End every live token and unused code of a connection. */
async function endTokens(tx: Tx | typeof prisma, grantId: string, now: Date): Promise<void> {
  await tx.oAuthToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } })
  await tx.oAuthAuthorizationCode.updateMany({ where: { grantId, usedAt: null }, data: { usedAt: now } })
}

/** Revoke a connection: it and all its tokens end now, and the audit trail says who and why. */
export async function revokeGrant(grantId: string, reason: string, revokedBy: string | null = null): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const ended = await tx.oAuthGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, revokedBy },
    })
    await endTokens(tx, grantId, now)
    if (ended.count === 0) return false
    const grant = await tx.oAuthGrant.findUnique({ where: { id: grantId }, select: { workspaceId: true } })
    if (grant) {
      await tx.workspaceAudit.create({
        data: { workspaceId: grant.workspaceId, actorUserId: revokedBy, action: 'oauth.revoked', targetId: grantId, metadata: { reason } },
      })
    }
    return true
  })
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

async function issueTokens(
  tx: Tx,
  grant: { id: string },
  scopes: string[],
  resource: string,
  parentId: string | null,
): Promise<TokenResponse> {
  const now = Date.now()
  const access = `nxm_at_${generateToken(32)}`
  const refresh = `nxm_rt_${generateToken(32)}`
  await tx.oAuthToken.createMany({
    data: [
      { tokenHash: hashToken(access), kind: 'access', grantId: grant.id, parentId, resource, scopes, expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000) },
      { tokenHash: hashToken(refresh), kind: 'refresh', grantId: grant.id, parentId, resource, scopes, expiresAt: new Date(now + REFRESH_TOKEN_SECONDS * 1000) },
    ],
  })
  await tx.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date(now) } })
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: scopes.join(' ') }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/** The person and business behind a grant are still allowed to connect. */
async function grantStillValid(grant: { userId: string; workspaceId: string }): Promise<boolean> {
  const allow = mcpWorkspaceAllowList()
  if (allow && !allow.has(grant.workspaceId)) return false
  const access = await workspaces.membership(grant.userId, grant.workspaceId).catch(() => null)
  return !!access && canConnect(access)
}

const invalidGrant = (description: string) => new OAuthError('invalid_grant', description)

/** grant_type=authorization_code */
export async function exchangeCode(form: Record<string, string | undefined>): Promise<TokenResponse> {
  const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = form
  if (!code || !verifier || !clientId || !redirectUri) {
    throw new OAuthError('invalid_request', 'code, code_verifier, client_id and redirect_uri are required')
  }
  const row = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash: hashToken(code) },
    include: { grant: { include: { client: true } } },
  })
  if (!row) throw invalidGrant('unknown code')
  const claimed = await prisma.oAuthAuthorizationCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } })
  if (claimed.count === 0) {
    // A code presented twice: whoever holds it is not to be trusted with what it bought.
    await revokeGrant(row.grantId, 'code_reuse')
    throw invalidGrant('code already used')
  }
  if (row.expiresAt.getTime() <= Date.now()) throw invalidGrant('code expired')
  if (row.grant.client.clientId !== clientId) throw invalidGrant('code was issued to another app')
  if (row.redirectUri !== redirectUri) throw invalidGrant('redirect_uri does not match')
  if (form.resource && form.resource.replace(/\/+$/, '') !== row.resource) throw new OAuthError('invalid_target', 'resource does not match')
  if (!pkceMatches(verifier, row.codeChallenge)) throw invalidGrant('code_verifier does not match')
  if (row.grant.revokedAt || row.grant.client.disabledAt) throw invalidGrant('connection revoked')
  if (!(await grantStillValid(row.grant))) throw invalidGrant('the person can no longer connect this business')
  const response = await prisma.$transaction((tx) => issueTokens(tx, row.grant, row.scopes, row.resource, null))
  await prisma.oAuthClient.update({ where: { id: row.grant.clientId }, data: { lastUsedAt: new Date() } })
  return response
}

/**
 * W4-3 — a used refresh token presented again by its own app (client_id is checked before) within REFRESH_GRACE_SECONDS
 * of its first use, while nothing it bought has been used (no call with its access token, no refresh with its refresh
 * token): end those unused tokens, so the caller may answer once more. Null = treat it as a stolen copy.
 */
async function endUnusedChildren(tx: Tx, tokenId: string, now: Date): Promise<{ ended: number; seconds: number } | null> {
  const token = await tx.oAuthToken.findUnique({ where: { id: tokenId }, select: { usedAt: true, revokedAt: true } })
  if (!token?.usedAt || token.revokedAt) return null
  const seconds = Math.round((now.getTime() - token.usedAt.getTime()) / 1000)
  if (seconds > REFRESH_GRACE_SECONDS) return null
  const children = await tx.oAuthToken.findMany({ where: { parentId: tokenId }, select: { id: true, usedAt: true, revokedAt: true } })
  if (children.some((child) => child.usedAt)) return null
  const live = children.filter((child) => !child.revokedAt).map((child) => child.id)
  // Only rows still unused end here: a call or a refresh that lands meanwhile leaves the count short, and that is theft.
  const ended = await tx.oAuthToken.updateMany({ where: { id: { in: live }, usedAt: null, revokedAt: null }, data: { revokedAt: now } })
  return ended.count === live.length ? { ended: ended.count, seconds } : null
}

/** grant_type=refresh_token */
export async function refreshTokens(form: Record<string, string | undefined>): Promise<TokenResponse> {
  const { refresh_token: raw, client_id: clientId } = form
  if (!raw || !clientId) throw new OAuthError('invalid_request', 'refresh_token and client_id are required')
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { grant: { include: { client: true } } },
  })
  if (!row || row.kind !== 'refresh') throw invalidGrant('unknown refresh token')
  if (row.grant.client.clientId !== clientId) throw invalidGrant('refresh token was issued to another app')
  if (row.revokedAt || row.grant.revokedAt || row.grant.client.disabledAt) throw invalidGrant('connection revoked')
  if (row.expiresAt.getTime() <= Date.now()) throw invalidGrant('refresh token expired')
  if (form.resource && form.resource.replace(/\/+$/, '') !== row.resource) throw new OAuthError('invalid_target', 'resource does not match')
  // MCP.12 — RFC 6749 §6: the requested scope MUST NOT include any scope the person did not grant. A name the grant
  // does not hold (unknown to Nexus, or not approved) used to be dropped silently and the refresh answered 200 with
  // the rest; it never widened access, but it answered as if the request were fine. It is refused now.
  const named = typeof form.scope === 'string' ? form.scope.trim().split(/\s+/).filter(Boolean) : []
  if (named.some((scope) => !row.scopes.includes(scope))) {
    // The granted names only: a client's own text is never echoed into error_description.
    throw new OAuthError('invalid_scope', `a refresh cannot widen what the person approved (granted: ${row.scopes.join(' ')})`)
  }
  const asked = named.length ? parseScopes(named.join(' ')) : row.scopes
  if (asked.length === 0) throw new OAuthError('invalid_scope', 'a refresh cannot widen what the person approved')
  if (!(await grantStillValid(row.grant))) throw invalidGrant('the person can no longer connect this business')
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.oAuthToken.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } })
    if (claimed.count === 0) {
      const retry = await endUnusedChildren(tx, row.id, new Date())
      if (retry) {
        const metadata = { reason: 'refresh_retry', ended: retry.ended, secondsAfterFirstUse: retry.seconds }
        await tx.workspaceAudit.create({
          data: { workspaceId: row.grant.workspaceId, actorUserId: null, action: 'oauth.refresh_grace', targetId: row.grantId, metadata },
        })
        return { tokens: await issueTokens(tx, row.grant, asked, row.resource, row.id), retry: metadata }
      }
      // Used before: only a stolen copy is presented twice. End the whole connection.
      await endTokens(tx, row.grantId, new Date())
      await tx.oAuthGrant.updateMany({
        where: { id: row.grantId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'refresh_reuse' },
      })
      await tx.workspaceAudit.create({
        data: { workspaceId: row.grant.workspaceId, actorUserId: null, action: 'oauth.revoked', targetId: row.grantId, metadata: { reason: 'refresh_reuse' } },
      })
      return null
    }
    return { tokens: await issueTokens(tx, row.grant, asked, row.resource, row.id), retry: null }
  }).then((issued) => {
    if (!issued) throw invalidGrant('refresh token already used; the connection was revoked')
    if (issued.retry) {
      logger.warn('[oauth] a refresh token was presented again within the grace window: its unused tokens ended, a new pair was issued', {
        grantId: row.grantId, ...issued.retry,
      })
    }
    return issued.tokens
  })
}

/** RFC 7009. Always succeeds from the caller's view; ends what the token can reach. */
export async function revokeToken(form: Record<string, string | undefined>): Promise<void> {
  const { token, client_id: clientId } = form
  if (!token) throw new OAuthError('invalid_request', 'token is required')
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { grant: { include: { client: true } } },
  })
  if (!row || (clientId && row.grant.client.clientId !== clientId)) return
  if (row.kind === 'refresh') {
    await revokeGrant(row.grantId, 'client_revoked')
    return
  }
  await prisma.oAuthToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } })
}

export interface VerifiedAccess {
  grantId: string
  userId: string
  label: string
  workspace: WorkspaceContext
  /** C3 — the business's name as it is now: Claude is told which business every result is from. */
  workspaceName: string
  permissions: ResolvedPermissions
  scopes: McpScope[]
  clientName: string
}

/**
 * The person behind a Bearer token on /mcp, or null. Checked in full on every call: the token,
 * its audience, the connection, the app, the account, and the membership with its permissions
 * as they are now.
 *
 * C4 — `resource` is the MCP URL the call came to: the plain one, or one business's own. A token works only at the
 * URL it was issued for, and a business's URL only for that business.
 */
export async function verifyAccessToken(raw: string | undefined, resource: string = mcpResource()): Promise<VerifiedAccess | null> {
  if (!raw || !raw.startsWith('nxm_at_')) return null
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: {
      grant: {
        include: {
          client: { select: { clientName: true, disabledAt: true } },
          user: { select: { id: true, status: true, email: true, displayName: true } },
        },
      },
    },
  })
  if (!row || row.kind !== 'access' || row.revokedAt) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  if (row.resource !== resource) return null
  const { grant } = row
  const target = mcpResourceTarget(resource)
  if (!target || (target.workspaceId && target.workspaceId !== grant.workspaceId)) return null
  if (grant.revokedAt || grant.client.disabledAt || grant.user.status !== 'active') return null
  const allow = mcpWorkspaceAllowList()
  if (allow && !allow.has(grant.workspaceId)) return null
  const access = await workspaces.membership(grant.userId, grant.workspaceId).catch(() => null)
  if (!access || !canConnect(access)) return null
  // W4-3 — an access token's first call is kept: once it made one, the refresh token that bought it is never retried.
  if (!row.usedAt) await prisma.oAuthToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } })
  if (!grant.lastUsedAt || Date.now() - grant.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
  }
  return {
    grantId: grant.id,
    userId: grant.userId,
    label: actorLabel({ id: grant.user.id, email: grant.user.email, displayName: grant.user.displayName ?? undefined }),
    workspace: access.context,
    workspaceName: access.workspace.name,
    permissions: { isOwner: access.isOwner, permissions: access.permissions },
    scopes: row.scopes.filter((scope): scope is McpScope => (MCP_SCOPES as readonly string[]).includes(scope)),
    clientName: grant.client.clientName,
  }
}
