import type { FastifyRequest } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import { partnerGrants, portalAccessProblem } from '@nexus/factory-domain/auth/portal/access'
import { PORTAL_SESSION, portalIdleExpiryAt } from '@nexus/factory-domain/auth/portal/session'
import { isLiveAt, liveUntil, sessionLengthsMs } from '@nexus/factory-domain/auth/sessions/lengths'
import { matchesPortalToken, parsePortalToken, portalTokenHash, type PortalToken } from '@nexus/factory-domain/auth/portal/token'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { Authenticator, SessionContext } from '../../../core/context'
import type { RouteManifestEntry } from '../../../core/manifest'
import type { Clock } from '../../../core/time'
import { isFloorRequest } from '../floor/authenticator'
import { assertCsrf, isUnsafeMethod, sessionCookieOf } from '../sessions/cookies'
import { securityRulesIn } from '../sessions/rules'
import { portalCookieOf } from './cookies'
// B-W2b-162: an office preview reads what the party's people could read (no write, no money).
import { previewGrants } from '../partners/preview-grants'
import { companyById, partnerById, partnerRoles, partyOf, portalOn, termsState, type PortalCompany, type TermsState } from './store'

/**
 * The partner authenticator (B-W2b-159; A1 §3.2 step 1, §3.10; design portal.frame). For a request to a partner route
 * that carries the `__Host-factory_portal` cookie (sessions/office-auth.ts chains it, `withPortalSessions`):
 *
 *   1. the token names the tenant, the party and the person (auth/portal/token.ts); the session is read by the token's
 *      hash in THAT party's partner scope (factory_partner_runtime, the party's row-level-security wall): a cookie that
 *      names another party or tenant finds nothing; the stored hash is compared in constant time;
 *   2. it must be a live PARTNER session of that party and person: not revoked, before its idle end (30 minutes) and its
 *      absolute end (12 hours);
 *   3. in the tenant's office scope: the person is still a partner person of that party who may use the portal now —
 *      ACTIVE, before their end of access, the organisation neither blocked nor archived, its portal switched on, the
 *      company's portal terms in force (auth/portal/access.ts); an office preview (B-W2b-162's rows: previewOfPartyId)
 *      instead needs its office person ACTIVE; and the tenant ACTIVE (platform scope);
 *   4. an unsafe method passes the CSRF double submit; an office preview is read-only (403), but for the idle refresh;
 *   5. the idle end slides forward (at most once a minute, never past the absolute end; office scope: the partner role
 *      only reads Session): bookkeeping, not audited;
 *   6. the context: audience partner, the tenant, the person, the party, and the grants of the person's live PARTNER
 *      roles over the session's company and party, price at most — none until the person acknowledged the portal terms
 *      in force (the first visit); an office preview holds the reads its party's people could do, no money (B-W2b-162).
 * Anything else: no session (401). The person's status, organisation and portal are read on every request, so a
 * suspension, a block, an end of access or the portal switched off stops a session at its next request.
 */

/** What the portal routes need to know about the request's portal session, beyond the context. */
export interface PortalSession {
  readonly id: string
  readonly tenantId: string
  readonly userId: string
  readonly partyId: string
  readonly company: PortalCompany
  readonly createdAt: Date
  readonly idleExpiresAt: Date
  readonly absoluteExpiresAt: Date
  /** B-W2b-404 (PLT-068): the tenant's portal idle time now (SecuritySettings; 30 minutes at most). */
  readonly idleMs: number
  readonly stepUpAt: Date | null
  /** An office person previewing the party's portal (read-only; B-W2b-162). */
  readonly preview: boolean
  readonly person: {
    readonly email: string
    readonly displayName: string
    readonly locale: string
    readonly partnerKind: string | null
    readonly accessUntil: Date | null
  }
  readonly party: { readonly id: string; readonly name: string }
  /** The company's portal terms in force and whether the person acknowledged them; null: none in force (preview: null). */
  readonly terms: TermsState | null
}

const sessions = new WeakMap<FastifyRequest, PortalSession>()

/** The portal session the authenticator found for this request (routes with the partner audience). */
export function portalSessionOf(request: FastifyRequest): PortalSession {
  const session = sessions.get(request)
  if (!session) throw new UnauthenticatedError()
  return session
}

/** The routes a preview may still call with an unsafe method (bookkeeping only). */
const PREVIEW_WRITES = new Set(['/portal/sessions/refresh'])

const SESSION_SELECT = {
  id: true,
  userId: true,
  tokenHash: true,
  companyId: true,
  createdAt: true,
  lastSeenAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  stepUpAt: true,
  revokedAt: true,
  audience: true,
  partyId: true,
  previewOfPartyId: true,
  previewById: true,
} as const

export function portalAuthenticator(core: { readonly database: FactoryDatabase; readonly clock: Clock }): Authenticator {
  return async (request): Promise<SessionContext | null> => {
    const token: PortalToken | null = parsePortalToken('session', portalCookieOf(request))
    if (!token) return null
    const now = core.clock.now()
    const partner = { audience: 'partner', tenantId: token.tenantId, actorId: token.userId, partyId: token.scopeId } as const
    const row = await core.database.withScope(partner, (client) => client.session.findUnique({ where: { tokenHash: tokenHashOf(token) }, select: SESSION_SELECT }))
    if (
      !row ||
      !matchesPortalToken(token, row.tokenHash) ||
      row.audience !== 'PARTNER' ||
      row.partyId !== token.scopeId ||
      row.userId !== token.userId ||
      row.companyId === null ||
      row.revokedAt !== null ||
      row.idleExpiresAt.getTime() <= now.getTime() ||
      row.absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      return null
    }
    const companyId = row.companyId
    const preview = row.previewOfPartyId !== null
    const tenant = await core.database.withScope({ audience: 'platform' }, (client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
    if (tenant?.status !== 'ACTIVE') return null

    const office = { audience: 'office', tenantId: token.tenantId, actorId: token.userId } as const
    const found = await core.database.withScope(office, async (client) => {
      // B-W2b-404 (PLT-068): the tenant's portal lengths now; a shorter one ends an open session at its next request.
      const lengths = sessionLengthsMs((await securityRulesIn(client, token.tenantId)).rules).portal
      const ends = liveUntil(row, lengths)
      if (!isLiveAt(ends, now)) return null
      const company = await companyById(client, companyId)
      const party = await partyOf(client, token.scopeId)
      if (!company || !party) return null
      if (preview) {
        const viewer = await client.user.findUnique({ where: { id: token.userId }, select: { email: true, displayName: true, locale: true, status: true, audience: true } })
        if (!viewer || viewer.audience !== 'OFFICE' || viewer.status !== 'ACTIVE' || row.previewById !== token.userId) return null
        return { company, party, person: { ...viewer, partnerKind: null, accessUntil: null }, terms: null, roles: [], previewGrants: await previewGrants(client, { companyId, partyId: party.id }), ends, lengths }
      }
      const person = await partnerById(client, token.userId)
      if (!person || person.partyId !== token.scopeId) return null
      const terms = await termsState(client, companyId, person.id)
      const problem = portalAccessProblem({ user: person, party, portalOn: await portalOn(client, party.id), termsInForce: terms !== null }, now)
      if (problem !== null) return null
      return { company, party, person, terms, roles: await partnerRoles(client, person.id, now), previewGrants: [], ends, lengths }
    })
    if (!found) return null

    if (isUnsafeMethod(request.method)) {
      assertCsrf(request)
      if (preview && !PREVIEW_WRITES.has(request.routeOptions.url ?? '')) throw new ForbiddenError('This is a preview of the portal: it is read-only.')
    }

    let idleExpiresAt = found.ends.idleExpiresAt
    if (now.getTime() - row.lastSeenAt.getTime() >= PORTAL_SESSION.slideEveryMs) {
      idleExpiresAt = portalIdleExpiryAt(now, found.ends.absoluteExpiresAt, found.lengths.idleMs)
      await core.database.withScope(office, (client) => client.session.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } }))
    }

    sessions.set(request, {
      id: row.id,
      tenantId: token.tenantId,
      userId: token.userId,
      partyId: token.scopeId,
      company: found.company,
      createdAt: row.createdAt,
      idleExpiresAt,
      absoluteExpiresAt: found.ends.absoluteExpiresAt,
      idleMs: found.lengths.idleMs,
      stepUpAt: row.stepUpAt,
      preview,
      person: {
        email: found.person.email,
        displayName: found.person.displayName,
        locale: found.person.locale,
        partnerKind: found.person.partnerKind,
        accessUntil: found.person.accessUntil,
      },
      party: { id: found.party.id, name: found.party.name },
      terms: found.terms,
    })
    return {
      audience: 'partner',
      tenantId: token.tenantId,
      actorId: token.userId,
      partyId: token.scopeId,
      grants: preview ? found.previewGrants : partnerGrants(found.roles, { companyId, partyId: token.scopeId }, { termsAcknowledged: found.terms?.acknowledged === true, preview }),
    }
  }
}

const tokenHashOf = (token: PortalToken): string => portalTokenHash(token.value)

/**
 * The request goes to the portal authenticator: a route of partner sessions only (no office or floor audience) reads
 * the portal cookie or nothing; a route shared with office or floor sessions (files, threads) reads it only when it is
 * the request's one session cookie, so an office browser and a floor tablet keep their own sessions there.
 */
export function portalRequest(request: FastifyRequest): boolean {
  const entry = (request.routeOptions?.config as { manifest?: RouteManifestEntry } | undefined)?.manifest
  if (!entry || entry.audiences === 'public') return false
  const audiences = entry.audiences as readonly string[]
  if (!audiences.includes('partner')) return false
  if (!audiences.includes('office') && !audiences.includes('floor')) return true
  return portalCookieOf(request) !== null && sessionCookieOf(request) === null && !isFloorRequest(request)
}

/**
 * The app's authenticator with portal sessions (sessions/office-auth.ts): a request to a partner route is a portal
 * session or nothing (no office fallback: an office cookie never opens a partner route, a portal cookie never an office
 * route); any other request goes to `next` (the floor and office cookies).
 */
export function withPortalSessions(portal: Authenticator, next: Authenticator): Authenticator {
  return (request) => (portalRequest(request) ? portal(request) : next(request))
}
