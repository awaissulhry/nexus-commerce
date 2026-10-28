import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../sessions/office-auth'
import { acceptInvitationContract, inviteContract, previewInvitationContract, revokeInvitationContract } from './contract'
import { acceptInvitation, invite, previewInvitation, revokeInvitation } from './invitations'
import { manifest } from './manifest'

/**
 * POST /auth/invitations                        invite an address (the link goes to the mail seam)
 * POST /auth/invitations/:invitationId/revoke   stop an open invitation
 * POST /auth/invitations/preview                what the accept page shows, for a valid link
 * POST /auth/invitations/accept                 set the password, start a session (CSRF double submit)
 */
export default defineRoutes('auth-invitations', manifest, async (app) => {
  const tokenUse = app.officeAuth?.rateLimits.tokenUse ?? AUTH_RATE_LIMITS.tokenUse
  const limited = { rateLimit: { max: tokenUse.max, timeWindow: tokenUse.timeWindowMs } }

  app.post('/auth/invitations', { schema: inviteContract }, (request) => invite(officeAuthOf(app), request, request.body, idempotencyKeyFrom(request)))
  app.post('/auth/invitations/:invitationId/revoke', { schema: revokeInvitationContract }, (request) =>
    revokeInvitation(officeAuthOf(app), request, request.params.invitationId),
  )
  app.post('/auth/invitations/preview', { schema: previewInvitationContract, config: limited }, (request) =>
    previewInvitation(officeAuthOf(app), request.body.token),
  )
  app.post('/auth/invitations/accept', { schema: acceptInvitationContract, config: limited }, (request, reply) =>
    acceptInvitation(officeAuthOf(app), request, reply, request.body),
  )
})
