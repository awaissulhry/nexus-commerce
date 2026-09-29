/**
 * MCP.5 — the OAuth 2.1 endpoints for connecting Claude to Nexus (services/oauth/oauth-server.ts).
 *
 *   GET  /api/oauth/metadata          RFC 8414 metadata; the web app serves it at the issuer's
 *                                     /.well-known/oauth-authorization-server
 *   POST /api/oauth/register          RFC 7591 dynamic registration (JSON)
 *   POST /api/oauth/token             authorization_code and refresh_token (form-encoded)
 *   POST /api/oauth/revoke            RFC 7009 (form-encoded)
 *   GET  /api/oauth/authorize/check   the consent page reads the request (signed-in person)
 *   POST /api/oauth/consent           the person approves or declines (signed-in, CSRF, fresh 2FA)
 *
 * All are PUBLIC in the RBAC manifest, like /api/auth/*: the first four are called by Claude,
 * which has no session, and the last two guard themselves (session, 2FA, CSRF). None binds a
 * business from a header; the consent names its business and checks the membership itself.
 * Everything answers 404 unless NEXUS_MCP_ENABLED=1.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth, requireCsrf } from '../lib/auth/guards.js'
import { authorizationServerMetadata, mcpEnabled } from '../services/oauth/oauth-config.js'
import { OAuthClientError, registerClient } from '../services/oauth/oauth-clients.js'
import {
  checkAuthorize,
  consent,
  exchangeCode,
  OAuthError,
  refreshTokens,
  revokeToken,
  type AuthorizeParams,
} from '../services/oauth/oauth-server.js'

type Form = Record<string, string | undefined>

function sendOAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof OAuthError) {
    return reply.code(error.status).send({
      error: error.error,
      error_description: error.description,
      ...(error.redirectTo ? { redirectTo: error.redirectTo } : {}),
    })
  }
  if (error instanceof OAuthClientError) {
    return reply.code(400).send({ error: error.code, error_description: error.message })
  }
  throw error
}

/** Token answers are never cached (RFC 6749 §5.1). */
function noStore(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')
}

/** The same rule the workspace hook applies to every other signed-in route. */
function mfaSatisfied(request: FastifyRequest): boolean {
  const user = request.authUser
  return !user || !(user.mfaRequired || user.twoFactorEnabledAt) || request.authMfaSatisfied === true
}

const oauthRoutes: FastifyPluginAsync = async (fastify) => {
  // OAuth clients send form-encoded bodies (RFC 6749 §4.1.3). Scoped to this plugin only.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    },
  )

  fastify.addHook('onRequest', async (_request, reply) => {
    if (!mcpEnabled()) return reply.code(404).send({ error: 'Not found' })
  })

  fastify.get('/api/oauth/metadata', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300')
    return authorizationServerMetadata()
  })

  fastify.post<{ Body: unknown }>(
    '/api/oauth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      noStore(reply)
      try {
        return reply.code(201).send(await registerClient(request.body))
      } catch (error) {
        return sendOAuthError(reply, error)
      }
    },
  )

  fastify.post<{ Body: Form }>(
    '/api/oauth/token',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply)
      const form = (request.body && typeof request.body === 'object' ? request.body : {}) as Form
      try {
        if (form.grant_type === 'authorization_code') return await exchangeCode(form)
        if (form.grant_type === 'refresh_token') return await refreshTokens(form)
        throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
      } catch (error) {
        return sendOAuthError(reply, error)
      }
    },
  )

  fastify.post<{ Body: Form }>(
    '/api/oauth/revoke',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply)
      try {
        await revokeToken((request.body ?? {}) as Form)
        return reply.code(200).send({})
      } catch (error) {
        return sendOAuthError(reply, error)
      }
    },
  )

  fastify.get<{ Querystring: AuthorizeParams }>(
    '/api/oauth/authorize/check',
    { preHandler: requireAuth },
    async (request, reply) => {
      noStore(reply)
      if (!mfaSatisfied(request)) return reply.code(403).send({ error: 'mfa_required', error_description: 'Complete two-factor authentication.' })
      try {
        return await checkAuthorize(request.authUser!.id, request.query ?? {})
      } catch (error) {
        return sendOAuthError(reply, error)
      }
    },
  )

  fastify.post<{
    Body: { params?: AuthorizeParams; decision?: string; workspaceId?: unknown; scopes?: unknown; code?: unknown }
  }>(
    '/api/oauth/consent',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      noStore(reply)
      if (!mfaSatisfied(request)) return reply.code(403).send({ error: 'mfa_required', error_description: 'Complete two-factor authentication.' })
      const body = request.body ?? {}
      const decision = body.decision === 'deny' ? 'deny' : body.decision === 'approve' ? 'approve' : null
      if (!decision) return reply.code(400).send({ error: 'invalid_request', error_description: 'decision must be approve or deny' })
      try {
        return await consent({
          userId: request.authUser!.id,
          params: body.params ?? {},
          decision,
          workspaceId: body.workspaceId,
          scopes: body.scopes,
          code: body.code,
        })
      } catch (error) {
        return sendOAuthError(reply, error)
      }
    },
  )
}

export default oauthRoutes
