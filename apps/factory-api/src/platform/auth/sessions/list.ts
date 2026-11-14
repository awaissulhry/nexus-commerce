import type { FastifyRequest } from 'fastify'
import type { FactoryClient, UserAudience } from '@nexus/factory-db'
import { deviceKindOf } from '@nexus/factory-domain/auth/sessions/device'
import { isLiveAt, liveUntil, sessionLengthsMs, type SecurityRules } from '@nexus/factory-domain/auth/sessions/lengths'
import { SESSION_REFUSALS, type SessionRefusal } from '@nexus/factory-domain/auth/sessions/refusals'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { requireContext, type OfficeContext } from '../../../core/context'
import { officeSessionOf } from './authenticator'
import type { OfficeAuth } from './office-auth'
import { securityRulesIn } from './rules'

/**
 * Active sessions and devices (B-W2b-404; PLT-064; design shell.profile "Where I'm signed in" with the confirm "Sign out
 * everywhere else?", admin.users › Sessions & sign-ins "Signed in now"):
 *
 *   mine        each person sees their own live sessions — device and browser, place (country, city), started, last used,
 *               "this browser" — and ends one or every other (revokedReason ENDED_BY_USER); no permission, no fresh code:
 *               ending sessions only narrows (the browser in use signs out instead)
 *   a person's  an administrator (users.sessions.manage) sees a person's live sessions the same way and ends all of them
 *               (ENDED_BY_ADMIN): never their own here (My profile), never anyone's address
 *
 * Live = not revoked and before its idle and absolute end under the tenant's lengths now (an office session; a portal
 * session or an office preview of a portal under the portal's). Each end is ONE command with its audit row; the ended
 * browser gets 401 at its next request.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

const SESSION_SELECT = {
  id: true,
  audience: true,
  previewOfPartyId: true,
  createdAt: true,
  lastSeenAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  deviceLabel: true,
  browser: true,
  ipCountry: true,
  ipCity: true,
} as const

type Row = { id: string; audience: UserAudience; previewOfPartyId: string | null; createdAt: Date; lastSeenAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date; revokedAt: Date | null; deviceLabel: string | null; browser: string | null; ipCountry: string | null; ipCity: string | null }

/** Where a session signs in: the office, a partner's portal, or an office person's preview of a portal. */
const surfaceOf = (row: Pick<Row, 'audience' | 'previewOfPartyId'>): 'OFFICE' | 'PORTAL' | 'PREVIEW' => (row.audience === 'OFFICE' ? 'OFFICE' : row.previewOfPartyId !== null ? 'PREVIEW' : 'PORTAL')

function endsOf(row: Row, rules: SecurityRules) {
  const lengths = sessionLengthsMs(rules)
  return liveUntil(row, row.audience === 'OFFICE' ? lengths.office : lengths.portal)
}

/** The live sessions of a person, last used first (at most 50). */
async function liveSessionsOf(client: FactoryClient | CommandTx, tenantId: string, userId: string, now: Date): Promise<{ row: Row; ends: ReturnType<typeof endsOf> }[]> {
  const { rules } = await securityRulesIn(client, tenantId)
  const rows = await client.session.findMany({
    where: { userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
    take: 50,
    select: SESSION_SELECT,
  })
  return rows.flatMap((row) => {
    const ends = endsOf(row, rules)
    return isLiveAt(ends, now) ? [{ row, ends }] : []
  })
}

function sessionView(entry: { row: Row; ends: ReturnType<typeof endsOf> }, currentId: string | null) {
  const { row, ends } = entry
  return {
    id: row.id,
    current: row.id === currentId,
    surface: surfaceOf(row),
    deviceKind: deviceKindOf(row.deviceLabel),
    deviceLabel: row.deviceLabel,
    browser: row.browser,
    place: { country: row.ipCountry, city: row.ipCity },
    startedAt: toUtcIso(row.createdAt),
    lastUsedAt: toUtcIso(row.lastSeenAt),
    idleExpiresAt: toUtcIso(ends.idleExpiresAt),
    absoluteExpiresAt: toUtcIso(ends.absoluteExpiresAt),
  }
}

const refused = (status: 'not_found' | 'conflict' | 'forbidden', code: SessionRefusal) =>
  status === 'not_found' ? new NotFoundError(SESSION_REFUSALS[code]) : new DomainError(status, SESSION_REFUSALS[code], [{ path: `sessions/${code}`, message: SESSION_REFUSALS[code] }])

/** GET /auth/sessions: my live sessions. */
export async function mySessions(auth: OfficeAuth, request: FastifyRequest) {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const live = await request.withClient((client) => liveSessionsOf(client, context.tenantId, context.actorId, auth.clock.now()))
  return { sessions: live.map((entry) => sessionView(entry, session.id)) }
}

/** POST /auth/sessions/:sessionId/end: ends one of my other sessions. */
export async function endMySession(auth: OfficeAuth, request: FastifyRequest, sessionId: string) {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  if (sessionId === session.id) throw refused('conflict', 'current')
  const { result } = await auth.command(context, { name: 'auth.endSession', input: { sessionId } }, async ({ tx, now, audit }) => {
    const live = await liveSessionsOf(tx, context.tenantId, context.actorId, now)
    const target = live.find((entry) => entry.row.id === sessionId)
    if (!target) throw refused('not_found', 'notFound')
    await tx.session.updateMany({ where: { id: sessionId, userId: context.actorId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'ENDED_BY_USER' } })
    audit({ recordType: 'Session', recordId: sessionId, companyId: null, after: { revokedReason: 'ENDED_BY_USER', from: session.id } })
    return { ended: 1 }
  })
  return result
}

/** POST /auth/sessions/end-others: signs out everywhere else; this browser goes on. */
export async function endMyOtherSessions(auth: OfficeAuth, request: FastifyRequest) {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const { result } = await auth.command(context, { name: 'auth.endOtherSessions', input: { kept: session.id } }, async ({ tx, now, audit }) => {
    const ids = (await liveSessionsOf(tx, context.tenantId, context.actorId, now)).map((entry) => entry.row.id).filter((id) => id !== session.id)
    const { count } = ids.length === 0 ? { count: 0 } : await tx.session.updateMany({ where: { id: { in: ids }, userId: context.actorId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'ENDED_BY_USER' } })
    audit({ recordType: 'User', recordId: context.actorId, companyId: null, after: { revokedReason: 'ENDED_BY_USER', sessionsEnded: count, kept: session.id } })
    return { ended: count }
  })
  return result
}

async function assertAnotherPerson(client: FactoryClient | CommandTx, context: OfficeContext, userId: string): Promise<void> {
  if (userId === context.actorId) throw refused('conflict', 'self')
  const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) throw new NotFoundError('User not found.')
}

/** GET /auth/users/:userId/sessions: a person's live sessions (Admin › Users › Sessions & sign-ins). */
export async function userSessions(auth: OfficeAuth, request: FastifyRequest, userId: string) {
  const context = officeContextOf(request)
  const live = await request.withClient(async (client) => {
    await assertAnotherPerson(client, context, userId)
    return liveSessionsOf(client, context.tenantId, userId, auth.clock.now())
  })
  return { sessions: live.map((entry) => sessionView(entry, null)) }
}

/** POST /auth/users/:userId/sessions/end: ends every session of a person (an administrator's). */
export async function endUserSessions(auth: OfficeAuth, request: FastifyRequest, userId: string, body: { readonly reason?: string | undefined }) {
  const context = officeContextOf(request)
  const { result } = await auth.command(context, { name: 'users.endSessions', input: { userId, ...body } }, async ({ tx, now, audit }) => {
    await assertAnotherPerson(tx, context, userId)
    const { count } = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'ENDED_BY_ADMIN' } })
    audit({ recordType: 'User', recordId: userId, companyId: null, after: { revokedReason: 'ENDED_BY_ADMIN', sessionsEnded: count }, ...(body.reason ? { reason: body.reason } : {}) })
    return { ended: count }
  })
  return result
}
