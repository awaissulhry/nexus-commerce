import type { FastifyRequest } from 'fastify'
import { hashPassword, passwordProblems } from '@nexus/factory-domain/auth/password/password'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Prisma } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'
import { PRE_SESSION_ACTOR_ID, type OfficeAuth } from '../sessions/office-auth'
import { mintToken, parseToken, tokenHash } from '../sessions/secrets'
import { endSessions } from '../sessions/session-store'
import { normalizeEmail } from '../users/email'

/**
 * Password resets (feature PLT-070), ported from Commerce's reset-request and reset routes:
 *
 *   request   always the same answer, at once; the work (does the address have an account? a recent link already?)
 *             runs after the answer, so neither content nor time tells whether the address is known. A link already
 *             asked for in the last 5 minutes is not made again (no mail bombing). The link lives 1 hour.
 *   confirm   the token (single use, compare-and-set on usedAt), the password rules, then in one command: the new
 *             password, the lock cleared, every other open link of the person used up, every session ended (a reset
 *             means "lock everyone out"). Two-factor stays: the next sign-in still asks for a code.
 *   required  an administrator's forced reset (users/lifecycle.ts) is met at the next sign-in, which answers with a
 *             15-minute token instead of a session (office/sign-in.ts).
 */

export const RESET_TTL_MS = 60 * 60_000
export const REQUIRED_RESET_TTL_MS = 15 * 60_000
const COALESCE_MS = 5 * 60_000

type ResetKind = Prisma.PasswordResetUncheckedCreateInput['kind']

/** A new reset row; returns its id, token (to the person only) and expiry. */
export async function createPasswordReset(
  tx: CommandTx,
  input: { readonly tenantId: string; readonly userId: string; readonly kind: ResetKind; readonly now: Date; readonly ttlMs: number },
): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: string }> {
  const token = mintToken(input.tenantId, input.userId)
  const id = newId()
  const expiresAt = new Date(input.now.getTime() + input.ttlMs)
  await tx.passwordReset.create({ data: { id, userId: input.userId, tokenHash: tokenHash(token.value), kind: input.kind, createdAt: input.now, expiresAt } })
  return { id, token: token.value, expiresAt: toUtcIso(expiresAt) }
}

/** The command found a link asked for in the last minutes: nothing is written, nothing mailed. */
class AlreadyRequested extends Error {}

export function requestPasswordReset(auth: OfficeAuth, request: FastifyRequest, body: { tenant: string; email: string }): { status: 'requested' } {
  const email = normalizeEmail(body.email)
  const slug = body.tenant.toLowerCase()
  auth.afterAnswer(async () => {
    const tenant = await auth.inPlatform((client) => client.tenant.findUnique({ where: { slug }, select: { id: true, status: true } }))
    if (tenant?.status !== 'ACTIVE') return
    const user = await auth.inTenant(tenant.id, PRE_SESSION_ACTOR_ID, (client) =>
      client.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } }, select: { id: true, status: true } }),
    )
    if (!user || user.status !== 'ACTIVE') return
    let reset: { readonly token: string; readonly expiresAt: string }
    try {
      ;({ result: reset } = await auth.command(auth.contextFor(request, tenant.id, user.id), { name: 'auth.passwordResetRequest', input: { email } }, async ({ tx, now, audit }) => {
        // One request at a time per person (the row lock), so two at once cannot both pass the check below.
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`
        const recent = await tx.passwordReset.count({
          where: { userId: user.id, kind: 'REQUESTED', usedAt: null, createdAt: { gt: new Date(now.getTime() - COALESCE_MS) } },
        })
        if (recent > 0) throw new AlreadyRequested()
        const created = await createPasswordReset(tx, { tenantId: tenant.id, userId: user.id, kind: 'REQUESTED', now, ttlMs: RESET_TTL_MS })
        audit({ recordType: 'PasswordReset', recordId: created.id, after: { kind: 'REQUESTED', expiresAt: created.expiresAt } })
        return created
      }))
    } catch (error) {
      if (error instanceof AlreadyRequested) return
      throw error
    }
    await auth.deliver(
      { kind: 'password_reset', tenantId: tenant.id, userId: user.id, to: email, link: auth.link('/reset-password', reset.token), expiresAt: new Date(reset.expiresAt) },
      request.log,
    )
  }, request.log)
  return { status: 'requested' }
}

const INVALID = 'This reset link is not valid or has expired. Ask for a new one.'

export async function confirmPasswordReset(auth: OfficeAuth, request: FastifyRequest, body: { token: string; password: string }): Promise<{ status: 'password_set' }> {
  const token = parseToken(body.token)
  if (!token) throw new NotFoundError(INVALID)
  const now = auth.clock.now()
  const reset = await auth.inTenant(token.tenantId, token.userId, (client) =>
    client.passwordReset.findUnique({
      where: { tokenHash: tokenHash(token.value) },
      select: {
        id: true,
        userId: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { status: true, email: true, displayName: true, tenant: { select: { status: true } } } },
      },
    }),
  )
  if (!reset || reset.userId !== token.userId || reset.usedAt !== null || reset.expiresAt.getTime() <= now.getTime() || reset.user.status !== 'ACTIVE' || reset.user.tenant.status !== 'ACTIVE') {
    throw new NotFoundError(INVALID)
  }
  const problems = passwordProblems(body.password, { email: reset.user.email, displayName: reset.user.displayName })
  if (problems.length > 0) throw new ValidationError('Choose another password.', problems)
  const passwordHash = await hashPassword(body.password)

  await auth.command(auth.contextFor(request, token.tenantId, token.userId), { name: 'auth.passwordReset', input: { resetId: reset.id } }, async ({ tx, now: at, audit }) => {
    const { count } = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null, expiresAt: { gt: at } }, data: { usedAt: at } })
    if (count !== 1) throw new NotFoundError(INVALID)
    const changed = await tx.user.updateMany({
      where: { id: token.userId, status: 'ACTIVE' },
      data: { passwordHash, passwordChangedAt: at, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
    })
    if (changed.count !== 1) throw new NotFoundError(INVALID)
    await tx.passwordReset.updateMany({ where: { userId: token.userId, usedAt: null }, data: { usedAt: at } })
    const ended = await endSessions(tx, { userId: token.userId, now: at, reason: 'PASSWORD_CHANGED' })
    audit({ recordType: 'User', recordId: token.userId, after: { passwordChangedAt: toUtcIso(at), sessionsEnded: ended } })
    audit({ action: 'auth.passwordResetUsed', recordType: 'PasswordReset', recordId: reset.id, after: { usedAt: toUtcIso(at) } })
    return null
  })
  return { status: 'password_set' }
}
