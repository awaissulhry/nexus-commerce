import type { FastifyRequest } from 'fastify'
import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Authenticator, SessionContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { assertCsrf, isUnsafeMethod, sessionCookieOf } from './cookies'
import { sessionAccess } from './grants'
import { parseToken, tokenHash, type AuthToken } from './secrets'
import { idleExpiryAt, SESSION_LIFETIME } from './session-store'

/**
 * The real Authenticator for office cookies (plan A1 §3.2 step 1, §3.10). For every request that is not public:
 *
 *   1. the `__Host-factory_session` cookie names the tenant and the user; the session is looked up by the token's
 *      hash in that tenant's office scope (factory_runtime: a cookie that names another tenant finds nothing);
 *   2. it must be live: not revoked, before its idle and absolute expiry, its user ACTIVE (a suspended or deactivated
 *      user's sessions stop at once, even one that raced the suspension) and its tenant ACTIVE;
 *   3. an unsafe method (POST, PUT, PATCH, DELETE) must pass the CSRF double submit (403 otherwise);
 *   4. the company: the `x-factory-company` header (a company id or code of the tenant, active), else the session's
 *      starting company; an unknown company is a 403;
 *   5. the idle expiry slides forward (at most once a minute; bookkeeping, not audited);
 *   6. the context: office, tenant, user, company, and the grants of the person's live role assignments
 *      (sessions/grants.ts; a role that requires two-factor gives nothing until it was proved on the session).
 * No cookie, or a cookie that opens nothing: no session (401). Floor devices, portal and link sessions are not read
 * here; their steps add them, until then they get no session.
 */

export const COMPANY_HEADER = 'x-factory-company'

/** What the auth routes need to know about the request's session, beyond the context. */
export interface OfficeSession {
  readonly id: string
  readonly tenantId: string
  readonly userId: string
  readonly companyId: string | null
  readonly createdAt: Date
  readonly idleExpiresAt: Date
  readonly absoluteExpiresAt: Date
  readonly mfaAt: Date | null
  readonly stepUpAt: Date | null
  readonly user: {
    readonly email: string
    readonly displayName: string
    readonly locale: string
    /** Holds the owner system role now. */
    readonly isOwner: boolean
    /** Two-factor is required now: the person's own flag or a role they hold. */
    readonly requireMfa: boolean
    readonly totpEnabled: boolean
  }
}

const sessions = new WeakMap<FastifyRequest, OfficeSession>()

/** The office session the authenticator found for this request (routes with an office audience). */
export function officeSessionOf(request: FastifyRequest): OfficeSession {
  const session = sessions.get(request)
  if (!session) throw new UnauthenticatedError()
  return session
}

const SESSION_SELECT = {
  id: true,
  userId: true,
  companyId: true,
  createdAt: true,
  lastSeenAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  mfaAt: true,
  stepUpAt: true,
  revokedAt: true,
  company: { select: { status: true } },
  user: {
    select: { email: true, displayName: true, locale: true, status: true, requireMfa: true, totpConfirmedAt: true, tenant: { select: { status: true } } },
  },
} as const

type SessionRow = NonNullable<Awaited<ReturnType<typeof findSession>>>

const findSession = (client: FactoryClient, token: AuthToken) =>
  client.session.findUnique({ where: { tokenHash: tokenHash(token.value) }, select: SESSION_SELECT })

/** The live session of a token, or null (unknown, revoked, expired, its user not active, its tenant suspended). */
export async function liveSession(client: FactoryClient, token: AuthToken, now: Date): Promise<SessionRow | null> {
  const row = await findSession(client, token)
  if (!row || row.userId !== token.userId || row.revokedAt !== null || row.user.status !== 'ACTIVE' || row.user.tenant.status !== 'ACTIVE') return null
  if (row.idleExpiresAt.getTime() <= now.getTime() || row.absoluteExpiresAt.getTime() <= now.getTime()) return null
  return row
}

async function companyOf(client: FactoryClient, request: FastifyRequest, row: SessionRow): Promise<string | null> {
  const header = request.headers[COMPANY_HEADER]
  if (header === undefined) return row.companyId !== null && row.company?.status === 'ACTIVE' ? row.companyId : null
  const value = typeof header === 'string' ? header.trim() : ''
  const where = isUuid(value) ? { id: value.toLowerCase() } : /^[A-Za-z0-9._-]{1,32}$/.test(value) ? { code: value } : null
  const company = where && (await client.company.findFirst({ where: { ...where, status: 'ACTIVE' }, select: { id: true } }))
  if (!company) throw new ForbiddenError(`The company in ${COMPANY_HEADER} is not an active company of this tenant.`)
  return company.id
}

export function officeAuthenticator(core: { readonly database: FactoryDatabase; readonly clock: Clock }): Authenticator {
  return async (request): Promise<SessionContext | null> => {
    const token = parseToken(sessionCookieOf(request))
    if (!token) return null
    const now = core.clock.now()
    return core.database.withScope({ audience: 'office', tenantId: token.tenantId, actorId: token.userId }, async (client) => {
      const row = await liveSession(client, token, now)
      if (!row) return null
      if (isUnsafeMethod(request.method)) assertCsrf(request)
      const companyId = await companyOf(client, request, row)
      const access = await sessionAccess(client, { id: token.userId, requireMfa: row.user.requireMfa }, row, now)

      let idleExpiresAt = row.idleExpiresAt
      if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_LIFETIME.slideEveryMs) {
        idleExpiresAt = idleExpiryAt(now, row.absoluteExpiresAt)
        await client.session.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } })
      }

      sessions.set(request, {
        id: row.id,
        tenantId: token.tenantId,
        userId: token.userId,
        companyId,
        createdAt: row.createdAt,
        idleExpiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
        mfaAt: row.mfaAt,
        stepUpAt: row.stepUpAt,
        user: {
          email: row.user.email,
          displayName: row.user.displayName,
          locale: row.user.locale,
          isOwner: access.isOwner,
          requireMfa: access.requireMfa,
          totpEnabled: row.user.totpConfirmedAt !== null,
        },
      })
      return {
        audience: 'office',
        tenantId: token.tenantId,
        actorId: token.userId,
        ...(companyId ? { companyId } : {}),
        grants: access.grants,
      }
    })
  }
}
