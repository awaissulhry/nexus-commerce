import type { FastifyReply, FastifyRequest } from 'fastify'
import { hashPassword, passwordProblems } from '@nexus/factory-domain/auth/password/password'
import { ADMIN_PERMISSION } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import { signedIn } from '../office/sign-in'
import { assignmentAudit, createAssignment, endAllAssignments } from '../roles/assignments'
import { assertCsrf } from '../sessions/cookies'
import { requiresMfa } from '../sessions/grants'
import type { OfficeAuth } from '../sessions/office-auth'
import { mintToken, parseToken, tokenHash } from '../sessions/secrets'
import { startSession } from '../sessions/session-store'
import { emailOrThrow } from '../users/email'
import { adminFacts, userStatus } from '../users/status'
import type { AcceptInvitationBody, InviteBody } from './contract'

/**
 * Invitations by email (feature PLT-015), ported from Commerce's invitation routes (apps/api/src/routes/auth.routes.ts):
 *
 *   invite    an administrator (users.invite, with a step-up) names an address, a display name and the person's
 *             first roles with their scopes (naming any also needs roles.assign). The user row is made INVITED at once
 *             (or an earlier invited or deactivated one is reused, so history keeps one person) with those role
 *             assignments (an earlier invitation's are ended: the newest invitation says what the person gets);
 *             earlier open invitations of the person stop; the link (72 hours) goes to the mail seam after the commit.
 *             An address that is already an active or suspended user is refused.
 *   revoke    the open invitation stops; the invited user becomes DEACTIVATED (and can be invited again), and the
 *             roles it gave end.
 *   preview   what the accept page shows (tenant, address, name), for a valid link only.
 *   accept    once: the invitation is claimed by compare-and-set, the password set (the rules of factory-domain's
 *             auth/password), the user ACTIVE (status machine), a session started; all in one command. Two-factor is set
 *             up next on that session when the person needs it (office/account.ts): until then it holds no permission.
 *
 * The assignments give nothing before the invitation is accepted (an invited person has no session); a role that
 * requires two-factor gives nothing until it is set up and proved on a session.
 */

export const INVITATION_TTL_MS = 72 * 60 * 60_000
const INVALID = 'This invitation is not valid or has expired. Ask for a new one.'

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export async function invite(auth: OfficeAuth, request: FastifyRequest, body: InviteBody) {
  const context = requireContext(request) as OfficeContext
  requireStepUp(auth, request)
  const email = emailOrThrow(body.email)
  const locale = body.locale ?? 'it'
  if (body.roles.length > 0 && !holds(actorOf(context), ADMIN_PERMISSION)) {
    throw new ForbiddenError(`Giving roles with an invitation also needs ${ADMIN_PERMISSION}.`)
  }
  const existing = await request.withClient((client) =>
    client.user.findUnique({ where: { tenantId_email: { tenantId: context.tenantId, email } }, select: { id: true, status: true, version: true } }),
  )
  if (existing && (existing.status === 'ACTIVE' || existing.status === 'SUSPENDED')) {
    throw new ConflictError('This address already belongs to a user of the tenant.')
  }
  const userId = existing?.id ?? newId()
  const record = existing
    ? { type: 'User' as const, id: existing.id, expectedVersion: existing.version, ...(existing.status === 'DEACTIVATED' ? { transition: { machine: userStatus, to: 'INVITED' as const } } : {}) }
    : undefined

  let outcome
  try {
    outcome = await auth.command(context, { name: 'users.invite', input: { email, displayName: body.displayName, locale, roles: body.roles }, ...(record ? { record } : {}) }, async ({ tx, now, audit }) => {
      if (existing) {
        await tx.user.update({ where: { id: userId }, data: { displayName: body.displayName, locale } })
        const revoked = await tx.invitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
        const assignmentsEnded = await endAllAssignments(tx, userId, { now, endedById: context.actorId })
        audit({ recordType: 'User', recordId: userId, before: { status: existing.status }, after: { status: 'INVITED', displayName: body.displayName, invitationsRevoked: revoked.count, assignmentsEnded } })
      } else {
        await tx.user.create({ data: { id: userId, email, displayName: body.displayName, locale, status: 'INVITED', createdAt: now, createdById: context.actorId } })
        audit({ recordType: 'User', recordId: userId, after: { email, displayName: body.displayName, status: 'INVITED' } })
      }
      const roleIds: string[] = []
      for (const [index, role] of body.roles.entries()) {
        const view = await createAssignment(tx, role, { userId, now, grantedById: context.actorId, path: `roles/${index}/` })
        audit({ recordType: 'RoleAssignment', recordId: view.id, after: assignmentAudit(view) })
        roleIds.push(view.roleId)
      }
      const token = mintToken(context.tenantId, userId)
      const id = newId()
      const expiresAt = toUtcIso(new Date(now.getTime() + INVITATION_TTL_MS))
      await tx.invitation.create({ data: { id, userId, email, tokenHash: tokenHash(token.value), invitedById: context.actorId, createdAt: now, expiresAt } })
      audit({ recordType: 'Invitation', recordId: id, after: { userId, email, expiresAt, roleIds } })
      return { invitation: { id, userId, email, expiresAt, roleIds }, token: token.value }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('This address was just invited by someone else. Reload the list.')
    throw error
  }
  const { invitation, token } = outcome.result
  await auth.deliver(
    {
      kind: 'invitation',
      tenantId: context.tenantId,
      userId,
      to: email,
      link: auth.link('/accept-invitation', token),
      expiresAt: new Date(invitation.expiresAt),
      invitedById: context.actorId,
    },
    request.log,
  )
  return { invitation }
}

export async function revokeInvitation(auth: OfficeAuth, request: FastifyRequest, invitationId: string) {
  const context = requireContext(request) as OfficeContext
  requireStepUp(auth, request)
  const invitation = await request.withClient((client) =>
    client.invitation.findUnique({ where: { id: invitationId }, select: { id: true, userId: true, acceptedAt: true, revokedAt: true, user: { select: { status: true } } } }),
  )
  if (!invitation) throw new NotFoundError('Invitation not found.')
  if (invitation.acceptedAt !== null || invitation.revokedAt !== null) throw new InvalidStateError('This invitation was already accepted or revoked.')
  const stillInvited = invitation.user.status === 'INVITED'
  const { result } = await auth.command(
    context,
    {
      name: 'users.revokeInvitation',
      input: { invitationId },
      ...(stillInvited ? { record: { type: 'User' as const, id: invitation.userId, transition: { machine: userStatus, to: 'DEACTIVATED' as const, facts: adminFacts(invitation.userId, auth.clock.now()) } } } : {}),
    },
    async ({ tx, now, audit }) => {
      const { count } = await tx.invitation.updateMany({ where: { id: invitationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
      if (count !== 1) throw new InvalidStateError('This invitation was already accepted or revoked.')
      audit({ recordType: 'Invitation', recordId: invitationId, after: { revokedAt: toUtcIso(now) } })
      if (stillInvited) {
        const assignmentsEnded = await endAllAssignments(tx, invitation.userId, { now, endedById: context.actorId })
        audit({ recordType: 'User', recordId: invitation.userId, before: { status: 'INVITED' }, after: { status: 'DEACTIVATED', assignmentsEnded } })
      }
      return { id: invitationId, revokedAt: toUtcIso(now) }
    },
  )
  return result
}

/** The open invitation of a link, or a 404 (unknown, used, revoked, expired: the same answer). */
async function openInvitation(auth: OfficeAuth, text: string) {
  const token = parseToken(text)
  if (!token) throw new NotFoundError(INVALID)
  const now = auth.clock.now()
  const invitation = await auth.inTenant(token.tenantId, token.userId, (client) =>
    client.invitation.findUnique({
      where: { tokenHash: tokenHash(token.value) },
      select: {
        id: true,
        userId: true,
        email: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        user: { select: { status: true, email: true, displayName: true, locale: true, requireMfa: true, tenant: { select: { status: true } } } },
      },
    }),
  )
  if (
    !invitation ||
    invitation.userId !== token.userId ||
    invitation.acceptedAt !== null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= now.getTime() ||
    invitation.user.status !== 'INVITED' ||
    invitation.user.tenant.status !== 'ACTIVE'
  ) {
    throw new NotFoundError(INVALID)
  }
  return { token, invitation }
}

export async function previewInvitation(auth: OfficeAuth, text: string) {
  const { token, invitation } = await openInvitation(auth, text)
  const tenant = await auth.inTenant(token.tenantId, token.userId, (client) => client.tenant.findUniqueOrThrow({ where: { id: token.tenantId }, select: { name: true } }))
  return { tenant, email: invitation.email, displayName: invitation.user.displayName, expiresAt: toUtcIso(invitation.expiresAt) }
}

export async function acceptInvitation(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: AcceptInvitationBody) {
  assertCsrf(request)
  const { token, invitation } = await openInvitation(auth, body.token)
  const displayName = body.displayName ?? invitation.user.displayName
  const problems = passwordProblems(body.password, { email: invitation.user.email, displayName })
  if (problems.length > 0) throw new ValidationError('Choose another password.', problems)
  const passwordHash = await hashPassword(body.password)

  const { result } = await auth.command(
    auth.contextFor(request, token.tenantId, token.userId),
    { name: 'users.acceptInvitation', input: { invitationId: invitation.id }, record: { type: 'User', id: token.userId, transition: { machine: userStatus, to: 'ACTIVE' } } },
    async ({ tx, now, audit }) => {
      const { count } = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } })
      if (count !== 1) throw new NotFoundError(INVALID)
      await tx.user.update({
        where: { id: token.userId },
        data: { passwordHash, passwordChangedAt: now, displayName, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
      })
      const session = await startSession(tx, {
        tenantId: token.tenantId,
        userId: token.userId,
        now,
        mfaProved: false,
        ipHash: auth.secrets.ipHash(request.ip),
        userAgent: request.headers['user-agent'],
      })
      audit({ recordType: 'User', recordId: token.userId, before: { status: 'INVITED' }, after: { status: 'ACTIVE', displayName } })
      audit({ recordType: 'Invitation', recordId: invitation.id, after: { acceptedAt: toUtcIso(now) } })
      audit({ action: 'auth.signIn', recordType: 'Session', recordId: session.id, after: { userId: token.userId, secondFactor: null, companyId: session.companyId } })
      return session
    },
  )
  const requireMfa = await auth.inTenant(token.tenantId, token.userId, (client) => requiresMfa(client, { id: token.userId, requireMfa: invitation.user.requireMfa }, auth.clock.now()))
  return signedIn(reply, result, { id: token.userId, email: invitation.user.email, displayName, locale: invitation.user.locale, requireMfa, totpConfirmedAt: null }, false)
}
