import type { SessionEndReason } from '@nexus/factory-db'
import { deviceOf, type SessionPlace } from '@nexus/factory-domain/auth/sessions/device'
import { idleEndAfter, SECURITY_DEFAULTS, sessionLengthsMs } from '@nexus/factory-domain/auth/sessions/lengths'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { newCsrfToken } from './cookies'
import { securityRulesIn } from './rules'
import { mintToken, tokenHash, type AuthToken } from './secrets'

/**
 * Office session rows (plan A1 §2.3 Session, §3.10; ported from Commerce's apps/api/src/lib/auth/session.ts): server
 * side, so a revocation takes effect on the next request. A session lives until it is revoked, until its idle time
 * passes without a request (the idle expiry slides forward with use, at most one write a minute, never past the absolute
 * expiry) or until its longest time after sign-in. B-W2b-404 (PLT-068): both are the tenant's office lengths
 * (SecuritySettings; by default 8 hours and 7 days), read when the session starts and again on every request (a shorter
 * one ends open sessions at their next request). The session keeps where it runs (device, browser, place), set once at
 * the start. Always written inside a command's transaction.
 */

/** The W0 lengths (the tenant's defaults, SECURITY_DEFAULTS) and how often the idle end slides. */
export const SESSION_LIFETIME = Object.freeze({
  idleMs: sessionLengthsMs(SECURITY_DEFAULTS).office.idleMs,
  absoluteMs: sessionLengthsMs(SECURITY_DEFAULTS).office.longestMs,
  /** The idle expiry is moved at most this often (one write a minute per session, not one per request). */
  slideEveryMs: 60_000,
})

/** A step-up (a fresh code) opens the risky actions for this long. */
export const STEP_UP_VALID_MS = 5 * 60_000

export interface StartSessionInput {
  readonly tenantId: string
  readonly userId: string
  readonly now: Date
  /** The second factor was proved by this sign-in. */
  readonly mfaProved: boolean
  readonly ipHash: string | null
  readonly userAgent: string | undefined
  /** B-W2b-404: the place an edge proxy we trust gave (sessions/place.ts `sessionPlaceOf`); none without one. */
  readonly place?: SessionPlace
}

/** A session made from the hash of its token alone (`createSession`): the token itself never enters the command. */
export interface CreateSessionInput extends StartSessionInput {
  /** `tokenHash(secrets.token.value)` of secrets minted before the command (`mintSessionSecrets`). */
  readonly tokenHash: string
}

/** A session's cookie token and CSRF token. Never in a row, an audit entry, an event or a command's result. */
export interface SessionSecrets {
  readonly token: AuthToken
  readonly csrfToken: string
}

export const mintSessionSecrets = (tenantId: string, userId: string): SessionSecrets => ({ token: mintToken(tenantId, userId), csrfToken: newCsrfToken() })

/** A new session as a command may return it (plain JSON, a possible receipt): no token, no CSRF token. */
export interface StoredSession {
  readonly id: string
  readonly companyId: string | null
  readonly idleExpiresAt: string
  readonly absoluteExpiresAt: string
}

/** A new session with its secrets, after the command: the token and the CSRF token go to the cookies only. */
export interface StartedSession extends StoredSession {
  readonly token: string
  readonly csrfToken: string
}

/** The session of a command's result with the secrets minted before it, for the cookies and the answer. */
export const withSessionSecrets = (session: StoredSession, secrets: SessionSecrets): StartedSession => ({
  ...session,
  token: secrets.token.value,
  csrfToken: secrets.csrfToken,
})

/** The company a session starts in: the tenant's only active company, else none (the web then picks one). */
async function startingCompany(tx: CommandTx): Promise<string | null> {
  const companies = await tx.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 2 })
  return companies.length === 1 ? companies[0]!.id : null
}

/**
 * Writes a new session row from its token's hash (a command's work). The secrets were minted before the command and
 * stay outside it: neither the work nor its result (which a receipt could store) ever holds them.
 */
export async function createSession(tx: CommandTx, input: CreateSessionInput): Promise<StoredSession> {
  const id = newId()
  const { office } = sessionLengthsMs((await securityRulesIn(tx, input.tenantId)).rules)
  const absoluteExpiresAt = new Date(input.now.getTime() + office.longestMs)
  const idleExpiresAt = idleEndAfter(input.now, absoluteExpiresAt, office.idleMs)
  const companyId = await startingCompany(tx)
  const device = deviceOf(input.userAgent)
  await tx.session.create({
    data: {
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      companyId,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      mfaAt: input.mfaProved ? input.now : null,
      ipHash: input.ipHash,
      userAgent: input.userAgent?.slice(0, 256) ?? null,
      deviceLabel: device.deviceLabel,
      browser: device.browser,
      ipCountry: input.place?.ipCountry ?? null,
      ipCity: input.place?.ipCity ?? null,
    },
  })
  return { id, companyId, idleExpiresAt: toUtcIso(idleExpiresAt), absoluteExpiresAt: toUtcIso(absoluteExpiresAt) }
}

/**
 * `createSession` for a caller that hands in the secrets themselves (minted before the command, required): the answer
 * carries them again, so the work must strip them before it returns (users.acceptInvitation does). Prefer createSession.
 */
export async function startSession(tx: CommandTx, input: StartSessionInput & { readonly secrets: SessionSecrets }): Promise<StartedSession> {
  const { secrets, ...rest } = input
  return withSessionSecrets(await createSession(tx, { ...rest, tokenHash: tokenHash(secrets.token.value) }), secrets)
}

/** Ends every live session of a user (optionally but one). Returns how many ended. */
export async function endSessions(
  tx: CommandTx,
  input: { readonly userId: string; readonly now: Date; readonly reason: SessionEndReason; readonly exceptSessionId?: string },
): Promise<number> {
  const { count } = await tx.session.updateMany({
    where: { userId: input.userId, revokedAt: null, ...(input.exceptSessionId ? { id: { not: input.exceptSessionId } } : {}) },
    data: { revokedAt: input.now, revokedReason: input.reason },
  })
  return count
}
