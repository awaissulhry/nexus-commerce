/**
 * Phase S1 (auth core) — Fastify auth guards.
 *
 * S1 stands up the auth system and protects ITS OWN new endpoints. It
 * does NOT flip the whole API to deny-by-default — that global sweep is
 * S2 (RBAC engine), sequenced deliberately so the app keeps working
 * while auth rolls out. So here we ship:
 *   • loadSession   — reads the cookie, validates, attaches req.authUser
 *                     (never rejects; safe to run anywhere).
 *   • requireAuth   — 401 unless a valid session is present.
 *   • requireOwner  — requireAuth + the OWNER role (the only role that
 *                     exists in S1; S2 generalises to requirePermission).
 *   • requireCsrf   — double-submit check for state-changing routes.
 *
 * Request augmentation lives here; it merges with the api-key-hook
 * declaration (both use `declare module 'fastify'`).
 */

import type {
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify'
import { validateSession, type SessionUser } from './session.js'
import { verifyCsrf } from './csrf.js'
import { sessionCookieName } from './cookies.js'

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: SessionUser
    authSessionId?: string
    authMfaSatisfied?: boolean
    /** Internal: whether loadSession has already run this request. */
    __sessionLoaded?: boolean
  }
}

export const OWNER_ROLE_KEY = 'OWNER'

function rawSessionToken(req: FastifyRequest): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined
  return cookies?.[sessionCookieName()]
}

/**
 * Populate req.authUser from the session cookie. Never rejects — an
 * anonymous request simply ends with req.authUser undefined. Idempotent.
 * Plain function so it can be called both as a hook and inline from the
 * require* guards without Fastify `this`-binding issues.
 */
async function ensureLoaded(req: FastifyRequest): Promise<void> {
  if (req.__sessionLoaded) return
  req.__sessionLoaded = true
  const token = rawSessionToken(req)
  if (!token) return
  const result = await validateSession(token)
  if (result) {
    req.authUser = result.user
    req.authSessionId = result.sessionId
    req.authMfaSatisfied = result.mfaSatisfied
  }
}

/** Preview-safe hook form: attach session, never reject. */
export const loadSession: preHandlerHookHandler = async (req) => {
  await ensureLoaded(req)
}

/** Hard gate: valid session required, else 401. */
export const requireAuth: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  await ensureLoaded(req)
  if (!req.authUser) {
    return reply.code(401).send({ error: 'Authentication required', code: 'unauthenticated' })
  }
}

/** Owner-only gate (S1's coarse admin guard; S2 → requirePermission). */
export const requireOwner: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  await ensureLoaded(req)
  if (!req.authUser) {
    return reply.code(401).send({ error: 'Authentication required', code: 'unauthenticated' })
  }
  if (!req.authUser.roleKeys.includes(OWNER_ROLE_KEY)) {
    return reply.code(403).send({ error: 'Owner access required', code: 'forbidden' })
  }
}

/** CSRF gate for state-changing routes (double-submit cookie). */
export const requireCsrf: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!verifyCsrf(req)) {
    return reply.code(403).send({ error: 'Invalid or missing CSRF token', code: 'csrf_failed' })
  }
}
