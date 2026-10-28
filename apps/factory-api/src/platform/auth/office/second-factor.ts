import { randomBytes } from 'node:crypto'
import { generateSecret, generateSync, generateURI } from 'otplib'
import { lockUntil } from '@nexus/factory-domain/auth/lockout/lockout'
import { checkTotpCode, RECOVERY_CODES, recoveryCodeFrom, recoveryCodeOf, TOTP, type CodeAt } from '@nexus/factory-domain/auth/totp/totp'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Prisma } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { OfficeAuth } from '../sessions/office-auth'
import type { AuthSecrets } from '../sessions/secrets'

/**
 * Two-factor for the Office (plan A1 §3.10; features PLT-048, PLT-063): otplib computes the RFC 6238 codes, the rules
 * (drift window, each code once, recovery codes) are factory-domain's auth/totp. The secret is stored sealed
 * (sessions/secrets.ts) and opened only to compute codes.
 *
 * A proof is checked BEFORE the command that uses it and claimed INSIDE it by compare-and-set: the TOTP step only if
 * the stored last step is still older, a recovery code only if the stored list is still the one read. Two requests
 * with the same code cannot both pass.
 */

export const TOTP_ISSUER = 'Nexus Factory'

/** The code of each time step for one secret (base32, as authenticator apps read it). */
export const codesFor = (secret: string): CodeAt => (step) =>
  generateSync({ secret, epoch: step * TOTP.periodSeconds, period: TOTP.periodSeconds, digits: TOTP.digits, algorithm: 'sha1' })

/** A new TOTP secret: 160 random bits, base32. */
export const newTotpSecret = (): string => generateSecret({ length: 20 })

/** The otpauth:// URI the web shows as a QR code. */
export const otpauthUri = (label: string, secret: string): string =>
  generateURI({ issuer: TOTP_ISSUER, label, secret, digits: TOTP.digits, period: TOTP.periodSeconds, algorithm: 'sha1' })

/** Ten new recovery codes: shown once, stored as HMACs. */
export function newRecoveryCodes(secrets: AuthSecrets): { readonly shown: string[]; readonly hashes: string[] } {
  const shown = Array.from({ length: RECOVERY_CODES.count }, () => recoveryCodeFrom(randomBytes(RECOVERY_CODES.length)))
  return { shown, hashes: shown.map((code) => secrets.recoveryCodeHash(recoveryCodeOf(code)!)) }
}

/** What the stored user holds for a second factor. */
export interface FactorState {
  readonly totpSecretEnc: string | null
  readonly totpLastStep: number | null
  readonly recoveryCodeHashes: readonly string[]
}

export type Proof =
  | { readonly kind: 'totp'; readonly step: number }
  | { readonly kind: 'recovery'; readonly before: readonly string[]; readonly after: readonly string[] }

export type ProofFailure = 'malformed' | 'wrong' | 'replayed'

/** Checks a code typed by the person: a TOTP code, or (when allowed) a recovery code. */
export function checkSecondFactor(
  secrets: AuthSecrets,
  user: FactorState,
  code: unknown,
  now: Date,
  options: { readonly recovery: boolean },
): { readonly ok: true; readonly proof: Proof } | { readonly ok: false; readonly failure: ProofFailure } {
  if (!user.totpSecretEnc) return { ok: false, failure: 'wrong' }
  const recovery = options.recovery ? recoveryCodeOf(code) : null
  if (recovery !== null) {
    const hash = secrets.recoveryCodeHash(recovery)
    if (!user.recoveryCodeHashes.includes(hash)) return { ok: false, failure: 'wrong' }
    return { ok: true, proof: { kind: 'recovery', before: user.recoveryCodeHashes, after: user.recoveryCodeHashes.filter((item) => item !== hash) } }
  }
  const verdict = checkTotpCode({ code, now, lastStep: user.totpLastStep, codeAt: codesFor(secrets.open(user.totpSecretEnc)) })
  return verdict.ok ? { ok: true, proof: { kind: 'totp', step: verdict.step } } : { ok: false, failure: verdict.reason }
}

/** The `where` that claims a proof (compare-and-set) and the `data` that records it, for a user update. */
export function claimOf(proof: Proof | null): { readonly where: Prisma.UserWhereInput; readonly data: Prisma.UserUpdateManyMutationInput } {
  if (proof === null) return { where: {}, data: {} }
  if (proof.kind === 'totp') {
    return { where: { OR: [{ totpLastStep: null }, { totpLastStep: { lt: proof.step } }] }, data: { totpLastStep: proof.step } }
  }
  return { where: { recoveryCodeHashes: { equals: [...proof.before] } }, data: { recoveryCodeHashes: { set: [...proof.after] } } }
}

/**
 * Counts a wrong secret (password, sign-in code, step-up code) against the user, in its own command (the request
 * itself fails): the count goes up atomically and sets the lock of factory-domain's auth/lockout.
 */
export async function recordWrongSecret(
  auth: OfficeAuth,
  context: OfficeContext,
  action: 'auth.signInFailed' | 'auth.stepUpFailed' | 'auth.passwordCheckFailed',
  what: 'password' | 'code',
): Promise<void> {
  await auth.command(context, { name: action, input: { what } }, async ({ tx, now, audit }) => {
    const { failedAttempts } = await tx.user.update({ where: { id: context.actorId }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } })
    const until = lockUntil(failedAttempts, now)
    if (until) await tx.user.update({ where: { id: context.actorId }, data: { lockedUntil: until } })
    audit({ recordType: 'User', recordId: context.actorId, after: { wrong: what, failedAttempts, lockedUntil: until ? toUtcIso(until) : null } })
    return null
  })
}

/** Marks the session as having proved the second factor now (sign-in, set-up) or stepped up now. */
export async function markSession(tx: CommandTx, sessionId: string, data: { readonly mfaAt?: Date; readonly stepUpAt?: Date }): Promise<void> {
  await tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data })
}
