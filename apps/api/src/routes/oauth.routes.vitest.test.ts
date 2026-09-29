/**
 * MCP.5 — the OAuth routes as Claude and the consent page reach them: off unless switched on,
 * form-encoded token requests, answers that are never cached, RFC error bodies, and the consent
 * routes closed to anyone without a signed-in, 2FA-satisfied session.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/auth/guards.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    const who = request.headers['x-test-user']
    if (!who) return reply.code(401).send({ error: 'unauthenticated' })
    request.authUser = { id: who, twoFactorEnabledAt: new Date(), mfaRequired: false }
    request.authMfaSatisfied = request.headers['x-test-mfa'] !== 'no'
  },
  requireCsrf: async () => undefined,
}))
vi.mock('../services/oauth/oauth-server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/oauth/oauth-server.js')>()
  return {
    ...real,
    exchangeCode: vi.fn(),
    refreshTokens: vi.fn(),
    revokeToken: vi.fn(),
    checkAuthorize: vi.fn(),
    consent: vi.fn(),
  }
})
vi.mock('../services/oauth/oauth-clients.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/oauth/oauth-clients.js')>()
  return { ...real, registerClient: vi.fn(async () => ({ client_id: 'nxc_1' })) }
})

import oauthRoutes from './oauth.routes.js'
import { consent, exchangeCode, OAuthError, checkAuthorize } from '../services/oauth/oauth-server.js'

let app: FastifyInstance

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_MCP_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', 'https://api.example.test')
  app = Fastify()
  await app.register(oauthRoutes)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.unstubAllEnvs()
})

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
})

describe('MCP.5 — OAuth routes', () => {
  it('answer 404 while MCP is off', async () => {
    vi.stubEnv('NEXUS_MCP_ENABLED', '')
    expect((await app.inject({ method: 'GET', url: '/api/oauth/metadata' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/oauth/token', ...form({ grant_type: 'x' }) })).statusCode).toBe(404)
  })

  it('serve the authorization server metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/metadata' })
    expect(res.json()).toMatchObject({ issuer: 'https://web.example.test', code_challenge_methods_supported: ['S256'] })
  })

  it('read a form-encoded token request, and never let the answer be cached', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({ access_token: 'a', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r', scope: 'nexus.read' })
    const res = await app.inject({
      method: 'POST', url: '/api/oauth/token',
      ...form({ grant_type: 'authorization_code', code: 'c1', code_verifier: 'v1', client_id: 'nxc_1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }),
    })
    expect(res.statusCode).toBe(200)
    expect(exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ grant_type: 'authorization_code', code: 'c1', code_verifier: 'v1' }))
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.pragma).toBe('no-cache')
  })

  it('answer OAuth errors in the RFC shape', async () => {
    const unsupported = await app.inject({ method: 'POST', url: '/api/oauth/token', ...form({ grant_type: 'password' }) })
    expect(unsupported.statusCode).toBe(400)
    expect(unsupported.json()).toMatchObject({ error: 'unsupported_grant_type' })
    vi.mocked(exchangeCode).mockRejectedValue(new OAuthError('invalid_grant', 'code expired'))
    const expired = await app.inject({ method: 'POST', url: '/api/oauth/token', ...form({ grant_type: 'authorization_code' }) })
    expect(expired.json()).toEqual({ error: 'invalid_grant', error_description: 'code expired' })
  })

  it('register a client with 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ client_id: 'nxc_1' })
  })

  it('consent needs a signed-in person, with 2FA satisfied, and a clear decision', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/oauth/consent', payload: { decision: 'approve' } })).statusCode).toBe(401)
    const noMfa = await app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { 'x-test-user': 'u1', 'x-test-mfa': 'no' }, payload: { decision: 'approve' } })
    expect(noMfa.json()).toMatchObject({ error: 'mfa_required' })
    const unclear = await app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { 'x-test-user': 'u1' }, payload: { decision: 'maybe' } })
    expect(unclear.statusCode).toBe(400)
    vi.mocked(consent).mockResolvedValue({ redirectTo: 'https://claude.ai/api/mcp/auth_callback?code=x' })
    const ok = await app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { 'x-test-user': 'u1' }, payload: { decision: 'approve', workspaceId: 'w1', code: '123456' } })
    expect(ok.json()).toEqual({ redirectTo: 'https://claude.ai/api/mcp/auth_callback?code=x' })
    expect(consent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', decision: 'approve', workspaceId: 'w1', code: '123456' }))
  })

  it('the consent page’s check hands back where to send an error', async () => {
    vi.mocked(checkAuthorize).mockRejectedValue(new OAuthError('invalid_request', 'PKCE is required', 400, 'https://claude.ai/cb?error=invalid_request'))
    const res = await app.inject({ method: 'GET', url: '/api/oauth/authorize/check?client_id=x', headers: { 'x-test-user': 'u1' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_request', error_description: 'PKCE is required', redirectTo: 'https://claude.ai/cb?error=invalid_request' })
  })
})
