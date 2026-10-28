import type { FastifyRequest } from 'fastify'
import { isLocked } from '@nexus/factory-domain/auth/lockout/lockout'
import { verifyPassword } from '@nexus/factory-domain/auth/password/password'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { requireContext, type OfficeContext } from '../../../core/context'
import { officeSessionOf, type OfficeSession } from '../sessions/authenticator'
import { mfaRequired, mfaSatisfied } from '../sessions/grants'
import type { OfficeAuth } from '../sessions/office-auth'
import { STEP_UP_VALID_MS } from '../sessions/session-store'
import { checkSecondFactor, claimOf, markSession, newRecoveryCodes, newTotpSecret, otpauthUri, recordWrongSecret } from './second-factor'

/**
 * The signed-in person's own account (features PLT-048, PLT-063): who am I, two-factor set-up, confirm and switch-off,
 * and the step-up.
 *
 * Step-up (A1 §3.10): bank details, issuing invoices, and user and role changes need a fresh code from the
 * authenticator app on this session, at most 5 minutes old (`requireStepUp`). Each code works once (the TOTP step
 * is claimed), a wrong one counts towards the lockout like a wrong password, and while the account is locked no code
 * is accepted. Recovery codes do not step up: they are for signing in without the phone.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

/** The step-up a risky route needs: a 403 that names `stepUp` when there is none this recent. */
export class StepUpRequiredError extends DomainError {
  override name = 'StepUpRequiredError'
  constructor() {
    super('forbidden', 'Confirm with a fresh code from your authenticator app first (step-up).', [{ path: 'stepUp', message: 'Required.' }])
  }
}

export function stepUpUntil(session: Pick<OfficeSession, 'stepUpAt'>): Date | null {
  return session.stepUpAt ? new Date(session.stepUpAt.getTime() + STEP_UP_VALID_MS) : null
}

export function requireStepUp(auth: OfficeAuth, request: FastifyRequest): void {
  const until = stepUpUntil(officeSessionOf(request))
  if (until === null || until.getTime() <= auth.clock.now().getTime()) throw new StepUpRequiredError()
}

export async function me(request: FastifyRequest) {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const { tenant, company, user } = await request.withClient(async (client) => ({
    tenant: await client.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { id: true, slug: true, name: true } }),
    company: context.companyId
      ? await client.company.findUnique({ where: { id: context.companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
      : null,
    user: await client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { recoveryCodeHashes: true } }),
  }))
  const until = stepUpUntil(session)
  return {
    user: { id: context.actorId, email: session.user.email, displayName: session.user.displayName, locale: session.user.locale },
    tenant,
    company: company ? { id: company.id, code: company.code, name: company.tradeName ?? company.legalName } : null,
    session: {
      id: session.id,
      createdAt: toUtcIso(session.createdAt),
      idleExpiresAt: toUtcIso(session.idleExpiresAt),
      absoluteExpiresAt: toUtcIso(session.absoluteExpiresAt),
      stepUpUntil: until ? toUtcIso(until) : null,
    },
    mfa: {
      enabled: session.user.totpEnabled,
      required: mfaRequired(session.user),
      satisfied: mfaSatisfied(session.user, session),
      recoveryCodesLeft: user.recoveryCodeHashes.length,
    },
    permissions: [...new Set(context.grants.flatMap((grant) => grant.permissions))].sort(),
  }
}

const TOTP_STATE = { totpSecretEnc: true, totpPendingSecretEnc: true, totpConfirmedAt: true, totpLastStep: true, recoveryCodeHashes: true, lockedUntil: true, passwordHash: true } as const

export async function stepUp(auth: OfficeAuth, request: FastifyRequest, code: string): Promise<{ stepUpUntil: string }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const now = auth.clock.now()
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: TOTP_STATE }))
  if (user.totpConfirmedAt === null) throw new InvalidStateError('Set up two-factor first: a step-up needs a code from the authenticator app.')
  if (isLocked(user, now)) throw new ForbiddenError('Too many wrong codes. Wait a few minutes, then try again.')
  const result = checkSecondFactor(auth.secrets, user, code, now, { recovery: false })
  if (!result.ok) {
    await recordWrongSecret(auth, context, 'auth.stepUpFailed', 'code')
    const message = result.failure === 'replayed' ? 'This code was already used. Wait for the next one.' : 'The code is wrong.'
    throw new ValidationError(message, [{ path: 'code', message }])
  }
  const claim = claimOf(result.proof)
  await auth.command(context, { name: 'auth.stepUp', input: null }, async ({ tx, now: at, audit }) => {
    const { count } = await tx.user.updateMany({ where: { id: context.actorId, ...claim.where }, data: { ...claim.data, failedAttempts: 0, lockedUntil: null } })
    if (count !== 1) throw new ValidationError('This code was already used. Wait for the next one.', [{ path: 'code', message: 'Already used.' }])
    await markSession(tx, session.id, { stepUpAt: at })
    audit({ recordType: 'Session', recordId: session.id, after: { stepUpAt: toUtcIso(at) } })
    return null
  })
  return { stepUpUntil: toUtcIso(new Date(now.getTime() + STEP_UP_VALID_MS)) }
}

export async function startTotpSetup(auth: OfficeAuth, request: FastifyRequest): Promise<{ secret: string; otpauthUri: string }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { totpConfirmedAt: true } }))
  if (user.totpConfirmedAt !== null) throw new ConflictError('Two-factor is already on. Switch it off first to set up another device.')
  const secret = newTotpSecret()
  await auth.command(context, { name: 'auth.totpSetup', input: null }, async ({ tx, audit }) => {
    await tx.user.update({ where: { id: context.actorId }, data: { totpPendingSecretEnc: auth.secrets.seal(secret) } })
    audit({ recordType: 'User', recordId: context.actorId, after: { totp: 'pending' } })
    return null
  })
  return { secret, otpauthUri: otpauthUri(session.user.email, secret) }
}

export async function confirmTotp(auth: OfficeAuth, request: FastifyRequest, code: string): Promise<{ recoveryCodes: string[] }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const now = auth.clock.now()
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: TOTP_STATE }))
  if (user.totpConfirmedAt !== null) throw new ConflictError('Two-factor is already on.')
  if (user.totpPendingSecretEnc === null) throw new InvalidStateError('Start the two-factor set-up first.')
  const pending = user.totpPendingSecretEnc
  const result = checkSecondFactor(auth.secrets, { totpSecretEnc: pending, totpLastStep: null, recoveryCodeHashes: [] }, code, now, { recovery: false })
  if (!result.ok || result.proof.kind !== 'totp') {
    throw new ValidationError('The code does not match. Check the time on your phone and enter the current code.', [{ path: 'code', message: 'Does not match.' }])
  }
  const step = result.proof.step
  const codes = newRecoveryCodes(auth.secrets)
  await auth.command(context, { name: 'auth.totpConfirm', input: null }, async ({ tx, now: at, audit }) => {
    const { count } = await tx.user.updateMany({
      where: { id: context.actorId, totpPendingSecretEnc: pending, totpConfirmedAt: null },
      data: { totpSecretEnc: pending, totpPendingSecretEnc: null, totpConfirmedAt: at, totpLastStep: step, recoveryCodeHashes: { set: codes.hashes } },
    })
    if (count !== 1) throw new ConflictError('Two-factor changed meanwhile. Start the set-up again.')
    // The code just proved the second factor on this session: its permissions apply from the next request.
    await markSession(tx, session.id, { mfaAt: at })
    audit({ recordType: 'User', recordId: context.actorId, after: { totp: 'on', recoveryCodes: codes.hashes.length } })
    return null
  })
  return { recoveryCodes: codes.shown }
}

export async function disableTotp(auth: OfficeAuth, request: FastifyRequest, password: string): Promise<{ status: 'off' }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  if (mfaRequired(session.user)) throw new InvalidStateError('Two-factor is required for your account; it cannot be switched off.')
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: TOTP_STATE }))
  if (user.totpConfirmedAt === null) throw new InvalidStateError('Two-factor is not on.')
  if (isLocked(user, auth.clock.now())) throw new ForbiddenError('Too many wrong attempts. Wait a few minutes, then try again.')
  if (!(await verifyPassword(password, user.passwordHash)).ok) {
    await recordWrongSecret(auth, context, 'auth.passwordCheckFailed', 'password')
    throw new ValidationError('The password is wrong.', [{ path: 'password', message: 'Wrong password.' }])
  }
  await auth.command(context, { name: 'auth.totpDisable', input: null }, async ({ tx, audit }) => {
    await tx.user.update({
      where: { id: context.actorId },
      data: { totpSecretEnc: null, totpPendingSecretEnc: null, totpConfirmedAt: null, totpLastStep: null, recoveryCodeHashes: { set: [] } },
    })
    audit({ recordType: 'User', recordId: context.actorId, after: { totp: 'off' } })
    return null
  })
  return { status: 'off' }
}
