import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isPartnerKind, type PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { PORTAL_COLLEAGUES_MANAGE } from '@nexus/factory-domain/auth/partners/permissions'
import { accessEndsSoon, PARTNER_WORDS, seatProblem, splitRoleKeys, type AccessChoice } from '@nexus/factory-domain/auth/partners/rules'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../portal/authenticator'
import { portalOf } from '../portal/service'
import { requirePortalStepUp } from '../portal/step-up'
import { emailOrThrow } from '../users/email'
import { adminFacts, userStatus } from '../users/status'
import type { ColleagueChangeBody, ColleagueInviteBody } from './contract'
import { mailInvitation, rolesView } from './office'
import { changeInCommand, inviteInCommand, revokeInCommand, statusInCommand } from './people'
import { lockParty, PERSON_SELECT, peopleOf, personOf, seatsTaken, settingsOf, withAccess, type PartnerPerson } from './store'

/**
 * The partner's own people in the portal (B-W2b-162; SAL-060, SAL-059, SAL-069, SCM-092; design portal.customer.account and
 * portal.supplier.profile › users, portal.frame access-rules "My access"):
 *
 *   GET   /portal/access                       the signed-in person's role, what it allows, their end of access, their admin
 *   GET   /portal/colleagues                   the organisation's people of the person's kind: names and roles for everyone
 *                                              ("Your admin is …"), and for its admin also addresses, last sign-in,
 *                                              invitations, the roles its portal offers and the seats
 *   POST  /portal/colleagues                   the admin invites a colleague (within the factory's limits)
 *   PATCH /portal/colleagues/:userId           the admin changes a colleague's role or capabilities ("raises a role")
 *   POST  /portal/colleagues/:userId/deactivate
 *   B-CP-073 (customer page plan D13, C6; review G2, F4) — a CUSTOMER's admin runs its own team further (a supplier's or a
 *   workshop's admin reaches none of these: 403, the API is the customer's):
 *   POST  /portal/colleagues/:userId/invitation          the invitation again (an INVITED person only; the newest one's role)
 *   POST  /portal/colleagues/:userId/invitation/revoke   the open invitation withdrawn (the person DEACTIVATED: invite again later)
 *   POST  /portal/colleagues/:userId/suspend             access paused {version, reason?} (their sessions end at once)
 *   POST  /portal/colleagues/:userId/reactivate          access given back {version} (held while every seat of maxUsers is taken)
 *   Each sends the person row's version (a stale one: 409).
 * The admin's acts need a step-up by e-mail code on the session (B-W2b-159 requirePortalStepUp) and reach only colleagues of
 * the admin's own kind, never the admin's own access. They run as the partner person in the office scope (the partner role
 * writes no Role, RoleAssignment or Invitation): the same commands as the office's (people.ts), `byPartner` in their audit
 * rows and events. A colleague the admin invites gets the admin's own end of access, if any (never a longer one). Seats and
 * the roles offered stay the office's (Portal access).
 */

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The party's people of a kind (all kinds in a preview) as the session's party sees them (row-level security: its own). */
async function partyPeople(app: FastifyInstance, request: FastifyRequest, session: PortalSession, kind: PartnerKind | null): Promise<PartnerPerson[]> {
  const p = portalOf(app)
  const rows = await request.withClient((client) =>
    client.user.findMany({
      where: { partyId: session.partyId, audience: 'PARTNER', status: { not: 'DEACTIVATED' }, ...(kind ? { partnerKind: kind } : {}) },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 500,
      select: PERSON_SELECT,
    }),
  )
  return p.auth.inTenant(session.tenantId, session.userId, (client) => withAccess(client, rows as Parameters<typeof withAccess>[1], p.auth.clock.now()))
}

const adminsOf = (people: readonly PartnerPerson[]) =>
  people.filter((person) => person.status === 'ACTIVE' && person.roleKey !== null && partnerTemplateOf(person.roleKey)?.admin === true).map((person) => ({ id: person.id, displayName: person.displayName, email: person.email }))

const kindOf = (session: PortalSession): PartnerKind | null => (session.preview ? null : isPartnerKind(session.person.partnerKind) ? session.person.partnerKind : null)

export async function myAccess(app: FastifyInstance, request: FastifyRequest) {
  const session = portalSessionOf(request)
  const context = requireContext(request)
  const now = portalOf(app).auth.clock.now()
  const kind = kindOf(session)
  const people = await partyPeople(app, request, session, kind)
  const me = people.find((person) => person.id === session.userId)
  const template = me?.roleKey ? partnerTemplateOf(me.roleKey) : undefined
  const names = [...new Set(context.grants.flatMap((grant) => grant.permissions))].filter((name) => !name.startsWith('money.')).sort()
  return {
    kind,
    role: template ? { key: template.key, name: template.name, description: template.description, seesPrices: template.grains.includes('price'), admin: template.admin } : null,
    capabilities: [...(me?.capabilities ?? [])],
    allows: names.map((name) => ({ permission: name, description: FACTORY_PERMISSIONS.get(name)?.description ?? name })),
    accessUntil: iso(session.person.accessUntil),
    accessEndsSoon: accessEndsSoon(session.person.accessUntil, now),
    admins: adminsOf(people),
    preview: session.preview,
  }
}

export async function colleagues(app: FastifyInstance, request: FastifyRequest) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const canManage = !session.preview && holds(actorOf(requireContext(request)), PORTAL_COLLEAGUES_MANAGE)
  const kind = kindOf(session)
  const people = await partyPeople(app, request, session, kind)
  const shown = canManage ? people : people.filter((person) => person.status === 'ACTIVE')
  const limits = canManage && kind
    ? await p.auth.inTenant(session.tenantId, session.userId, async (client) => {
        const settings = await settingsOf(client, session.partyId)
        const taken = (await peopleOf(client, session.partyId, p.auth.clock.now())).filter((person) => person.seat).length
        return { roles: rolesView([kind], settings.allowedRoleKeys), seats: { taken, max: settings.maxUsers } }
      })
    : null
  return {
    me: session.userId,
    canManage,
    admins: adminsOf(people),
    people: shown.map((person) => {
      const template = person.roleKey ? partnerTemplateOf(person.roleKey) : undefined
      return {
        id: person.id,
        displayName: person.displayName,
        email: canManage ? person.email : null,
        status: person.status,
        roleKey: person.roleKey,
        roleName: template?.name ?? null,
        seesPrices: template?.grains.includes('price') === true,
        admin: template?.admin === true,
        capabilities: [...person.capabilities],
        lastSignInAt: canManage ? iso(person.lastSignInAt) : null,
        invitationExpiresAt: canManage && person.invitation ? toUtcIso(person.invitation.expiresAt) : null,
        version: person.version,
      }
    }),
    roles: limits?.roles ?? [],
    seats: limits?.seats ?? null,
  }
}

/** The admin's own kind (a guest adviser and a preview have no colleagues to manage). */
function adminKind(session: PortalSession): PartnerKind {
  const kind = kindOf(session)
  if (kind === null || kind === 'GUEST') throw new ForbiddenError()
  return kind
}

/** A colleague of the admin's kind, never the admin. */
async function reachColleague(app: FastifyInstance, session: PortalSession, kind: PartnerKind, userId: string): Promise<PartnerPerson> {
  if (userId === session.userId) throw new ForbiddenError(PARTNER_WORDS.ownAccess)
  const p = portalOf(app)
  const person = await p.auth.inTenant(session.tenantId, session.userId, (client) => personOf(client, session.partyId, userId, p.auth.clock.now()))
  if (!person || person.kind !== kind) throw new NotFoundError('Colleague not found.')
  return person
}

const contextOf = (app: FastifyInstance, request: FastifyRequest, session: PortalSession) => portalOf(app).auth.contextFor(request, session.tenantId, session.userId)

export async function inviteColleague(app: FastifyInstance, request: FastifyRequest, body: ColleagueInviteBody, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const kind = adminKind(session)
  requirePortalStepUp(app, request)
  const email = emailOrThrow(body.email)
  const template = partnerTemplateOf(body.roleKey)
  const choice: AccessChoice = {
    kind,
    roleKey: body.roleKey,
    capabilities: body.capabilities ?? (template?.kind === kind ? [...template.capabilities.byDefault] : []),
    accessUntil: session.person.accessUntil,
  }
  const locale = body.locale ?? (session.person.locale === 'en' ? 'en' : 'it')
  const outcome = await p.auth.command(
    contextOf(app, request, session),
    { name: 'portal.inviteColleague', idempotencyKey, input: { email, displayName: body.displayName, locale, roleKey: choice.roleKey, capabilities: choice.capabilities, sessionId: session.id } },
    (tools) => inviteInCommand(tools, { partyId: session.partyId, companyId: session.company.id, email, displayName: body.displayName, locale, choice }, { actorId: session.userId, byPartner: true }),
  )
  if (outcome.replayed) return { invitation: outcome.result.invitation, delivery: 'already_sent' as const }
  await mailInvitation(p.auth, request, { tenantId: session.tenantId, companyId: session.company.id, invitedBy: `${session.person.displayName} (${session.party.name})`, result: outcome.result, roleKey: choice.roleKey })
  return { invitation: outcome.result.invitation, delivery: 'sent' as const }
}

export async function changeColleague(app: FastifyInstance, request: FastifyRequest, userId: string, body: ColleagueChangeBody, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const kind = adminKind(session)
  requirePortalStepUp(app, request)
  await reachColleague(app, session, kind, userId)
  const { result } = await p.auth.command(
    contextOf(app, request, session),
    { name: 'portal.changeColleague', idempotencyKey, input: { userId, ...body, sessionId: session.id }, record: { type: 'User', id: userId, expectedVersion: body.version } },
    (tools) => changeInCommand(tools, { partyId: session.partyId, userId, roleKey: body.roleKey, capabilities: body.capabilities }, { actorId: session.userId, byPartner: true }, session.company.id),
  )
  return result
}

export async function deactivateColleague(app: FastifyInstance, request: FastifyRequest, userId: string, body: { readonly version: number }) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  const kind = adminKind(session)
  requirePortalStepUp(app, request)
  await reachColleague(app, session, kind, userId)
  const { result } = await p.auth.command(
    contextOf(app, request, session),
    {
      name: 'portal.deactivateColleague',
      input: { userId, ...body, sessionId: session.id },
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: 'DEACTIVATED' as const, facts: adminFacts(userId, p.auth.clock.now()) } },
    },
    (tools) => statusInCommand(tools, { partyId: session.partyId, userId, change: 'deactivate' }, { actorId: session.userId, byPartner: true }, session.company.id),
  )
  return result
}

// ---- B-CP-073 (customer page plan D13, C6; review G2 every act sends the person's version, F4 customer only) --------------------

/** The CUSTOMER admin's kind: these acts are the customer portal's (a supplier's or workshop's admin: 403, like any non-admin). */
function customerAdmin(session: PortalSession): PartnerKind {
  const kind = adminKind(session)
  if (kind !== 'CUSTOMER') throw new ForbiddenError()
  return kind
}

/** The colleague reached for an act (own party, own kind, never the admin), at the version the admin read (else 409). */
async function colleagueAt(app: FastifyInstance, session: PortalSession, userId: string, version: number): Promise<PartnerPerson> {
  const person = await reachColleague(app, session, customerAdmin(session), userId)
  if (person.version !== version) throw new ConflictError(`This colleague changed since you read it (now version ${person.version}). Read it again.`)
  return person
}

/** POST /portal/colleagues/:userId/invitation — the invitation again, with the newest one's role and end of access. */
export async function resendColleagueInvitation(app: FastifyInstance, request: FastifyRequest, userId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  customerAdmin(session)
  requirePortalStepUp(app, request)
  const person = await colleagueAt(app, session, userId, body.version)
  if (person.status !== 'INVITED' || person.kind === null) throw new InvalidStateError('Only an invited colleague is sent the invitation again.')
  const latest = await p.auth.inTenant(session.tenantId, session.userId, (client) =>
    client.invitation.findFirst({ where: { userId, audience: 'PARTNER' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { partnerRoleKeys: true, accessUntil: true } }),
  )
  const split = splitRoleKeys(latest?.partnerRoleKeys ?? [])
  if (!latest || split.roleKey === null) throw new InvalidStateError(PARTNER_WORDS.notInvited)
  const now = p.auth.clock.now()
  // Never longer than the admin's own end of access (as an invitation the admin sends).
  const until = latest.accessUntil && latest.accessUntil > now ? latest.accessUntil : null
  const capped = session.person.accessUntil && (until === null || until > session.person.accessUntil) ? session.person.accessUntil : until
  const choice: AccessChoice = { kind: person.kind, roleKey: split.roleKey, capabilities: split.capabilities, accessUntil: capped }
  const outcome = await p.auth.command(
    contextOf(app, request, session),
    { name: 'portal.resendInvitation', idempotencyKey, input: { userId, version: body.version, sessionId: session.id }, record: { type: 'User', id: userId, expectedVersion: body.version } },
    (tools) => inviteInCommand(tools, { partyId: session.partyId, companyId: session.company.id, email: person.email, displayName: person.displayName, locale: person.locale === 'en' ? 'en' : 'it', choice }, { actorId: session.userId, byPartner: true }),
  )
  if (outcome.replayed) return { invitation: outcome.result.invitation, delivery: 'already_sent' as const }
  await mailInvitation(p.auth, request, { tenantId: session.tenantId, companyId: session.company.id, invitedBy: `${session.person.displayName} (${session.party.name})`, result: outcome.result, roleKey: choice.roleKey })
  return { invitation: outcome.result.invitation, delivery: 'sent' as const }
}

/** POST /portal/colleagues/:userId/invitation/revoke — the open invitation withdrawn; the person is DEACTIVATED. */
export async function revokeColleagueInvitation(app: FastifyInstance, request: FastifyRequest, userId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  customerAdmin(session)
  requirePortalStepUp(app, request)
  const person = await colleagueAt(app, session, userId, body.version)
  if (person.status !== 'INVITED' || !person.invitation) throw new InvalidStateError(PARTNER_WORDS.notInvited)
  const invitationId = person.invitation.id
  const { result } = await p.auth.command(
    contextOf(app, request, session),
    {
      name: 'portal.revokeInvitation',
      idempotencyKey,
      input: { userId, invitationId, version: body.version, sessionId: session.id },
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: 'DEACTIVATED' as const, facts: adminFacts(userId, p.auth.clock.now()) } },
    },
    (tools) => revokeInCommand(tools, { partyId: session.partyId, userId, invitationId }, { actorId: session.userId, byPartner: true }, session.company.id),
  )
  return result
}

/** POST /portal/colleagues/:userId/suspend — access paused (their sessions end); /reactivate — access given back (a seat must be free). */
export async function pauseColleague(app: FastifyInstance, request: FastifyRequest, userId: string, body: { readonly version: number; readonly reason?: string | undefined }, change: 'suspend' | 'reactivate', idempotencyKey?: string) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  customerAdmin(session)
  requirePortalStepUp(app, request)
  await colleagueAt(app, session, userId, body.version)
  const { result } = await p.auth.command(
    contextOf(app, request, session),
    {
      name: change === 'suspend' ? 'portal.suspendColleague' : 'portal.reactivateColleague',
      idempotencyKey,
      input: { userId, ...body, sessionId: session.id },
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: change === 'suspend' ? ('SUSPENDED' as const) : ('ACTIVE' as const), facts: adminFacts(userId, p.auth.clock.now()) } },
    },
    async (tools) => {
      if (change === 'reactivate') {
        // Held while the others take every seat (the office may have lowered maxUsers since the pause): the party locked, counted once.
        await lockParty(tools.tx, session.partyId)
        const seat = seatProblem(await settingsOf(tools.tx, session.partyId), await seatsTaken(tools.tx, session.partyId, tools.now, userId), session.party.name)
        if (seat) throw new ConflictError(seat)
      }
      return statusInCommand(tools, { partyId: session.partyId, userId, change, reason: body.reason }, { actorId: session.userId, byPartner: true }, session.company.id)
    },
  )
  return result
}
// ---- end B-CP-073
