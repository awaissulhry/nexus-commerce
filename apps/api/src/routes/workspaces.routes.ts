import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { requireAuth, requireCsrf } from '../lib/auth/guards.js'
import { WorkspaceError } from '../lib/workspace-context.js'
import { createWorkspaceService, type WorkspaceListQuery } from '../services/workspace.service.js'

const workspacesRoutes: FastifyPluginAsync = async app => {
  const service = createWorkspaceService(prisma)
  app.addHook('preHandler', requireAuth)
  app.addHook('preHandler', async (request, reply) => {
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return reply.code(503).send({ code: 'profiles_not_enabled', error: 'Business profiles are being prepared.' })
    if (request.authUser && (request.authUser.mfaRequired || request.authUser.twoFactorEnabledAt) && !request.authMfaSatisfied) return reply.code(403).send({ code: 'mfa_required', error: 'Complete two-factor authentication.' })
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) await requireCsrf.call(app, request, reply, () => {})
    reply.header('Cache-Control', 'private, no-store')
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send({ code: error.code, error: error.message })
    throw error
  })

  app.get<{ Querystring: WorkspaceListQuery }>('/workspaces', async request => service.listPage(request.authUser!.id, request.query))
  app.get<{ Querystring: WorkspaceListQuery }>('/workspaces/archived', async request => service.listPage(request.authUser!.id, { ...request.query, status: 'archived' }))
  app.post('/workspaces', async (request, reply) => {
    const workspace = await service.create(request.authUser!.id, request.body)
    return reply.code(201).send({ workspace })
  })
  app.get<{ Params: { id: string } }>('/workspaces/:id', async request => {
    const access = await service.membership(request.authUser!.id, request.params.id)
    return {
      workspace: service.profileSummary(access), roleNames: access.roles.map(({ role }) => role.name),
      isOwner: access.isOwner, permissions: [...access.permissions],
    }
  })
  app.patch<{ Params: { id: string }; Body: { name?: unknown; version?: unknown } }>('/workspaces/:id', async request => ({
    workspace: await service.rename(request.authUser!.id, request.params.id, request.body?.name, request.body?.version),
  }))
  app.get<{ Params: { id: string } }>('/workspaces/:id/members', async request => {
    return service.listMembers(request.authUser!.id, request.params.id)
  })
  app.get<{ Params: { id: string; accountId: string }; Querystring: { destinationId: string } }>('/workspaces/:id/accounts/:accountId/assignment', async request =>
    service.assignAccount(request.authUser!.id, request.params.id, request.params.accountId, request.query))
  app.post<{ Params: { id: string; accountId: string } }>('/workspaces/:id/accounts/:accountId/assignment', async request =>
    service.assignAccount(request.authUser!.id, request.params.id, request.params.accountId, request.body, true))
  app.post<{ Params: { id: string } }>('/workspaces/:id/invitations', async request => service.invite(request.authUser!.id, request.params.id, request.body))
  app.post<{ Params: { id: string; invitationId: string } }>('/workspaces/:id/invitations/:invitationId/revoke', async request => service.revokeInvitation(request.authUser!.id, request.params.id, request.params.invitationId))
  app.post<{ Params: { id: string } }>('/workspaces/:id/archive', async request => service.archive(request.authUser!.id, request.params.id, request.body))
  app.post<{ Params: { id: string } }>('/workspaces/:id/restore', async request => service.restore(request.authUser!.id, request.params.id, request.body))
  app.post<{ Params: { id: string } }>('/workspaces/:id/roles', async request => service.saveRole(request.authUser!.id, request.params.id, request.body))
  app.patch<{ Params: { id: string; roleId: string } }>('/workspaces/:id/roles/:roleId', async request => service.saveRole(request.authUser!.id, request.params.id, request.body, request.params.roleId))
  app.patch<{ Params: { id: string; memberId: string }; Body: { roleIds: string[]; status: 'active' | 'revoked'; version: number } }>('/workspaces/:id/members/:memberId', async request => {
    return service.changeMember(request.authUser!.id, request.params.id, request.params.memberId, request.body ?? {})
  })
}

export default workspacesRoutes
