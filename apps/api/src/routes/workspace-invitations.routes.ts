import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { WorkspaceError } from '../lib/workspace-context.js'
import { requireCsrf, loadSession } from '../lib/auth/guards.js'
import { checkPasswordStrength, hashPassword } from '../lib/auth/password.js'
import { createSession } from '../lib/auth/session.js'
import { sessionCookieName, sessionCookieOptions } from '../lib/auth/cookies.js'

const workspaceInvitationsRoutes: FastifyPluginAsync = async app => {
  const service = createWorkspaceService(prisma)
  app.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return reply.code(503).send({ error: 'Business profiles are being prepared.' })
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send({ code: error.code, error: error.message })
    throw error
  })
  app.post<{ Body: { token?: unknown } }>('/api/auth/workspace-invitations/preview', async request => {
    return service.invitationPreview(request.body?.token)
  })
  app.post<{ Body: { token?: unknown; displayName?: unknown; password?: unknown } }>('/api/auth/workspace-invitations/accept', { preHandler: [loadSession, requireCsrf], config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    if (request.authUser && (request.authUser.mfaRequired || request.authUser.twoFactorEnabledAt) && !request.authMfaSatisfied) throw new WorkspaceError('mfa_required', 'Complete two-factor authentication before accepting the invitation.', 403)
    let registration: { displayName: string; passwordHash: string } | undefined
    if (!request.authUser) {
      const invitation = await service.invitationPreview(request.body?.token)
      if (invitation.signInRequired) throw new WorkspaceError('sign_in_required', 'Sign in with the invited email address to accept this invitation.', 401)
      const displayName = typeof request.body.displayName === 'string' ? request.body.displayName.trim() : ''
      const password = typeof request.body.password === 'string' ? request.body.password : ''
      if (displayName.length < 2 || displayName.length > 100) throw new WorkspaceError('invalid_name', 'Enter your name (2–100 characters).', 400)
      const strength = checkPasswordStrength(password, [invitation.email, displayName])
      if (!strength.ok) throw new WorkspaceError('weak_password', 'Choose a stronger password with at least 12 characters.', 400)
      registration = { displayName, passwordHash: await hashPassword(password) }
    }
    const result = await service.acceptInvitation(request.authUser?.id ?? null, request.body?.token, registration)
    if (registration) {
      const session = await createSession({ userId: result.userId, ip: request.ip, userAgent: request.headers['user-agent'] })
      reply.setCookie(sessionCookieName(), session.rawToken, sessionCookieOptions())
    }
    return { workspaceId: result.workspaceId }
  })
}
export default workspaceInvitationsRoutes
