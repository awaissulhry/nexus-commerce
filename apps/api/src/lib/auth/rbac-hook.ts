/**
 * Phase S2 (RBAC engine) — the one global gate.
 *
 * A single preHandler resolves EVERY request against the route→permission
 * manifest. This is deny-by-default: a route with no manifest entry is
 * refused (and the rbac-coverage CI test fails, so it can't ship).
 *
 * Rollout is staged via NEXUS_RBAC_MODE (docs/security/S0-AUDIT.md §2):
 *   • shadow  (default) — resolve + LOG what would be denied, but allow the
 *     request. Lets us validate the whole map against real traffic while
 *     the web app is still unauthenticated (login/credentialed client are
 *     S3). No user-visible change.
 *   • enforce — actually 401/403 + audit the denial. Flipped in S3 once the
 *     web authenticates.
 *
 * Route-level guards from S1 (requireAuth/requireOwner on /api/auth/*) keep
 * enforcing regardless of mode, so the auth surface is never weakened while
 * in shadow.
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { permissionForRoute, PUBLIC } from './permissions-manifest.js'
import { resolvePermissions, hasPermission } from './rbac.js'
import { validateSession } from './session.js'
import { sessionCookieName } from './cookies.js'
import { truncateIp } from './session.js'
import { writeAuthAudit } from './audit.js'

function mode(): 'shadow' | 'enforce' {
  return process.env.NEXUS_RBAC_MODE === 'enforce' ? 'enforce' : 'shadow'
}

export async function rbacHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const method = req.method.toUpperCase()
  // CORS preflight is handled by @fastify/cors; never gate it.
  if (method === 'OPTIONS') return

  const pattern = req.routeOptions?.url
  if (!pattern) return // no matched route → Fastify's 404 path, nothing to gate

  const required = permissionForRoute(method, pattern)
  if (required === PUBLIC) return // intentionally unauthenticated

  // Attach the session once (idempotent with the S1 guards).
  if (!req.__sessionLoaded) {
    req.__sessionLoaded = true
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[sessionCookieName()]
    const s = token ? await validateSession(token) : null
    if (s) {
      req.authUser = s.user
      req.authSessionId = s.sessionId
      req.authMfaSatisfied = s.mfaSatisfied
    }
  }

  // Decide.
  let deny: { status: number; code: string; reason: string } | null = null
  if (required === null) {
    // Unmapped route — deny by default. (CI keeps this from ever happening
    // in practice; this is the runtime backstop.)
    deny = { status: 403, code: 'route_unmapped', reason: 'route has no permission mapping' }
  } else if (!req.authUser) {
    deny = { status: 401, code: 'unauthenticated', reason: 'no valid session' }
  } else {
    const resolved = await resolvePermissions(req.authUser)
    req.__rbacResolved = resolved // reused by the financial field filter
    if (!hasPermission(resolved, required)) {
      deny = { status: 403, code: 'forbidden', reason: `missing ${required}` }
    }
  }

  if (!deny) return // allowed

  if (mode() === 'enforce') {
    await writeAuthAudit({
      actorUserId: req.authUser?.id ?? null,
      ip: truncateIp(req.ip),
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 256) ?? null,
      entityType: 'Auth',
      entityId: `${method} ${pattern}`,
      action: 'access.denied',
      metadata: { required, code: deny.code, reason: deny.reason },
    })
    return reply.code(deny.status).send({ error: 'Access denied', code: deny.code, required })
  }

  // shadow mode — allow, but log the MEANINGFUL would-be denials only.
  // Pre-S3 the web sends no session, so "unauthenticated" is the norm for
  // every request and logging it is pure noise; the useful signal is an
  // authenticated user who lacks a permission (a real mapping gap) or an
  // unmapped route (a CI backstop). Stay silent on plain unauthenticated.
  if (deny.code !== 'unauthenticated') {
    req.log.warn(
      { rbac: 'shadow-deny', method, route: pattern, required, userId: req.authUser?.id ?? null, reason: deny.reason },
      '[rbac-shadow] would deny',
    )
  }
}
