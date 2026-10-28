import type { FastifyRequest } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import { NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isLinkLive, linkGrants, type LinkPurpose } from '@nexus/factory-domain/links/purposes'
import { matchesLinkHash, parseLinkToken } from '@nexus/factory-domain/links/token'
import type { Authenticator, SessionContext } from '../../core/context'
import type { Clock } from '../../core/time'

/**
 * The link authenticator (plan A1 §3.2 step 1, §3.10 "Links"; features SAL-099, PLT-007). A request that carries a
 * one-off link's token in the `x-factory-link` header (the web reads it from the link's fragment, `/l#token=…`, which no
 * server ever sees) is a link session, or nothing:
 *
 *   1. the token names the tenant, the party and the link (factory-domain links/token);
 *   2. the link is read in THAT party's partner scope (factory_partner_runtime, the party's row-level-security wall): a
 *      token that names another party, or another tenant, finds nothing;
 *   3. the stored SHA-256 must match the token's (constant time), and the link must be live: not revoked, before its
 *      expiry, with uses left (a use that races it is refused again inside its command);
 *   4. its tenant must be ACTIVE (read in the platform scope, the only table factory_platform reads);
 *   5. the context: audience `link`, the tenant, the link as actor, its party, its ONE record, and the grants of its
 *      purpose (never a role's): command() refuses any other record, the partner role's wall any other party.
 *
 * Every failure, whatever it is (a malformed token, an unknown link, a wrong secret, a forged party, expired, revoked,
 * used up, a suspended tenant), is the same 404 with the same message, so an answer tells nothing about a link. No
 * CSRF check: the token travels in a header another site cannot set, never in a cookie.
 */

export const LINK_HEADER = 'x-factory-link'

/** The one answer for every link that opens nothing. */
export const LINK_UNAVAILABLE = 'This link is not valid or no longer available. Ask the sender for a new one.'

export const linkUnavailable = (): NotFoundError => new NotFoundError(LINK_UNAVAILABLE)

/** What the link routes need to know about the request's link, beyond the context. */
export interface LinkSession {
  readonly id: string
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  readonly purpose: LinkPurpose
  readonly record: { readonly type: string; readonly id: string }
  /** The address the link was sent to (an accept checks it); never shown to the link's holder. */
  readonly email: string | null
  readonly expiresAt: Date
  readonly maxUses: number
  /** Counted uses when the request came in. */
  readonly uses: number
}

const sessions = new WeakMap<FastifyRequest, LinkSession>()

/** The link the authenticator opened for this request (routes with the link audience). */
export function linkSessionOf(request: FastifyRequest): LinkSession {
  const session = sessions.get(request)
  if (!session) throw new UnauthenticatedError()
  return session
}

/** The request carries a link token (whatever its value): it is a link session or nothing. */
export const carriesLink = (request: FastifyRequest): boolean => request.headers[LINK_HEADER] !== undefined

const LINK_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  purpose: true,
  recordType: true,
  recordId: true,
  tokenHash: true,
  email: true,
  expiresAt: true,
  maxUses: true,
  uses: true,
  revokedAt: true,
} as const

export function linkAuthenticator(core: { readonly database: FactoryDatabase; readonly clock: Clock }): Authenticator {
  return async (request): Promise<SessionContext> => {
    const header = request.headers[LINK_HEADER]
    const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
    if (!token) throw linkUnavailable()
    const now = core.clock.now()
    const scope = { audience: 'partner', tenantId: token.tenantId, actorId: token.linkId, partyId: token.partyId } as const
    const link = await core.database.withScope(scope, (client) => client.oneOffLink.findUnique({ where: { id: token.linkId }, select: LINK_SELECT }))
    if (!link || !matchesLinkHash(token, link.tokenHash) || link.partyId !== token.partyId || !isLinkLive(link, now)) throw linkUnavailable()
    const tenant = await core.database.withScope({ audience: 'platform' }, (client) =>
      client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }),
    )
    if (tenant?.status !== 'ACTIVE') throw linkUnavailable()

    const record = { type: link.recordType, id: link.recordId }
    sessions.set(request, {
      id: link.id,
      tenantId: token.tenantId,
      companyId: link.companyId,
      partyId: link.partyId,
      purpose: link.purpose,
      record,
      email: link.email,
      expiresAt: link.expiresAt,
      maxUses: link.maxUses,
      uses: link.uses,
    })
    return {
      audience: 'link',
      tenantId: token.tenantId,
      linkId: link.id,
      partyId: link.partyId,
      record,
      grants: linkGrants(link.purpose, { companyId: link.companyId, partyId: link.partyId }),
    }
  }
}

/**
 * The app's authenticator once links exist: a request with a link token is a link session (or the uniform 404);
 * any other goes to `next` (the office cookie).
 */
export function withLinkSessions(link: Authenticator, next: Authenticator): Authenticator {
  return (request) => (carriesLink(request) ? link(request) : next(request))
}
