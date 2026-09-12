import type { FastifyRequest, preHandlerHookHandler } from 'fastify'
import prisma from '../db.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { validateSession } from './auth/session.js'
import { sessionCookieName } from './auth/cookies.js'
import { permissionForRoute, PUBLIC } from './auth/permissions-manifest.js'
import { withWorkspace, WorkspaceError, type WorkspaceContext } from './workspace-context.js'
import { withAuthenticatedUser, personalSettingsRoute } from './auth/identity-context.js'
import { verifyCsrf } from './auth/csrf.js'
import { verifyApiKey } from './api-key-auth.js'
import { LEGACY_WORKSPACE_ID } from './workspace-context.js'
import { publicTokenWorkspace } from './workspace-public-links.js'
import { apiKeyPermission } from './workspace-api-key.js'

declare module 'fastify' {
  interface FastifyRequest { workspace?: WorkspaceContext }
}

export function requestedWorkspace(request: Pick<FastifyRequest, 'headers' | 'query'>): string | undefined {
  const header = request.headers['x-nexus-workspace-id']
  const query = (request.query as Record<string, unknown> | undefined)?.workspaceId
  if ((header !== undefined && typeof header !== 'string') || (query !== undefined && typeof query !== 'string')) throw new WorkspaceError('invalid_workspace', 'Choose a valid business profile.', 400)
  if (header && query && header !== query) throw new WorkspaceError('workspace_mismatch', 'The request names different business profiles.', 400)
  const id = typeof header === 'string' && header ? header : typeof query === 'string' ? query : undefined
  if (id && !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new WorkspaceError('invalid_workspace', 'Choose a valid business profile.', 400)
  return id
}

/** Callback form preserves the verified context through the remaining Fastify lifecycle. */
export function createWorkspaceHook(service: Pick<ReturnType<typeof createWorkspaceService>, 'list' | 'membership'>, loadSession = validateSession): preHandlerHookHandler {
return (request, reply, done) => {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1' || request.method === 'OPTIONS') { done(); return }
  const path = request.routeOptions.url ?? ''
  const control = path === '/api/workspaces' || path.startsWith('/api/workspaces/')
  const isMe = path === '/api/auth/me'
  if (/^\/api\/(?:po\/(?:ack|approve)\/|r\/|advertising\/reporting\/public\/share\/)/.test(path) || path === '/api/email/unsubscribe') {
    try {
      const token = (request.params as { token?: unknown })?.token ?? (request.query as { token?: unknown })?.token ?? (request.body as { token?: unknown })?.token
      const id = publicTokenWorkspace(token)
      reply.header('Cache-Control', 'private, no-store')
      withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, done)
    } catch (error) { void reply.code(404).send({ error: 'This link is invalid.' }) }
    return
  }
  if (path.startsWith('/webhooks/shopify/') || path.startsWith('/api/webhooks/sendcloud') || path.startsWith('/api/api/public/track/')) {
    // The existing handlers still verify their provider secret or exact public token.
    // Environment credentials and old tracking links belong only to the migrated business.
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
    return
  }
  if (control || (!isMe && permissionForRoute(request.method, path) === PUBLIC)) { done(); return }
  void (async () => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (bearer) {
      if (path.startsWith('/api/auth/') || path.startsWith('/api/team/') || personalSettingsRoute(path) || path.startsWith('/api/settings/privacy')) throw new WorkspaceError('session_required', 'Use your login to manage personal or team access.', 403)
      const id = requestedWorkspace(request)
      if (!id) throw new WorkspaceError('workspace_required', 'Include the business profile ID with this API key.', 400)
      const scope: WorkspaceContext = { workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }
      const result = await withWorkspace(scope, () => verifyApiKey({ rawKey: bearer, requestIp: request.ip, requiredScope: null }))
      if (result.ok === false) throw new WorkspaceError(result.code, result.message, result.code === 'scope_denied' || result.code === 'ip_denied' ? 403 : 401)
      const required = permissionForRoute(request.method, path)
      if (!required || !apiKeyPermission(result.scopes, required, request.method)) throw new WorkspaceError('scope_denied', 'This API key does not permit the requested operation.', 403)
      request.apiKey = { id: result.keyId, label: result.label, scopes: result.scopes }
      scope.apiKeyId = result.keyId
      request.__sessionLoaded = true
      request.__rbacResolved = { isOwner: false, permissions: new Set([required]) }
      request.workspace = scope
      reply.header('X-Nexus-Workspace-Id', id)
      reply.header('Cache-Control', 'private, no-store')
      withWorkspace(scope, done)
      return
    }
    if (!request.__sessionLoaded) {
      request.__sessionLoaded = true
      const session = await loadSession(request.cookies?.[sessionCookieName()])
      if (session) {
        request.authUser = session.user
        request.authSessionId = session.sessionId
        request.authMfaSatisfied = session.mfaSatisfied
      }
    }
    if (!request.authUser) throw new WorkspaceError('unauthenticated', 'Sign in to continue.', 401)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !verifyCsrf(request)) throw new WorkspaceError('csrf_failed', 'Refresh this page and try again.', 403)
    if (personalSettingsRoute(path)) { withAuthenticatedUser(request.authUser.id, done); return }
    if (!isMe && (request.authUser.mfaRequired || request.authUser.twoFactorEnabledAt) && !request.authMfaSatisfied) throw new WorkspaceError('mfa_required', 'Complete two-factor authentication.', 403)
    let id = requestedWorkspace(request)
    if (!id) {
      const profiles = await service.list(request.authUser.id, 2)
      if (profiles.length === 1) id = profiles[0].id
      else if (isMe) {
        // Login identity remains available before the business picker has a selection.
        request.authUser = { ...request.authUser, roleKeys: [] }
        withAuthenticatedUser(request.authUser.id, done)
        return
      } else throw new WorkspaceError('workspace_required', 'Select a business profile.', 400)
    }
    const access = await service.membership(request.authUser.id, id)
    request.workspace = { ...access.context, sessionId: request.authSessionId }
    request.authUser = { ...request.authUser, roleKeys: access.roleKeys }
    request.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
    reply.header('X-Nexus-Workspace-Id', id)
    reply.header('Cache-Control', 'private, no-store')
    withAuthenticatedUser(request.authUser.id, () => withWorkspace(request.workspace!, done))
  })().catch((error: unknown) => {
    if (error instanceof WorkspaceError) {
      void reply.code(error.statusCode).send({ error: error.message, code: error.code })
      return
    }
    done(error instanceof Error ? error : new Error('Business profile access could not be verified.'))
  })
}
}
export const workspaceHook = createWorkspaceHook(createWorkspaceService(prisma))
