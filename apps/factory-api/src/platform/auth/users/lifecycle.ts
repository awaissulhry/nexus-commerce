import type { FastifyRequest } from 'fastify'
import type { UserStatus } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import type { OfficeAuth } from '../sessions/office-auth'
import { endAllAssignments, liveAssignmentsOf } from '../roles/assignments'
import { endSessions } from '../sessions/session-store'
import type { UserChangeBody } from './contract'
import { adminFacts, userStatus } from './status'

/**
 * The user list and the lifecycle commands (features PLT-015, PLT-016, PLT-070). Each change is ONE command with its
 * audit row: the edit-conflict guard (the version the caller read), the status machine (factory-domain
 * auth/users/status.ts, with the last-administrator guard), and what the change means for access, in the same
 * transaction:
 *
 *   suspend                 every session ends at once; the account keeps its password, two-factor and roles
 *   reactivate              the person can sign in again
 *   deactivate              every session ends, open invitations and reset links stop, the password and two-factor
 *                           are cleared and every role assignment ends; the row stays, so history keeps naming the
 *                           person (PLT-016)
 *   require-password-reset  every session ends; the next sign-in answers with a reset token (PLT-070)
 *
 * User changes need a step-up (A1 §3.10), and nobody suspends, deactivates or resets their own account here.
 */

export type UserChange = 'suspend' | 'reactivate' | 'deactivate' | 'require-password-reset'

const TARGET: Readonly<Record<Exclude<UserChange, 'require-password-reset'>, UserStatus>> = {
  suspend: 'SUSPENDED',
  reactivate: 'ACTIVE',
  deactivate: 'DEACTIVATED',
}

export async function listUsers(auth: OfficeAuth, request: FastifyRequest) {
  const now = auth.clock.now()
  const { rows, roles } = await request.withClient(async (client) => {
    const rows = await client.user.findMany({
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: {
        id: true,
        email: true,
        displayName: true,
        locale: true,
        status: true,
        totpConfirmedAt: true,
        lastSignInAt: true,
        version: true,
        invitations: { where: { acceptedAt: null, revokedAt: null }, orderBy: { expiresAt: 'desc' }, take: 1, select: { expiresAt: true } },
      },
    })
    return { rows, roles: await liveAssignmentsOf(client, rows.map((row) => row.id), now) }
  })
  return {
    users: rows.map(({ totpConfirmedAt, lastSignInAt, invitations, ...user }) => ({
      ...user,
      roles: (roles.get(user.id) ?? []).map(({ id, roleId, roleKey, roleName, allCompanies, companyIds, siteIds, partyIds, validTo }) => ({
        assignmentId: id,
        roleId,
        roleKey,
        roleName,
        allCompanies,
        companyIds,
        siteIds,
        partyIds,
        validTo,
      })),
      mfaEnabled: totpConfirmedAt !== null,
      lastSignInAt: lastSignInAt ? toUtcIso(lastSignInAt) : null,
      invitationExpiresAt: user.status === 'INVITED' && invitations[0] ? toUtcIso(invitations[0].expiresAt) : null,
    })),
  }
}

export async function changeUser(auth: OfficeAuth, request: FastifyRequest, userId: string, body: UserChangeBody, change: UserChange) {
  const context = requireContext(request) as OfficeContext
  requireStepUp(auth, request)
  if (userId === context.actorId) throw new ForbiddenError('You cannot change the access of your own account here; ask another administrator.')

  if (change === 'require-password-reset') {
    const { result } = await auth.command(
      context,
      { name: 'users.resetPassword', input: body, record: { type: 'User', id: userId, expectedVersion: body.version } },
      async ({ tx, now, audit, record }) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } })
        if (user.status !== 'ACTIVE' && user.status !== 'SUSPENDED') throw new InvalidStateError(`A ${user.status.toLowerCase()} user has no password to reset.`)
        await tx.user.update({ where: { id: userId }, data: { mustChangePassword: true } })
        await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
        const sessionsEnded = await endSessions(tx, { userId, now, reason: 'PASSWORD_CHANGED' })
        audit({ recordType: 'User', recordId: userId, before: { mustChangePassword: false }, after: { mustChangePassword: true, sessionsEnded }, ...(body.reason ? { reason: body.reason } : {}) })
        return { id: userId, status: user.status, version: record!.version, sessionsEnded }
      },
    )
    return result
  }

  const to = TARGET[change]
  const { result } = await auth.command(
    context,
    {
      name: change === 'suspend' ? 'users.suspend' : change === 'reactivate' ? 'users.reactivate' : 'users.deactivate',
      input: body,
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to, facts: adminFacts(userId, auth.clock.now()) } },
    },
    async ({ tx, now, audit, record }) => {
      let sessionsEnded = 0
      let assignmentsEnded = 0
      if (to === 'SUSPENDED' || to === 'DEACTIVATED') sessionsEnded = await endSessions(tx, { userId, now, reason: to })
      if (to === 'DEACTIVATED') {
        await tx.user.update({
          where: { id: userId },
          data: {
            isOwner: false,
            passwordHash: null,
            mustChangePassword: false,
            totpSecretEnc: null,
            totpPendingSecretEnc: null,
            totpConfirmedAt: null,
            totpLastStep: null,
            recoveryCodeHashes: { set: [] },
            failedAttempts: 0,
            lockedUntil: null,
          },
        })
        await tx.invitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
        await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
        assignmentsEnded = await endAllAssignments(tx, userId, { now, endedById: context.actorId })
      }
      audit({
        recordType: 'User',
        recordId: userId,
        before: { status: record!.from },
        after: { status: record!.to, sessionsEnded, ...(to === 'DEACTIVATED' ? { assignmentsEnded } : {}) },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return { id: userId, status: to, version: record!.version, sessionsEnded }
    },
  )
  return result
}
