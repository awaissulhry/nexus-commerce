import type { SessionEndReason } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { newCsrfToken } from './cookies'
import { mintToken, tokenHash, type AuthToken } from './secrets'

/**
 * Office session rows (plan A1 §2.3 Session, §3.10; ported from Commerce's apps/api/src/lib/auth/session.ts): server
 * side, so a revocation takes effect on the next request. A session lives until it is revoked, until 8 hours pass
 * without a request (the idle expiry slides forward with use, at most one write a minute, never past the absolute
 * expiry) or until 7 days after sign-in. Always written inside a command's transaction.
 */

export const SESSION_LIFETIME = Object.freeze({
  idleMs: 8 * 60 * 60_000,
  absoluteMs: 7 * 24 * 60 * 60_000,
  /** The idle expiry is moved at most this often (one write a minute per session, not one per request). */
  slideEveryMs: 60_000,
})

/** A step-up (a fresh code) opens the risky actions for this long. */
export const STEP_UP_VALID_MS = 5 * 60_000

/** The idle expiry after a request at `now`, never later than the absolute one. */
export const idleExpiryAt = (now: Date, absoluteExpiresAt: Date): Date =>
  new Date(Math.min(now.getTime() + SESSION_LIFETIME.idleMs, absoluteExpiresAt.getTime()))

export interface StartSessionInput {
  readonly tenantId: string
  readonly userId: string
  readonly now: Date
  /** The second factor was proved by this sign-in. */
  readonly mfaProved: boolean
  readonly ipHash: string | null
  readonly userAgent: string | undefined
  /**
   * The session's secrets, minted before the command (`mintSessionSecrets`), so the command's result never has to
   * carry them: a result can become an Idempotency-Key receipt, and a receipt is stored. Left out, they are minted here.
   */
  readonly secrets?: SessionSecrets
}

/** A session's cookie token and CSRF token. Never in a row, an audit entry, an event or a command's result. */
export interface SessionSecrets {
  readonly token: AuthToken
  readonly csrfToken: string
}

export const mintSessionSecrets = (tenantId: string, userId: string): SessionSecrets => ({ token: mintToken(tenantId, userId), csrfToken: newCsrfToken() })

/** A new session, as plain JSON (a command's result). The token and the CSRF token go to the cookies only. */
export interface StartedSession {
  readonly id: string
  readonly token: string
  readonly csrfToken: string
  readonly companyId: string | null
  readonly idleExpiresAt: string
  readonly absoluteExpiresAt: string
}

/** The company a session starts in: the tenant's only active company, else none (the web then picks one). */
async function startingCompany(tx: CommandTx): Promise<string | null> {
  const companies = await tx.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 2 })
  return companies.length === 1 ? companies[0]!.id : null
}

export async function startSession(tx: CommandTx, input: StartSessionInput): Promise<StartedSession> {
  const secrets = input.secrets ?? mintSessionSecrets(input.tenantId, input.userId)
  const token = secrets.token
  const id = newId()
  const absoluteExpiresAt = new Date(input.now.getTime() + SESSION_LIFETIME.absoluteMs)
  const idleExpiresAt = idleExpiryAt(input.now, absoluteExpiresAt)
  const companyId = await startingCompany(tx)
  await tx.session.create({
    data: {
      id,
      userId: input.userId,
      tokenHash: tokenHash(token.value),
      companyId,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      mfaAt: input.mfaProved ? input.now : null,
      ipHash: input.ipHash,
      userAgent: input.userAgent?.slice(0, 256) ?? null,
    },
  })
  return {
    id,
    token: token.value,
    csrfToken: secrets.csrfToken,
    companyId,
    idleExpiresAt: toUtcIso(idleExpiresAt),
    absoluteExpiresAt: toUtcIso(absoluteExpiresAt),
  }
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
