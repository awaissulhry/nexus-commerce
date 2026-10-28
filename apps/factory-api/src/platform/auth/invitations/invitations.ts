import type { FastifyReply, FastifyRequest } from 'fastify'
import { hashPassword, passwordProblems } from '@nexus/factory-domain/auth/password/password'
import { ADMIN_PERMISSION } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { StaleVersionError } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import { signedIn } from '../office/sign-in'
import { assignmentAudit, createAssignment, endAllAssignments } from '../roles/assignments'
import { assertCsrf } from '../sessions/cookies'
import { requiresMfa } from '../sessions/grants'
import type { OfficeAuth } from '../sessions/office-auth'
import { mintToken, parseToken, tokenHash } from '../sessions/secrets'
import { mintSessionSecrets, startSession, type StartedSession } from '../sessions/session-store'
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
 *             An address that is already an active or suspended user is refused. The token is minted BEFORE the
 *             command and only its hash goes in: the command's result (an Idempotency-Key receipt stores it) never
 *             holds it. A repeated request with the same Idempotency-Key answers the stored invitation with
 *             `delivery: already_sent` and sends no second mail.
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

export async function invite(auth: OfficeAuth, request: FastifyRequest, body: InviteBody, idempotencyKey?: string) {
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

  // Minted outside the command: the receipt of a keyed request stores the command's result, never this.
  const token = mintToken(context.tenantId, userId)
  let outcome
  try {
    // The spec names only the request (no record read before it), so a repeated Idempotency-Key finds the same request
    // hash and answers from its receipt. The person's row is guarded inside the work instead: compare-and-set on the
    // version read above, and the status machine's move from DEACTIVATED.
    outcome = await auth.command(context, { name: 'users.invite', idempotencyKey, input: { email, displayName: body.displayName, locale, roles: body.roles } }, async ({ tx, now, audit }) => {
      if (existing) {
        const current = await tx.user.findUnique({ where: { id: userId }, select: { status: true, version: true } })
        if (!current) throw new NotFoundError('User not found.')
        if (current.version !== existing.version) throw new StaleVersionError('User', userId, current.version, existing.version)
        if (current.status === 'DEACTIVATED') assertTransition(userStatus, current.status, 'INVITED', undefined)
        const { count } = await tx.user.updateMany({
          where: { id: userId, version: current.version },
          data: { version: current.version + 1, status: 'INVITED', displayName: body.displayName, locale },
        })
        if (count !== 1) throw new StaleVersionError('User', userId, current.version + 1, current.version)
        const revoked = await tx.invitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
        const assignmentsEnded = await endAllAssignments(tx, userId, { now, endedById: context.actorId })
        audit({ recordType: 'User', recordId: userId, before: { status: existing.status }, after: { status: 'INVITED', displayName: body.displayName, invitationsRevoked: revoked.count, assignmentsEnded } })
      } else {
        await tx.user.create({ data: { id: userId, email, displayName: body.displayName, locale, status: 'INVITED', createdAt: now, createdById: context.actorId } })
        audit({ recordType: 'User', recordId: userId, after: { email, displayName: body.displayName, status: 'INVITED' } })
      }
      const roleIds: string[] = []
      for (const [index, role] of body.roles.entries()) {
        const view = await createAssignment(tx, role, { userId, now, grantedById: context.actorId, assignerGrants: context.grants, path: `roles/${index}/` })
        audit({ recordType: 'RoleAssignment', recordId: view.id, after: assignmentAudit(view) })
        roleIds.push(view.roleId)
      }
      const id = newId()
      const expiresAt = toUtcIso(new Date(now.getTime() + INVITATION_TTL_MS))
      await tx.invitation.create({ data: { id, userId, email, tokenHash: tokenHash(token.value), invitedById: context.actorId, createdAt: now, expiresAt } })
      audit({ recordType: 'Invitation', recordId: id, after: { userId, email, expiresAt, roleIds } })
      return { invitation: { id, userId, email, expiresAt, roleIds } }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('This address was just invited by someone else. Reload the list.')
    throw error
  }
  const { invitation } = outcome.result
  // A repeat answers from the receipt: the first request already mailed the link, and this token was never stored.
  if (outcome.replayed) return { invitation, delivery: 'already_sent' as const }
  await auth.deliver(
    {
      kind: 'invitation',
      tenantId: context.tenantId,
      userId,
      to: email,
      link: auth.link('/accept-invitation', token.value),
      expiresAt: new Date(invitation.expiresAt),
      invitedById: context.actorId,
    },
    request.log,
  )
  return { invitation, delivery: 'sent' as const }
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
  // The session's secrets are minted outside the command: its result (which a receipt could store) never holds them.
  const secrets = mintSessionSecrets(token.tenantId, token.userId)

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
        secrets,
      })
      audit({ recordType: 'User', recordId: token.userId, before: { status: 'INVITED' }, after: { status: 'ACTIVE', displayName } })
      audit({ recordType: 'Invitation', recordId: invitation.id, after: { acceptedAt: toUtcIso(now) } })
      audit({ action: 'auth.signIn', recordType: 'Session', recordId: session.id, after: { userId: token.userId, secondFactor: null, companyId: session.companyId } })
      const { token: _token, csrfToken: _csrf, ...stored } = session
      return stored
    },
  )
  const started: StartedSession = { ...result, token: secrets.token.value, csrfToken: secrets.csrfToken }
  const requireMfa = await auth.inTenant(token.tenantId, token.userId, (client) => requiresMfa(client, { id: token.userId, requireMfa: invitation.user.requireMfa }, auth.clock.now()))
  return signedIn(reply, started, { id: token.userId, email: invitation.user.email, displayName, locale: invitation.user.locale, requireMfa, totpConfirmedAt: null }, false)
}
