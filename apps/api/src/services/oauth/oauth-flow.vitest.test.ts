/**
 * MCP.5 — connecting Claude to Nexus, end to end, on a real PostgreSQL with the production schema,
 * grants and business policies (PGlite), business profiles ON, real TOTP codes.
 *
 * The promises: an app registers only Claude's own redirect URIs; a person approves with a fresh,
 * single-use 2FA code for a business where they may use the assistant; the code is swapped once,
 * with its PKCE verifier; a refresh token works once, and a second use ends the connection (W4-3: unless the same
 * app retries within 2 minutes, before the first answer was used); every call on /mcp re-checks the token, the
 * connection and the membership.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// W4-2 — the e-mail that tells a person their connection was ended: recorded, never sent.
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string | string[]; subject: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/transport.js')>()),
  sendEmail: vi.fn(async (message: { to: string | string[]; subject: string }) => {
    mail.sent.push(message)
    return { ok: true, provider: 'resend', dryRun: false, messageId: `test-${mail.sent.length}` }
  }),
}))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { generateToken, hashToken } from '../../lib/auth/tokens.js'
import { __clientTest, cimdUnreachable, registerClient, resolveClient } from './oauth-clients.js'
import { mcpResourceFor } from './oauth-config.js'
import { CONNECTION_REVOKED_NOTICE_TYPE } from './oauth-revoke-notice.js'
import { logger } from '../../utils/logger.js'
import {
  checkAuthorize,
  consent,
  exchangeCode,
  OAuthError,
  refreshTokens,
  revokeToken,
  validateAuthorize,
  verifyAccessToken,
  type AuthorizeParams,
} from './oauth-server.js'

const RESOURCE = 'https://api.example.test/mcp'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const OTHER_BUSINESS = 'mcp_oauth_other_business'

let secret: string
let userId: string
let noAiUserId: string
let clientId: string

const code = () => generateSync({ secret })
const verifier = () => generateToken(32)
const challengeOf = (value: string) => createHash('sha256').update(value).digest('base64url')

function authorizeParams(pkce: string, overrides: AuthorizeParams = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challengeOf(pkce),
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'nexus.read nexus.write',
    resource: RESOURCE,
    ...overrides,
  }
}

/** Approve in the browser and swap the code, as Claude would. */
async function connect(pkce = verifier()) {
  const { redirectTo } = await consent({
    userId,
    params: authorizeParams(pkce),
    decision: 'approve',
    workspaceId: LEGACY_WORKSPACE_ID,
    code: code(),
  })
  __stepUpTest.reset() // the next connect in the same 30 s window may reuse the code
  const url = new URL(redirectTo)
  const tokens = await exchangeCode({
    grant_type: 'authorization_code',
    code: url.searchParams.get('code') ?? undefined,
    code_verifier: pkce,
    client_id: clientId,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
  })
  return { url, tokens }
}

/** W4-2 — the person's "connection ended" notices, newest first, in the connection's business. */
const revokedNotices = () => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
  database.client.notification.findMany({ where: { userId, type: CONNECTION_REVOKED_NOTICE_TYPE }, orderBy: { createdAt: 'desc' } }))
const revokedNoticeCount = async () => (await revokedNotices()).length

async function expectOAuthError(work: Promise<unknown>, error: string) {
  await expect(work).rejects.toBeInstanceOf(OAuthError)
  await expect(work).rejects.toMatchObject({ error })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', 'https://api.example.test')
  const db = database.client
  secret = generateSecret()
  const operator = await db.role.create({
    data: { key: `MCP_OPS_${randomUUID().slice(0, 8)}`, name: 'Ops', description: 'test', permissions: ['ai.run', 'ai.view', 'products.view'], isSystem: false },
  })
  const viewer = await db.role.create({
    data: { key: `MCP_VIEW_${randomUUID().slice(0, 8)}`, name: 'View', description: 'test', permissions: ['products.view'], isSystem: false },
  })
  const user = await db.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Awais', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
  })
  const noAi = await db.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
  })
  userId = user.id
  noAiUserId = noAi.id
  await db.workspace.create({
    data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: user.id, creationKey: randomUUID() },
  })
  const member = await db.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: member.id, roleId: operator.id } })
  const limited = await db.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: noAiUserId, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: limited.id, roleId: viewer.id } })
  clientId = String((await registerClient({ client_name: 'Claude', redirect_uris: [CALLBACK] })).client_id)
}, 120_000)

beforeEach(() => {
  __stepUpTest.reset()
  __clientTest.useFetcher(null)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.5 — which apps may ask', () => {
  it('registers only Claude’s own redirect URIs', async () => {
    await expect(registerClient({ client_name: 'Look-alike', redirect_uris: ['https://evil.example/callback'] }))
      .rejects.toMatchObject({ code: 'invalid_redirect_uri' })
    await expect(registerClient({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' }))
      .rejects.toMatchObject({ code: 'invalid_client_metadata' })
  })

  it('reads a Client ID Metadata Document from an allowed host, and checks it names itself', async () => {
    const url = 'https://claude.ai/oauth/claude-code-client-metadata'
    __clientTest.useFetcher(async () => ({ client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] }))
    await expect(resolveClient(url)).resolves.toMatchObject({ clientName: 'Claude Code' })
    const liar = 'https://claude.com/oauth/other'
    __clientTest.useFetcher(async () => ({ client_id: 'https://claude.com/oauth/someone-else', redirect_uris: [CALLBACK] }))
    await expect(resolveClient(liar)).rejects.toMatchObject({ code: 'invalid_client_metadata' })
    // Another host is not a metadata document at all: it must be a registered client, and it is not.
    await expect(resolveClient('https://evil.example/metadata')).rejects.toMatchObject({ code: 'invalid_client' })
  })

  it('MCP.12 — an app host that cannot be reached is said plainly on the page; the network detail goes to the log', async () => {
    const url = 'https://claude.ai/oauth/mcp12-unreachable-client'
    __clientTest.useFetcher(async () => { throw new Error('getaddrinfo ENOTFOUND claude.ai (lane guard: claude.ai:443 blocked)') })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const work = validateAuthorize({ ...authorizeParams(verifier()), client_id: url, redirect_uri: 'http://localhost:53682/callback' })
      await expect(work).rejects.toMatchObject({ error: 'invalid_client', description: cimdUnreachable('claude.ai') })
      await expect(work).rejects.not.toMatchObject({ description: expect.stringMatching(/ENOTFOUND|443|metadata document|blocked/) })
      expect(cimdUnreachable('claude.ai')).toBe(
        'Nexus could not reach claude.ai to check which app is asking to connect, so it cannot be connected right now. Start the connection again from Claude in a few minutes.',
      )
      expect(warn).toHaveBeenCalledWith('[oauth] could not read a client metadata document', {
        host: 'claude.ai', error: 'getaddrinfo ENOTFOUND claude.ai (lane guard: claude.ai:443 blocked)',
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('Claude Code’s loopback redirect matches on any port', async () => {
    const url = 'https://claude.ai/oauth/claude-code-client-metadata'
    __clientTest.useFetcher(async () => ({ client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] }))
    const valid = await validateAuthorize({ ...authorizeParams(verifier()), client_id: url, redirect_uri: 'http://localhost:53682/callback' })
    expect(valid.redirectUri).toBe('http://localhost:53682/callback')
  })
})

describe('MCP.5 — the authorization request', () => {
  it('an unknown redirect is never followed: the error stays on the page', async () => {
    const work = validateAuthorize({ ...authorizeParams(verifier()), redirect_uri: 'https://evil.example/cb' })
    await expect(work).rejects.toMatchObject({ error: 'invalid_request', redirectTo: undefined })
  })

  it('after the redirect is known good, errors go back to the app with the state', async () => {
    const work = validateAuthorize({ ...authorizeParams(verifier()), code_challenge_method: 'plain' })
    const error = (await work.catch((e) => e)) as OAuthError
    const back = new URL(error.redirectTo!)
    expect(back.searchParams.get('error')).toBe('invalid_request')
    expect(back.searchParams.get('state')).toBe('state-123')
    expect(back.searchParams.get('iss')).toBe('https://web.example.test')
  })

  it('refuses a token for any server but this MCP URL', async () => {
    await expectOAuthError(validateAuthorize({ ...authorizeParams(verifier()), resource: 'https://other.example/mcp' }), 'invalid_target')
  })

  it('shows the app, where it returns, and only businesses the person may connect', async () => {
    const view = await checkAuthorize(userId, authorizeParams(verifier()))
    expect(view).toMatchObject({ clientName: 'Claude', redirectHost: 'claude.ai', loopback: false, mfaEnrolled: true })
    expect(view.businesses).toEqual([{ id: LEGACY_WORKSPACE_ID, name: expect.any(String), canConnect: true }])
    const limited = await checkAuthorize(noAiUserId, authorizeParams(verifier()))
    expect(limited.businesses[0]!.canConnect).toBe(false)
  })
})

describe('MCP.5 — consent', () => {
  it('needs the person’s fresh 2FA code, once', async () => {
    const pkce = verifier()
    await expectOAuthError(
      consent({ userId, params: authorizeParams(pkce), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: '000000' }),
      'mfa_invalid',
    )
    const fresh = code()
    await consent({ userId, params: authorizeParams(pkce), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: fresh })
    await expectOAuthError(
      consent({ userId, params: authorizeParams(pkce), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: fresh }),
      'mfa_invalid',
    )
  })

  it('only for a business where the person may use the assistant', async () => {
    await expectOAuthError(
      consent({ userId: noAiUserId, params: authorizeParams(verifier()), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: code() }),
      'access_denied',
    )
    __stepUpTest.reset()
    await expectOAuthError(
      consent({ userId, params: authorizeParams(verifier()), decision: 'approve', workspaceId: OTHER_BUSINESS, code: code() }),
      'access_denied',
    )
  })

  it('declining sends the app access_denied', async () => {
    const { redirectTo } = await consent({ userId, params: authorizeParams(verifier()), decision: 'deny' })
    expect(new URL(redirectTo).searchParams.get('error')).toBe('access_denied')
  })

  it('approving returns a code with the state and issuer, and audits the connection', async () => {
    const { url } = await connect()
    expect(url.origin + url.pathname).toBe(CALLBACK)
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('iss')).toBe('https://web.example.test')
    const audit = await database.client.workspaceAudit.findFirst({ where: { action: 'oauth.connected', actorUserId: userId } })
    expect(audit?.metadata).toMatchObject({ app: 'Claude', scopes: ['nexus.read', 'nexus.write'] })
  })
})

describe('MCP.5 — tokens', () => {
  it('a code is swapped once, with its verifier; a second try ends the connection', async () => {
    const pkce = verifier()
    const { redirectTo } = await consent({ userId, params: authorizeParams(pkce), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: code() })
    const theCode = new URL(redirectTo).searchParams.get('code')!
    const form = { grant_type: 'authorization_code', code: theCode, client_id: clientId, redirect_uri: CALLBACK, resource: RESOURCE }
    await expectOAuthError(exchangeCode({ ...form, code_verifier: verifier() }), 'invalid_grant')
    // That wrong verifier already burned the code: even the right one fails now.
    await expectOAuthError(exchangeCode({ ...form, code_verifier: pkce }), 'invalid_grant')
    const grant = await database.client.oAuthGrant.findFirst({ where: { userId, workspaceId: LEGACY_WORKSPACE_ID } })
    expect(grant?.revokeReason).toBe('code_reuse')
  })

  it('an access token opens /mcp for that person, business and their permissions', async () => {
    const { tokens } = await connect()
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'nexus.read nexus.write' })
    const access = await verifyAccessToken(tokens.access_token)
    expect(access).toMatchObject({ userId, label: 'Awais', scopes: ['nexus.read', 'nexus.write'] })
    expect(access!.workspace.workspaceId).toBe(LEGACY_WORKSPACE_ID)
    expect(access!.permissions.permissions.has('ai.run')).toBe(true)
    expect(await verifyAccessToken(tokens.refresh_token)).toBeNull()
    expect(await verifyAccessToken('nxm_at_not-a-token')).toBeNull()
  })

  it('a refresh token works once; a second use ends the whole connection', async () => {
    const { tokens } = await connect()
    const told = await revokedNoticeCount()
    const next = await refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
    expect(await verifyAccessToken(next.access_token)).not.toBeNull()
    // W4-3 — the new access token made a call, so the second use is no retry (that case is below).
    await expectOAuthError(
      refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }),
      'invalid_grant',
    )
    expect(await verifyAccessToken(next.access_token)).toBeNull()
    const grant = await database.client.oAuthGrant.findFirst({ where: { userId, workspaceId: LEGACY_WORKSPACE_ID } })
    expect(grant?.revokeReason).toBe('refresh_reuse')
    // W4-2 — the person hears it at once: one danger notice in their bell (in the connection's business) and one e-mail.
    expect(await revokedNoticeCount()).toBe(told + 1)
    const [notice] = await revokedNotices()
    expect(notice).toMatchObject({ severity: 'danger', href: '/settings/security', workspaceId: LEGACY_WORKSPACE_ID, meta: { grantId: grant!.id, reason: 'refresh_reuse' } })
    const email = (await database.client.userProfile.findUniqueOrThrow({ where: { id: userId } })).email
    expect(mail.sent.at(-1)).toMatchObject({ to: [email], subject: expect.stringMatching(/ended your Claude connection/) })
    // Presented once more, the connection is already ended: nothing is said again.
    const sent = mail.sent.length
    await expectOAuthError(refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }), 'invalid_grant')
    expect(await revokedNoticeCount()).toBe(told + 1)
    expect(mail.sent).toHaveLength(sent)
  })

  it('a refresh cannot widen what the person approved', async () => {
    const pkce = verifier()
    const { redirectTo } = await consent({
      userId, params: authorizeParams(pkce), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: code(), scopes: ['nexus.read'],
    })
    __stepUpTest.reset()
    const tokens = await exchangeCode({
      grant_type: 'authorization_code', code: new URL(redirectTo).searchParams.get('code')!, code_verifier: pkce,
      client_id: clientId, redirect_uri: CALLBACK,
    })
    expect(tokens.scope).toBe('nexus.read')
    await expectOAuthError(
      refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, scope: 'nexus.read nexus.write' }),
      'invalid_scope',
    )
    // MCP.12 — a scope name the grant does not hold is refused too (RFC 6749 §6), not dropped: it used to answer 200
    // with the rest. The refusal names what was granted, never the client's own text.
    const unknown = refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, scope: 'nexus.read nexus.admin' })
    await expectOAuthError(unknown, 'invalid_scope')
    await expect(unknown).rejects.toMatchObject({ description: 'a refresh cannot widen what the person approved (granted: nexus.read)' })
    // Refused before the token is spent: the same refresh token still works, for what was granted.
    const next = await refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, scope: 'nexus.read' })
    expect(next.scope).toBe('nexus.read')
    const again = await refreshTokens({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId })
    expect(again.scope).toBe('nexus.read')
  })

  it('connecting again replaces the connection and ends its old tokens', async () => {
    const first = await connect()
    const second = await connect()
    expect(await verifyAccessToken(first.tokens.access_token)).toBeNull()
    expect(await verifyAccessToken(second.tokens.access_token)).not.toBeNull()
    expect(await database.client.oAuthGrant.count({ where: { userId, workspaceId: LEGACY_WORKSPACE_ID } })).toBe(1)
  })

  it('revoking the refresh token disconnects the app', async () => {
    const { tokens } = await connect()
    await revokeToken({ token: tokens.refresh_token, client_id: clientId })
    expect(await verifyAccessToken(tokens.access_token)).toBeNull()
  })

  it('a token stops working the moment the person leaves the business', async () => {
    const { tokens } = await connect()
    expect(await verifyAccessToken(tokens.access_token)).not.toBeNull()
    await database.client.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: LEGACY_WORKSPACE_ID, userId } },
      data: { status: 'removed' },
    })
    try {
      expect(await verifyAccessToken(tokens.access_token)).toBeNull()
      await expectOAuthError(
        refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }),
        'invalid_grant',
      )
    } finally {
      await database.client.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: LEGACY_WORKSPACE_ID, userId } },
        data: { status: 'active' },
      })
    }
  })

  it('a token for another MCP URL is refused', async () => {
    const { tokens } = await connect()
    vi.stubEnv('NEXUS_MCP_RESOURCE', 'https://other.example.test/mcp')
    try {
      expect(await verifyAccessToken(tokens.access_token)).toBeNull()
    } finally {
      vi.stubEnv('NEXUS_MCP_RESOURCE', '')
    }
  })
})

describe('C5 — nexus.run: a person may let Claude run changes set to auto', () => {
  async function scopesGranted(asked: string[]) {
    const pkce = verifier()
    const { redirectTo } = await consent({
      userId, params: authorizeParams(pkce, { scope: 'nexus.read nexus.write nexus.run' }), decision: 'approve',
      workspaceId: LEGACY_WORKSPACE_ID, code: code(), scopes: asked,
    })
    __stepUpTest.reset()
    const tokens = await exchangeCode({
      grant_type: 'authorization_code', code: new URL(redirectTo).searchParams.get('code')!, code_verifier: pkce,
      client_id: clientId, redirect_uri: CALLBACK,
    })
    return { tokens, access: await verifyAccessToken(tokens.access_token) }
  }

  it('is offered, and granted only when the person ticks it', async () => {
    expect((await checkAuthorize(userId, authorizeParams(verifier(), { scope: 'nexus.read nexus.write nexus.run' }))).scopes)
      .toEqual(['nexus.read', 'nexus.write', 'nexus.run'])
    expect((await scopesGranted(['nexus.read', 'nexus.write', 'nexus.run'])).access?.scopes).toEqual(['nexus.read', 'nexus.write', 'nexus.run'])
    expect((await scopesGranted(['nexus.read', 'nexus.write'])).access?.scopes).toEqual(['nexus.read', 'nexus.write'])
  })

  it('without nexus.write it is not granted: running a change needs asking for one', async () => {
    const { tokens, access } = await scopesGranted(['nexus.read', 'nexus.run'])
    expect(tokens.scope).toBe('nexus.read')
    expect(access?.scopes).toEqual(['nexus.read'])
  })

  it('an app that asks for the old two scopes is never offered it', async () => {
    expect((await checkAuthorize(userId, authorizeParams(verifier()))).scopes).toEqual(['nexus.read', 'nexus.write'])
  })
})

describe('C4 — one connection per business: its own MCP URL', () => {
  const OWN = `${RESOURCE}/w/${LEGACY_WORKSPACE_ID}`
  const OTHER = `${RESOURCE}/w/${OTHER_BUSINESS}`

  /** Approve for a business's own URL and swap the code, as Claude would. */
  async function connectTo(resource: string, workspaceId?: string) {
    const pkce = verifier()
    const { redirectTo } = await consent({
      userId,
      params: authorizeParams(pkce, { resource }),
      decision: 'approve',
      ...(workspaceId ? { workspaceId } : {}),
      code: code(),
    })
    __stepUpTest.reset()
    return exchangeCode({
      grant_type: 'authorization_code',
      code: new URL(redirectTo).searchParams.get('code') ?? undefined,
      code_verifier: pkce,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource,
    })
  }

  it('the business’s own URL is a valid target, and it locks the request to that business', async () => {
    expect(mcpResourceFor(LEGACY_WORKSPACE_ID)).toBe(OWN)
    expect(await validateAuthorize(authorizeParams(verifier(), { resource: OWN }))).toMatchObject({ resource: OWN, lockedWorkspaceId: LEGACY_WORKSPACE_ID })
    expect(await validateAuthorize(authorizeParams(verifier()))).toMatchObject({ resource: RESOURCE, lockedWorkspaceId: null })
    // A trailing slash is the same URL; anything else under /w/ is not a business URL.
    expect(await validateAuthorize(authorizeParams(verifier(), { resource: `${OWN}/` }))).toMatchObject({ resource: OWN })
    for (const resource of [`${RESOURCE}/w/`, `${OWN}/more`, `${RESOURCE}/w/bad%20id`, `https://other.example/mcp/w/${LEGACY_WORKSPACE_ID}`]) {
      await expectOAuthError(validateAuthorize(authorizeParams(verifier(), { resource })), 'invalid_target')
    }
  })

  it('the consent page offers only the business the URL names', async () => {
    const view = await checkAuthorize(userId, authorizeParams(verifier(), { resource: OWN }))
    expect(view.lockedWorkspaceId).toBe(LEGACY_WORKSPACE_ID)
    expect(view.businesses).toEqual([{ id: LEGACY_WORKSPACE_ID, name: expect.any(String), canConnect: true }])
    // A business the person does not belong to: locked to it, and nothing they may connect.
    const other = await checkAuthorize(userId, authorizeParams(verifier(), { resource: OTHER }))
    expect(other).toMatchObject({ lockedWorkspaceId: OTHER_BUSINESS, businesses: [] })
    // The plain URL still lets the person pick.
    expect((await checkAuthorize(userId, authorizeParams(verifier()))).lockedWorkspaceId).toBeNull()
  })

  it('consent cannot pick another business than the URL names; without a pick it takes the URL’s', async () => {
    await expectOAuthError(
      consent({ userId, params: authorizeParams(verifier(), { resource: OTHER }), decision: 'approve', workspaceId: LEGACY_WORKSPACE_ID, code: code() }),
      'access_denied',
    )
    __stepUpTest.reset()
    const tokens = await connectTo(OWN)
    const access = await verifyAccessToken(tokens.access_token, OWN)
    expect(access?.workspace.workspaceId).toBe(LEGACY_WORKSPACE_ID)
  })

  it('a token for a business’s URL works there only: not on the plain URL, not on another business’s', async () => {
    const own = await connectTo(OWN, LEGACY_WORKSPACE_ID)
    expect(await verifyAccessToken(own.access_token, OWN)).not.toBeNull()
    expect(await verifyAccessToken(own.access_token)).toBeNull()
    expect(await verifyAccessToken(own.access_token, OTHER)).toBeNull()
    // A refreshed token keeps its URL.
    const next = await refreshTokens({ grant_type: 'refresh_token', refresh_token: own.refresh_token, client_id: clientId })
    expect(await verifyAccessToken(next.access_token, OWN)).not.toBeNull()
    expect(await verifyAccessToken(next.access_token)).toBeNull()
    // The plain URL's token keeps working there, and nowhere else.
    const { tokens: plain } = await connect()
    expect(await verifyAccessToken(plain.access_token)).not.toBeNull()
    expect(await verifyAccessToken(plain.access_token, OWN)).toBeNull()
    // Still one connection per person, business and app (no OAuth table change): connecting the same app to the same
    // business at the plain URL replaced the one at the business's URL, and ended its tokens.
    expect(await verifyAccessToken(next.access_token, OWN)).toBeNull()
  })

  it('NEXUS_MCP_WORKSPACES stays the outer allow-list for a business’s URL', async () => {
    vi.stubEnv('NEXUS_MCP_WORKSPACES', OTHER_BUSINESS)
    try {
      const view = await checkAuthorize(userId, authorizeParams(verifier(), { resource: OWN }))
      expect(view).toMatchObject({ lockedWorkspaceId: LEGACY_WORKSPACE_ID, businesses: [] })
      await expectOAuthError(
        consent({ userId, params: authorizeParams(verifier(), { resource: OWN }), decision: 'approve', code: code() }),
        'access_denied',
      )
    } finally {
      vi.stubEnv('NEXUS_MCP_WORKSPACES', '')
    }
  })
})

describe('W4-3 — a refresh presented again within seconds by the same app, before its answer was used', () => {
  const refresh = (token: string, app = clientId) => refreshTokens({ grant_type: 'refresh_token', refresh_token: token, client_id: app })
  const grantRow = () => database.client.oAuthGrant.findFirstOrThrow({ where: { userId, workspaceId: LEGACY_WORKSPACE_ID } })
  const retries = async () => database.client.workspaceAudit.count({ where: { action: 'oauth.refresh_grace', targetId: (await grantRow()).id } })
  /** Move a token's first use into the past, as if that many seconds went by. */
  const usedSecondsAgo = (token: string, seconds: number) =>
    database.client.oAuthToken.update({ where: { tokenHash: hashToken(token) }, data: { usedAt: new Date(Date.now() - seconds * 1000) } })

  async function expectConnectionEnded(replay: Promise<unknown>, accessTokens: string[]) {
    await expectOAuthError(replay, 'invalid_grant')
    expect((await grantRow()).revokeReason).toBe('refresh_reuse')
    for (const token of accessTokens) expect(await verifyAccessToken(token)).toBeNull()
  }

  it('gets a new pair: the unused pair of the first answer ends, the connection stays, and it is audited and logged', async () => {
    const { tokens } = await connect()
    const before = await retries()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const lost = await refresh(tokens.refresh_token) // the answer that never reached the app
      await usedSecondsAgo(tokens.refresh_token, 110)
      const retried = await refresh(tokens.refresh_token)
      expect(retried.refresh_token).not.toBe(lost.refresh_token)
      expect(await verifyAccessToken(lost.access_token)).toBeNull()
      expect(await verifyAccessToken(retried.access_token)).not.toBeNull()
      expect((await grantRow()).revokedAt).toBeNull()
      // The new pair goes on as usual.
      expect(await verifyAccessToken((await refresh(retried.refresh_token)).access_token)).not.toBeNull()

      const grantId = (await grantRow()).id
      expect(await retries()).toBe(before + 1)
      const audit = await database.client.workspaceAudit.findFirst({ where: { action: 'oauth.refresh_grace', targetId: grantId }, orderBy: { createdAt: 'desc' } })
      expect(audit).toMatchObject({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, metadata: { reason: 'refresh_retry', ended: 2 } })
      expect((audit?.metadata as { secondsAfterFirstUse: number }).secondsAfterFirstUse).toBeGreaterThanOrEqual(110)
      expect(warn).toHaveBeenCalledWith(
        '[oauth] a refresh token was presented again within the grace window: its unused tokens ended, a new pair was issued',
        expect.objectContaining({ grantId, reason: 'refresh_retry', ended: 2 }),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('after the first answer’s access token made a call, it is a stolen copy: the connection ends', async () => {
    const { tokens } = await connect()
    const first = await refresh(tokens.refresh_token)
    expect(await verifyAccessToken(first.access_token)).not.toBeNull()
    await expectConnectionEnded(refresh(tokens.refresh_token), [first.access_token])
  })

  it('after the first answer’s refresh token was used, it is a stolen copy: the connection ends', async () => {
    const { tokens } = await connect()
    const first = await refresh(tokens.refresh_token)
    const second = await refresh(first.refresh_token)
    await expectConnectionEnded(refresh(tokens.refresh_token), [first.access_token, second.access_token])
  })

  it('after the window, it is a stolen copy: the connection ends', async () => {
    const { tokens } = await connect()
    const first = await refresh(tokens.refresh_token)
    await usedSecondsAgo(tokens.refresh_token, 121)
    const before = await retries()
    await expectConnectionEnded(refresh(tokens.refresh_token), [first.access_token])
    expect(await retries()).toBe(before)
  })

  it('another app gets no second answer: refused before the retry check, as before W4-3', async () => {
    const otherApp = String((await registerClient({ client_name: 'Claude', redirect_uris: [CALLBACK] })).client_id)
    const { tokens } = await connect()
    const first = await refresh(tokens.refresh_token)
    const before = await retries()
    await expectOAuthError(refresh(tokens.refresh_token, otherApp), 'invalid_grant')
    expect(await retries()).toBe(before)
    expect(await verifyAccessToken(first.access_token)).not.toBeNull()
    // Its own app presenting it again now, after that call, is a stolen copy.
    await expectConnectionEnded(refresh(tokens.refresh_token), [first.access_token])
  })

  it('a normal refresh is unchanged: a new pair from the spent token, and no retry record', async () => {
    const { tokens } = await connect()
    const before = await retries()
    const next = await refresh(tokens.refresh_token)
    const spent = await database.client.oAuthToken.findUniqueOrThrow({ where: { tokenHash: hashToken(tokens.refresh_token) } })
    expect(spent.usedAt).not.toBeNull()
    const child = await database.client.oAuthToken.findUniqueOrThrow({ where: { tokenHash: hashToken(next.refresh_token) } })
    expect(child).toMatchObject({ parentId: spent.id, usedAt: null, revokedAt: null })
    expect(await verifyAccessToken(next.access_token)).not.toBeNull()
    expect(await verifyAccessToken(tokens.access_token)).not.toBeNull()
    // The first call is kept on the access token: that is what closes the retry for its parent.
    expect((await database.client.oAuthToken.findUniqueOrThrow({ where: { tokenHash: hashToken(next.access_token) } })).usedAt).not.toBeNull()
    expect(await retries()).toBe(before)
  })

  const reuseRevocations = async () =>
    database.client.workspaceAudit.count({ where: { action: 'oauth.revoked', targetId: (await grantRow()).id, metadata: { path: ['reason'], equals: 'refresh_reuse' } } })

  it('a refresh token the retry ended, presented later, is a stolen copy: the connection ends, the retried pair too', async () => {
    const { tokens } = await connect()
    const lost = await refresh(tokens.refresh_token)
    const retried = await refresh(tokens.refresh_token)
    const before = await reuseRevocations()
    const toldBefore = await revokedNoticeCount()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const late = refresh(lost.refresh_token)
      await expect(late).rejects.toMatchObject({ error: 'invalid_grant', description: 'refresh token already used; the connection was revoked' })
      expect((await grantRow()).revokeReason).toBe('refresh_reuse')
      expect(await verifyAccessToken(retried.access_token)).toBeNull()
      await expectOAuthError(refresh(retried.refresh_token), 'invalid_grant')
      expect(await reuseRevocations()).toBe(before + 1)
      const audit = await database.client.workspaceAudit.findFirst({ where: { action: 'oauth.revoked', targetId: (await grantRow()).id }, orderBy: { createdAt: 'desc' } })
      expect(audit?.metadata).toEqual({ reason: 'refresh_reuse', endedByRetry: true })
      // W4-2 — and the person is told, once.
      expect(await revokedNoticeCount()).toBe(toldBefore + 1)
      expect((await revokedNotices())[0].meta).toMatchObject({ grantId: (await grantRow()).id, reason: 'refresh_reuse', endedByRetry: true })
      expect(warn).toHaveBeenCalledWith('[oauth] a refresh token a retry had ended was presented again: the connection was revoked', { grantId: (await grantRow()).id })
    } finally {
      warn.mockRestore()
    }
  })

  it('a refresh token the app revoked (RFC 7009), presented again, is refused as before: no reuse revocation', async () => {
    const { tokens } = await connect()
    const next = await refresh(tokens.refresh_token)
    await revokeToken({ token: next.refresh_token, client_id: clientId })
    const before = await reuseRevocations()
    await expect(refresh(next.refresh_token)).rejects.toMatchObject({ error: 'invalid_grant', description: 'connection revoked' })
    expect((await grantRow()).revokeReason).toBe('client_revoked')
    expect(await reuseRevocations()).toBe(before)
  })

  it('tokens a reconnect ended are refused as before ("connection revoked"); the new connection lives', async () => {
    const unrefreshed = await connect() // a first pair: no parent, never used
    const second = await connect()
    await refresh(second.tokens.refresh_token)
    const retried = await refresh(second.tokens.refresh_token) // the newest refresh child: only older siblings
    const latest = await connect()
    const before = await reuseRevocations()
    for (const token of [unrefreshed.tokens.refresh_token, retried.refresh_token]) {
      await expect(refresh(token)).rejects.toMatchObject({ error: 'invalid_grant', description: 'connection revoked' })
    }
    expect((await grantRow()).revokedAt).toBeNull()
    expect(await reuseRevocations()).toBe(before)
    expect(await verifyAccessToken(latest.tokens.access_token)).not.toBeNull()
  })
})
