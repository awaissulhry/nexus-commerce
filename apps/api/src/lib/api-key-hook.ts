/**
 * Phase G follow-up — Fastify preHandler hooks for API key auth.
 *
 * Two flavours:
 *   • requireApiKeyScope(scope)  — hard gate. Bearer header MUST be
 *     present + valid + carry the named scope. Use on machine-to-
 *     machine endpoints.
 *   • allowApiKeyScope(scope)    — soft gate. Validates when a Bearer
 *     header IS present but lets unauth'd requests fall through
 *     (e.g. for endpoints that the in-browser web UI also hits and
 *     auths via the session / no auth at all in single-tenant mode).
 *     This is the right shape today since the web UI doesn't send
 *     bearer tokens; once Phase I session middleware lands, swap to
 *     requireApiKeyScope.
 *
 * Both attach a typed `request.apiKey` so downstream handlers can
 * see which key authorised the call (useful for per-key rate-limit
 * windows + audit metadata later).
 */

import type {
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify'
import { verifyApiKey } from './api-key-auth.js'

// Augment FastifyRequest with the verified-key handle so route
// handlers can read it without `(req as any)`.
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      id: string
      label: string
      scopes: string[]
    }
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  missing: 401,
  malformed: 400,
  unknown: 401,
  revoked: 401,
  expired: 401,
  rotated: 401,
  scope_denied: 403,
  ip_denied: 403,
}

function extractBearer(req: FastifyRequest): string | null {
  const raw = req.headers['authorization']
  if (!raw) return null
  const header = Array.isArray(raw) ? raw[0] : raw
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

/**
 * Hard gate — Bearer required. Returns 401 if missing.
 *
 * Usage:
 *   fastify.get(
 *     '/api/some-endpoint',
 *     { preHandler: requireApiKeyScope('products:read') },
 *     handler,
 *   )
 */
export function requireApiKeyScope(scope: string): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = extractBearer(req)
    if (!raw) {
      return reply.code(401).send({
        error: 'API key required',
        code: 'missing',
        hint: 'Pass an `Authorization: Bearer nxk_…` header.',
      })
    }
    const r = await verifyApiKey({
      rawKey: raw,
      requiredScope: scope,
      requestIp: req.ip ?? '',
    })
    if (r.ok === false) {
      return reply.code(STATUS_BY_CODE[r.code] ?? 401).send({
        error: r.message,
        code: r.code,
      })
    }
    req.apiKey = { id: r.keyId, label: r.label, scopes: r.scopes }
  }
}

/**
 * Soft gate — Bearer optional. If present, MUST be valid + carry
 * the scope; if absent, the request falls through unauth'd.
 *
 * This is the right shape today: the web UI calls /api/* without a
 * Bearer header, and we don't want to lock it out while we roll
 * API key enforcement across the route surface. Once session auth
 * lands (Phase I), each route's `allowApiKeyScope` swaps to
 * `requireApiKeyScope` (or sits behind a session-or-key gate).
 */
export function allowApiKeyScope(scope: string): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = extractBearer(req)
    if (!raw) return // no header → fall through unauth'd
    const r = await verifyApiKey({
      rawKey: raw,
      requiredScope: scope,
      requestIp: req.ip ?? '',
    })
    if (r.ok === false) {
      // A header WAS present — caller intended to authenticate, so
      // their failure isn't ambiguous. Return the typed error
      // instead of falling through (which would silently treat
      // them as unauth'd).
      return reply.code(STATUS_BY_CODE[r.code] ?? 401).send({
        error: r.message,
        code: r.code,
      })
    }
    req.apiKey = { id: r.keyId, label: r.label, scopes: r.scopes }
  }
}
