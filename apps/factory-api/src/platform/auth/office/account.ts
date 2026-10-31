import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { isLocked } from '@nexus/factory-domain/auth/lockout/lockout'
import { hashPassword, passwordProblems, verifyPassword } from '@nexus/factory-domain/auth/password/password'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Locale } from '@nexus/factory-domain/email/rules'
import { requireContext, type OfficeContext } from '../../../core/context'
import { staffNoticeState } from '../../privacy/read'
import { officeSessionOf, type OfficeSession } from '../sessions/authenticator'
import { heldRoles, type HeldAssignment } from '../roles/access'
import { mfaRequired, mfaSatisfied } from '../sessions/grants'
import type { OfficeAuth } from '../sessions/office-auth'
import { endSessions, STEP_UP_VALID_MS } from '../sessions/session-store'
import { checkSecondFactor, claimOf, markSession, newRecoveryCodes, newTotpSecret, otpauthUri, recordWrongSecret } from './second-factor'

/**
 * The signed-in person's own account (features PLT-048, PLT-063, PLT-070, PLT-127): who am I, two-factor set-up,
 * confirm and switch-off, the step-up, a new password, and the interface language.
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

const COMPANY_VIEW = { id: true, code: true, legalName: true, tradeName: true } as const
const companyView = (company: { id: string; code: string; legalName: string; tradeName: string | null }) => ({
  id: company.id,
  code: company.code,
  name: company.tradeName ?? company.legalName,
})

/** The active companies a person's live roles reach (any role: two-factor not yet proved still lists them). */
async function companiesOf(client: FactoryClient, held: readonly HeldAssignment[]) {
  if (held.length === 0) return []
  const every = held.some((assignment) => assignment.scope.allCompanies)
  const ids = [...new Set(held.flatMap((assignment) => assignment.scope.companyIds))]
  return client.company.findMany({ where: { status: 'ACTIVE', ...(every ? {} : { id: { in: ids } }) }, orderBy: [{ code: 'asc' }], select: COMPANY_VIEW })
}

const SITE_VIEW = { id: true, code: true, name: true } as const

/**
 * B-W2b-05 (PLT-008): the active sites of the screen's company that the person's live roles reach, for the top bar's
 * company and site switcher. Every site of the company when an assignment that reaches the company has no site limit
 * (`allSites`), else the sites those assignments name. Any role counts, as for the companies: the switcher only offers
 * what the grants reach, and the API checks every read against the grants themselves.
 */
async function sitesOf(client: FactoryClient, held: readonly HeldAssignment[], companyId: string) {
  const reaching = held.filter((assignment) => assignment.scope.allCompanies || assignment.scope.companyIds.includes(companyId))
  if (reaching.length === 0) return { sites: [], allSites: false }
  const allSites = reaching.some((assignment) => assignment.scope.siteIds.length === 0)
  const ids = [...new Set(reaching.flatMap((assignment) => assignment.scope.siteIds))]
  const sites = await client.site.findMany({ where: { companyId, status: 'ACTIVE', ...(allSites ? {} : { id: { in: ids } }) }, orderBy: [{ code: 'asc' }], select: SITE_VIEW })
  return { sites, allSites }
}

export async function me(auth: OfficeAuth, request: FastifyRequest) {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const { tenant, company, companies, place, user, staffNotice } = await request.withClient(async (client) => {
    const held = await heldRoles(client, context.actorId, auth.clock.now())
    return {
      tenant: await client.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { id: true, slug: true, name: true } }),
      company: context.companyId ? await client.company.findUnique({ where: { id: context.companyId }, select: COMPANY_VIEW }) : null,
      companies: await companiesOf(client, held),
      // B-W2b-05: the screen company's sites this person reaches (the top bar's switcher).
      place: context.companyId ? await sitesOf(client, held, context.companyId) : { sites: [], allSites: false },
      user: await client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { recoveryCodeHashes: true } }),
      // The screen's company's staff notice in force (B-W1-36): the web shows it once per version (GET /privacy/staff-notice).
      staffNotice: await staffNoticeState(client, context.companyId, context.actorId),
    }
  })
  const until = stepUpUntil(session)
  return {
    user: { id: context.actorId, email: session.user.email, displayName: session.user.displayName, locale: session.user.locale },
    tenant,
    company: company ? companyView(company) : null,
    companies: companies.map(companyView),
    sites: place.sites,
    allSites: place.allSites,
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
    staffNotice,
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

/**
 * A new password from the signed-in person (PLT-070, SCR-007): the current one first, checked as at sign-in (a wrong one
 * counts towards the lockout; while locked nothing is accepted), then the password rules, then in one command: the new
 * hash (only if the stored one is still the one checked), the lock cleared, every open reset link used up, and every
 * OTHER session ended (a changed password means "lock out whoever had it"). This session goes on; two-factor stays.
 */
export async function changePassword(
  auth: OfficeAuth,
  request: FastifyRequest,
  body: { readonly currentPassword: string; readonly password: string },
): Promise<{ status: 'password_changed'; sessionsEnded: number }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { passwordHash: true, lockedUntil: true } }))
  if (isLocked(user, auth.clock.now())) throw new ForbiddenError('Too many wrong attempts. Wait a few minutes, then try again.')
  if (!(await verifyPassword(body.currentPassword, user.passwordHash)).ok) {
    await recordWrongSecret(auth, context, 'auth.passwordCheckFailed', 'password')
    throw new ValidationError('The current password is wrong.', [{ path: 'currentPassword', message: 'Wrong password.' }])
  }
  const problems = passwordProblems(body.password, { email: session.user.email, displayName: session.user.displayName })
  if (problems.length > 0) throw new ValidationError('Choose another password.', problems)
  const passwordHash = await hashPassword(body.password)
  const { result } = await auth.command(context, { name: 'auth.passwordChange', input: null }, async ({ tx, now, audit }) => {
    const { count } = await tx.user.updateMany({
      where: { id: context.actorId, status: 'ACTIVE', passwordHash: user.passwordHash },
      data: { passwordHash, passwordChangedAt: now, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
    })
    if (count !== 1) throw new ConflictError('The password changed meanwhile. Sign in again.')
    await tx.passwordReset.updateMany({ where: { userId: context.actorId, usedAt: null }, data: { usedAt: now } })
    const sessionsEnded = await endSessions(tx, { userId: context.actorId, now, reason: 'PASSWORD_CHANGED', exceptSessionId: session.id })
    audit({ recordType: 'User', recordId: context.actorId, after: { passwordChangedAt: toUtcIso(now), sessionsEnded } })
    return { sessionsEnded }
  })
  return { status: 'password_changed', sessionsEnded: result.sessionsEnded }
}

/** The signed-in person's interface language (PLT-127): the office layout reads it on every page. */
export async function setLocale(auth: OfficeAuth, request: FastifyRequest, locale: Locale): Promise<{ locale: Locale }> {
  const context = officeContextOf(request)
  await auth.command(context, { name: 'auth.setLocale', input: { locale } }, async ({ tx, audit }) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: context.actorId }, select: { locale: true } })
    await tx.user.update({ where: { id: context.actorId }, data: { locale } })
    audit({ recordType: 'User', recordId: context.actorId, before: { locale: before.locale }, after: { locale } })
    return null
  })
  return { locale }
}
