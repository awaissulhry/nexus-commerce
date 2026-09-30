/**
 * MCP.6 — Connected apps: see and end the Claude connections that reach Nexus
 * (services/oauth/oauth-grants.ts).
 *
 *   GET  /api/settings/connected-apps                  the person's own, in every business
 *   POST /api/settings/connected-apps/:grantId/revoke  the person ends one of theirs
 *   GET  /api/connected-apps                           this business's, for sessions.manage
 *   POST /api/connected-apps/:grantId/revoke           an admin ends one in this business
 *
 * The personal routes are identity routes (personalSettingsRoute): a signed-in person with 2FA
 * done, and no business. The business routes take their business from the verified workspace
 * hook and check sessions.manage themselves as well, so they hold in RBAC shadow mode too.
 * Every list answers `enabled` (NEXUS_MCP_ENABLED) so the page can say whether Claude can connect
 * at all; none of these routes is switched off with it, because ending access must always work.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { FEATURES } from '@nexus/shared/permissions'
import { requireAuth, requireCsrf } from '../lib/auth/guards.js'
import { assertRequestPermission, requestUserId } from '../lib/auth/request-permission.js'
import { workspaceIdForQuery, WorkspaceError } from '../lib/workspace-context.js'
import { mcpEnabled } from '../services/oauth/oauth-config.js'
import {
  ConnectedAppError,
  listBusinessConnectedApps,
  listMyConnectedApps,
  revokeBusinessConnectedApp,
  revokeMyConnectedApp,
  type BusinessAdmin,
} from '../services/oauth/oauth-grants.js'

type GrantParams = { Params: { grantId: string } }

/** The rule the workspace hook applies to every business route; identity routes skip its copy. */
async function requireMfa(request: FastifyRequest, reply: FastifyReply) {
  const user = request.authUser
  if (user && (user.mfaRequired || user.twoFactorEnabledAt) && request.authMfaSatisfied !== true) {
    return reply.code(403).send({ error: 'Complete two-factor authentication.', code: 'mfa_required' })
  }
}

// After requireAuth, which loads the session when no global hook did (business profiles off).
const signedIn = [requireAuth, requireMfa]
const signedInWrite = [requireAuth, requireMfa, requireCsrf]

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConnectedAppError || error instanceof WorkspaceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code })
  }
  // assertRequestPermission and requestUserId throw a plain Error carrying its status.
  const failure = error as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof failure?.statusCode === 'number' && failure.statusCode >= 400 && failure.statusCode < 500) {
    return reply.code(failure.statusCode).send({ error: String(failure.message), code: String(failure.code ?? 'forbidden') })
  }
  throw error
}

/** The caller, in the business the workspace hook verified (the original business with profiles off). */
async function businessAdmin(request: FastifyRequest): Promise<BusinessAdmin> {
  await assertRequestPermission(request, FEATURES.sessionsManage)
  return {
    userId: requestUserId(request),
    workspaceId: request.workspace?.workspaceId ?? workspaceIdForQuery(),
    permissions: request.__rbacResolved!,
  }
}

const oauthGrantsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
  })

  app.get('/settings/connected-apps', { preHandler: signedIn }, async (request, reply) => {
    try {
      return { enabled: mcpEnabled(), grants: await listMyConnectedApps(request.authUser!.id) }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post<GrantParams>(
    '/settings/connected-apps/:grantId/revoke',
    { preHandler: signedInWrite },
    async (request, reply) => {
      try {
        await revokeMyConnectedApp(request.authUser!.id, request.params.grantId)
        return { ok: true }
      } catch (error) {
        return sendError(reply, error)
      }
    },
  )

  app.get('/connected-apps', { preHandler: signedIn }, async (request, reply) => {
    try {
      return { enabled: mcpEnabled(), grants: await listBusinessConnectedApps(await businessAdmin(request)) }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post<GrantParams>(
    '/connected-apps/:grantId/revoke',
    { preHandler: signedInWrite },
    async (request, reply) => {
      try {
        await revokeBusinessConnectedApp(await businessAdmin(request), request.params.grantId)
        return { ok: true }
      } catch (error) {
        return sendError(reply, error)
      }
    },
  )
}

export default oauthGrantsRoutes
