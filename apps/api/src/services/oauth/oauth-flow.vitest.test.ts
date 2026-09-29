/**
 * MCP.5 — connecting Claude to Nexus, end to end, on a real PostgreSQL with the production schema,
 * grants and business policies (PGlite), business profiles ON, real TOTP codes.
 *
 * The promises: an app registers only Claude's own redirect URIs; a person approves with a fresh,
 * single-use 2FA code for a business where they may use the assistant; the code is swapped once,
 * with its PKCE verifier; a refresh token works once, and a second use ends the connection; every
 * call on /mcp re-checks the token, the connection and the membership.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID } from '../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { generateToken } from '../../lib/auth/tokens.js'
import { __clientTest, registerClient, resolveClient } from './oauth-clients.js'
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
    const next = await refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
    expect(await verifyAccessToken(next.access_token)).not.toBeNull()
    await expectOAuthError(
      refreshTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }),
      'invalid_grant',
    )
    expect(await verifyAccessToken(next.access_token)).toBeNull()
    const grant = await database.client.oAuthGrant.findFirst({ where: { userId, workspaceId: LEGACY_WORKSPACE_ID } })
    expect(grant?.revokeReason).toBe('refresh_reuse')
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
