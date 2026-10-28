import type { FastifyReply, FastifyRequest } from 'fastify'
import { isLocked, UNLOCKED } from '@nexus/factory-domain/auth/lockout/lockout'
import { hashPassword, verifyPassword } from '@nexus/factory-domain/auth/password/password'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { CommandTx } from '../../../core/command'
import { liveSession } from '../sessions/authenticator'
import { assertCsrf, clearSessionCookies, sessionCookieOf, setSessionCookies } from '../sessions/cookies'
import { mfaRequired, requiresMfa } from '../sessions/grants'
import { PRE_SESSION_ACTOR_ID, type OfficeAuth } from '../sessions/office-auth'
import { mintToken, parseToken, tokenHash } from '../sessions/secrets'
import { createSession, mintSessionSecrets, SESSION_LIFETIME, withSessionSecrets, type StartedSession } from '../sessions/session-store'
import { normalizeEmail } from '../users/email'
import type { SignedInBody, SignInBody } from './contract'
import { createPasswordReset, REQUIRED_RESET_TTL_MS } from './password-reset'
import { checkSecondFactor, claimOf, recordWrongSecret, type Proof } from './second-factor'

/**
 * Sign-in and sign-out (plan A1 §3.10; features PLT-047, PLT-048, PLT-070), ported from Commerce's
 * apps/api/src/routes/auth.routes.ts login: the same answer for an unknown email, a wrong password and a locked
 * account, with the same scrypt work in each case (no enumeration by content or time); the lock is checked BEFORE the
 * password, so a locked account confirms no guess; a suspension is told only to someone who knows the password.
 *
 *   1. CSRF double submit (a login CSRF would sign the victim into the attacker's account);
 *   2. the tenant by slug (platform scope, Tenant only), then the person by email in the tenant (office scope);
 *   3. not locked → the password (scrypt) → a wrong one is counted (lockout) → 401;
 *   4. two-factor set up → a code is required: without one the answer is `totp_required`; a TOTP code (each used
 *      once) or a recovery code; a wrong one is counted → 401;
 *   5. an administrator required a new password → no session, a reset token instead (`password_change_required`);
 *   6. otherwise one command: the claim of the proof, the count cleared, the session, the audit row; the cookies.
 * The session's token and CSRF token (6) and the reset token (5) are minted before their command and only the token's
 * hash goes in: a command's result can become an Idempotency-Key receipt, so it never holds a secret.
 */

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  status: true,
  requireMfa: true,
  passwordHash: true,
  mustChangePassword: true,
  failedAttempts: true,
  lockedUntil: true,
  totpSecretEnc: true,
  totpConfirmedAt: true,
  totpLastStep: true,
  recoveryCodeHashes: true,
} as const

export interface SignedInUser {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly locale: string
  /** Two-factor is required now: the person's own flag or a role they hold (sessions/grants.ts requiresMfa). */
  readonly requireMfa: boolean
  readonly totpConfirmedAt: Date | null
}

/** The answer of a started session (sign-in, accepted invitation); the cookies are set here. */
export function signedIn(reply: FastifyReply, session: StartedSession, user: SignedInUser, mfaProved: boolean): SignedInBody {
  setSessionCookies(reply, session.token, session.csrfToken, SESSION_LIFETIME.absoluteMs)
  const required = mfaRequired(user)
  return {
    status: 'signed_in',
    csrfToken: session.csrfToken,
    user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
    mfa: { enabled: user.totpConfirmedAt !== null, required, satisfied: !required || mfaProved },
    session: { idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt },
  }
}

/** Claims the sign-in on the user row: still active, same password, not locked meanwhile, the proof unused. */
async function claimSignIn(tx: CommandTx, user: { id: string; passwordHash: string }, proof: Proof | null, now: Date, data: Record<string, unknown>): Promise<void> {
  const claim = claimOf(proof)
  const { count } = await tx.user.updateMany({
    where: {
      id: user.id,
      status: 'ACTIVE',
      passwordHash: user.passwordHash,
      AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] }, claim.where],
    },
    data: { ...UNLOCKED, ...claim.data, ...data },
  })
  if (count !== 1) throw new UnauthenticatedError('The sign-in could not be completed. Try again.')
}

export type SignInAnswer =
  | SignedInBody
  | { readonly status: 'totp_required' }
  | { readonly status: 'password_change_required'; readonly resetToken: string; readonly expiresAt: string }

export async function signIn(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: SignInBody): Promise<SignInAnswer> {
  assertCsrf(request)
  const now = auth.clock.now()
  const email = normalizeEmail(body.email)
  const wrong = () => new UnauthenticatedError('The email or password is wrong.')

  const tenant = await auth.inPlatform((client) => client.tenant.findUnique({ where: { slug: body.tenant.toLowerCase() }, select: { id: true, status: true } }))
  const user =
    tenant?.status === 'ACTIVE'
      ? await auth.inTenant(tenant.id, PRE_SESSION_ACTOR_ID, (client) =>
          client.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } }, select: USER_SELECT }),
        )
      : null
  if (!tenant || !user || user.passwordHash === null || isLocked(user, now)) {
    await verifyPassword(body.password, null)
    throw wrong()
  }
  const passwordHash = user.passwordHash
  const context = auth.contextFor(request, tenant.id, user.id)
  const check = await verifyPassword(body.password, passwordHash)
  if (!check.ok) {
    await recordWrongSecret(auth, context, 'auth.signInFailed', 'password')
    throw wrong()
  }
  if (user.status === 'SUSPENDED') throw new ForbiddenError('This account is suspended. Ask an administrator of your company.')
  if (user.status !== 'ACTIVE') throw wrong()

  let proof: Proof | null = null
  if (user.totpConfirmedAt !== null) {
    if (body.code === undefined) return { status: 'totp_required' }
    const result = checkSecondFactor(auth.secrets, user, body.code, now, { recovery: true })
    if (!result.ok) {
      await recordWrongSecret(auth, context, 'auth.signInFailed', 'code')
      throw new UnauthenticatedError(result.failure === 'replayed' ? 'This code was already used. Wait for the next one.' : 'The code is wrong.')
    }
    proof = result.proof
  }
  const rehash = check.needsRehash ? { passwordHash: await hashPassword(body.password) } : {}

  if (user.mustChangePassword) {
    const resetToken = mintToken(tenant.id, user.id)
    const resetHash = tokenHash(resetToken.value)
    const { result } = await auth.command(context, { name: 'auth.passwordChangeRequired', input: { email } }, async ({ tx, now: at, audit }) => {
      await claimSignIn(tx, { id: user.id, passwordHash }, proof, at, rehash)
      const reset = await createPasswordReset(tx, { userId: user.id, tokenHash: resetHash, kind: 'REQUIRED', now: at, ttlMs: REQUIRED_RESET_TTL_MS })
      audit({ recordType: 'PasswordReset', recordId: reset.id, after: { kind: 'REQUIRED', expiresAt: reset.expiresAt } })
      return reset
    })
    return { status: 'password_change_required', resetToken: resetToken.value, expiresAt: result.expiresAt }
  }

  const secrets = mintSessionSecrets(tenant.id, user.id)
  const sessionHash = tokenHash(secrets.token.value)
  const { result } = await auth.command(context, { name: 'auth.signIn', input: { email } }, async ({ tx, now: at, audit }) => {
    await claimSignIn(tx, { id: user.id, passwordHash }, proof, at, { ...rehash, lastSignInAt: at })
    const session = await createSession(tx, {
      tenantId: tenant.id,
      userId: user.id,
      now: at,
      mfaProved: proof !== null,
      ipHash: auth.secrets.ipHash(request.ip),
      userAgent: request.headers['user-agent'],
      tokenHash: sessionHash,
    })
    audit({ recordType: 'Session', recordId: session.id, after: { userId: user.id, secondFactor: proof?.kind ?? null, companyId: session.companyId } })
    return session
  })
  const requireMfa = await auth.inTenant(tenant.id, user.id, (client) => requiresMfa(client, user, auth.clock.now()))
  return signedIn(reply, withSessionSecrets(result, secrets), { ...user, requireMfa }, proof !== null)
}

/** Ends the session of the cookie, if it is live, and clears the cookies whatever it was. */
export async function signOut(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'signed_out' }> {
  assertCsrf(request)
  const token = parseToken(sessionCookieOf(request))
  if (token) {
    const session = await auth.inTenant(token.tenantId, token.userId, (client) => liveSession(client, token, auth.clock.now()))
    if (session) {
      await auth.command(auth.contextFor(request, token.tenantId, token.userId), { name: 'auth.signOut', input: null }, async ({ tx, now, audit }) => {
        await tx.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'SIGNED_OUT' } })
        audit({ recordType: 'Session', recordId: session.id, after: { revokedReason: 'SIGNED_OUT' } })
        return null
      })
    }
  }
  clearSessionCookies(reply)
  return { status: 'signed_out' }
}
