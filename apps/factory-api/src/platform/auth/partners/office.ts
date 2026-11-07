import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { kindFits, partnerKindsOf, type PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { PARTNERS_VIEW } from '@nexus/factory-domain/auth/partners/permissions'
import { accessEndsSoon, allowedRoleKeysProblems, offeredTemplates, PARTNER_PEOPLE, PARTNER_WORDS, splitRoleKeys, type AccessChoice } from '@nexus/factory-domain/auth/partners/rules'
import { portalIdleExpiryAt } from '@nexus/factory-domain/auth/portal/session'
import { mintPortalToken, portalTokenHash } from '@nexus/factory-domain/auth/portal/token'
import { partnerTemplateOf, PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../office/account'
import { setPortalCookies } from '../portal/cookies'
import { portalTermsInForce } from '../portal/terms'
import { csrfCookieOf, newCsrfToken } from '../sessions/cookies'
import type { OfficeAuth } from '../sessions/office-auth'
import { adminFacts, userStatus } from '../users/status'
import { emailOrThrow } from '../users/email'
import type { ChangeBody, InviteBody, SettingsBody, StatusBody } from './contract'
import { partnerMailerOf } from './mail'
import { changeInCommand, inviteInCommand, revokeInCommand, statusInCommand, STATUS_TARGET, type InvitedResult, type StatusChange } from './people'
import { lockParty, partyById, peopleOf, personOf, settingsOf, type PartnerParty, type PartnerPerson, type PortalSettingsView } from './store'

/**
 * The office side of partner organisations (B-W2b-162; PLT-006, PLT-021, PLT-022; design sales.customers and
 * purchasing.suppliers › Portal access, admin.users partners): a party's portal access, its switch and limits, its
 * people (invite, change, suspend, reactivate, deactivate, revoke an invitation) and the preview as the partner. Each
 * change is ONE command with its audit rows and event; every one but the preview needs a step-up (A1 §3.10: access).
 * A party is reached with can() against its company and itself (partners.view); a tenant-wide party is changed only by
 * a grant over every company (as the parties module).
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

/** The party as the caller may see it (else 404), and may change with `permission` (else 403). */
async function reachParty(request: FastifyRequest, partyId: string, permission: Permission = PARTNERS_VIEW): Promise<PartnerParty> {
  const actor = actorOf(officeContextOf(request))
  const party = await request.withClient((client) => partyById(client, partyId))
  if (!party || !can(actor, PARTNERS_VIEW, { companyId: party.companyId, partyId: party.id })) throw new NotFoundError('Organisation not found.')
  if (permission !== PARTNERS_VIEW) {
    const reaches = party.companyId !== null
      ? can(actor, permission, { companyId: party.companyId, partyId: party.id })
      : grantsFor(actor, permission).some((grant) => grant.companies === 'all' && (grant.parties === 'all' || grant.parties.includes(party.id)))
    if (!reaches) throw new ForbiddenError(party.companyId === null ? 'An organisation of every company is changed only by a role over every company.' : undefined)
  }
  return party
}

/** The company whose portal it is: the party's own, else the one named, else the screen's, else the tenant's only one. */
async function portalCompanyOf(client: FactoryClient, context: OfficeContext, party: PartnerParty, named: string | undefined): Promise<{ id: string; code: string; name: string }> {
  const select = { id: true, code: true, legalName: true, tradeName: true, status: true } as const
  const view = (row: { id: string; code: string; legalName: string; tradeName: string | null }) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })
  if (party.companyId !== null) {
    if (named !== undefined && named !== party.companyId) throw new ValidationError(PARTNER_WORDS.wrongCompany, [{ path: 'companyId', message: PARTNER_WORDS.wrongCompany }])
    const row = await client.company.findUnique({ where: { id: party.companyId }, select })
    if (!row) throw new NotFoundError('Company not found.')
    return view(row)
  }
  const wanted = named ?? context.companyId
  if (wanted !== undefined) {
    const row = await client.company.findUnique({ where: { id: wanted }, select })
    if (!row || row.status !== 'ACTIVE') throw new ValidationError('Choose an active company.', [{ path: 'companyId', message: 'Choose an active company.' }])
    return view(row)
  }
  const rows = await client.company.findMany({ where: { status: 'ACTIVE' }, select, take: 2 })
  if (rows.length !== 1) throw new ValidationError(PARTNER_WORDS.noPortalCompany, [{ path: 'companyId', message: PARTNER_WORDS.noPortalCompany }])
  return view(rows[0]!)
}

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export function personView(person: PartnerPerson, now: Date) {
  const template = person.roleKey ? partnerTemplateOf(person.roleKey) : undefined
  return {
    id: person.id,
    displayName: person.displayName,
    email: person.email,
    kind: person.kind,
    status: person.status,
    roleKey: person.roleKey,
    roleName: template?.name ?? null,
    seesPrices: template?.grains.includes('price') === true,
    admin: template?.admin === true,
    capabilities: [...person.capabilities],
    accessUntil: iso(person.accessUntil),
    accessEndsSoon: person.status !== 'DEACTIVATED' && accessEndsSoon(person.accessUntil, now),
    lastSignInAt: iso(person.lastSignInAt),
    invitation: person.invitation ? { id: person.invitation.id, expiresAt: toUtcIso(person.invitation.expiresAt) } : null,
    version: person.version,
  }
}

/** The roles of the party's kinds, each with whether its portal offers it. */
export function rolesView(kinds: readonly PartnerKind[], allowedRoleKeys: readonly string[]) {
  return kinds.flatMap((kind) => {
    const offered = new Set(offeredTemplates(kind, allowedRoleKeys).map((template) => template.key))
    return PARTNER_ROLE_TEMPLATES.filter((template) => template.kind === kind).map((template) => ({
      key: template.key,
      kind,
      name: template.name,
      description: template.description,
      seesPrices: template.grains.includes('price'),
      admin: template.admin,
      capabilities: { allowed: [...template.capabilities.allowed], byDefault: [...template.capabilities.byDefault] },
      offered: offered.has(template.key),
    }))
  })
}

const settingsBody = (settings: PortalSettingsView) => ({ portalOn: settings.portalOn, progressShared: settings.progressShared, maxUsers: settings.maxUsers, allowedRoleKeys: [...settings.allowedRoleKeys], version: settings.version })
const partyBody = (party: PartnerParty) => ({ id: party.id, code: party.code, name: party.name, roles: [...party.roles], status: party.status, companyId: party.companyId })

/** GET /partners/:partyId — the party's Portal access tab. */
export async function portalAccess(auth: OfficeAuth, request: FastifyRequest, partyId: string) {
  const party = await reachParty(request, partyId)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const settings = await settingsOf(client, party.id)
    const people = await peopleOf(client, party.id, now)
    const terms = party.companyId === null ? null : (await portalTermsInForce(client, party.companyId)) !== null
    return {
      party: partyBody(party),
      kinds: [...party.kinds],
      settings: settingsBody(settings),
      seats: { taken: people.filter((person) => person.seat).length, max: settings.maxUsers },
      roles: rolesView(party.kinds, settings.allowedRoleKeys),
      people: people.map((person) => personView(person, now)),
      termsInForce: terms,
    }
  })
}

/** GET /partners — the partner organisations (Admin › Users "Partners", the "access ends soon" tile). */
export async function organisations(auth: OfficeAuth, request: FastifyRequest) {
  const actor = actorOf(officeContextOf(request))
  const now = auth.clock.now()
  const soon = new Date(now.getTime() + PARTNER_PEOPLE.accessEndingNoticeMs)
  return request.withClient(async (client) => {
    const settings = await client.portalSettings.findMany({ select: { partyId: true, portalOn: true, progressShared: true, maxUsers: true }, take: 2000 })
    const people = await client.user.groupBy({ by: ['partyId', 'status'], where: { audience: 'PARTNER' }, _count: { _all: true } })
    const ending = await client.user.groupBy({ by: ['partyId'], where: { audience: 'PARTNER', status: { in: ['ACTIVE', 'SUSPENDED'] }, accessUntil: { gt: now, lte: soon } }, _count: { _all: true } })
    const ids = [...new Set([...settings.map((row) => row.partyId), ...people.map((row) => row.partyId).filter((value): value is string => value !== null)])]
    const parties = await client.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, companyId: true, legalName: true, tradeName: true, roles: true, status: true }, orderBy: [{ legalName: 'asc' }, { id: 'asc' }] })
    const count = (partyId: string, status: string) => people.find((row) => row.partyId === partyId && row.status === status)?._count._all ?? 0
    const list = parties
      .filter((row) => can(actor, PARTNERS_VIEW, { companyId: row.companyId, partyId: row.id }))
      .map((row) => {
        const own = settings.find((entry) => entry.partyId === row.id)
        return {
          party: { id: row.id, code: row.code, name: row.tradeName ?? row.legalName, roles: row.roles, status: row.status, companyId: row.companyId },
          kinds: partnerKindsOf(row.roles),
          portalOn: own?.portalOn ?? false,
          progressShared: own?.progressShared ?? false,
          maxUsers: own?.maxUsers ?? null,
          people: { active: count(row.id, 'ACTIVE'), invited: count(row.id, 'INVITED'), suspended: count(row.id, 'SUSPENDED') },
          accessEndingSoon: ending.find((entry) => entry.partyId === row.id)?._count._all ?? 0,
        }
      })
    return {
      organisations: list,
      counts: {
        organisations: list.length,
        people: list.reduce((sum, entry) => sum + entry.people.active + entry.people.invited + entry.people.suspended, 0),
        accessEndingSoon: list.reduce((sum, entry) => sum + entry.accessEndingSoon, 0),
      },
    }
  })
}

/** POST /partners/:partyId/settings — the portal switch, the limits and the production-progress switch (C1). */
export async function changeSettings(auth: OfficeAuth, request: FastifyRequest, partyId: string, body: SettingsBody, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.manage')
  requireStepUp(auth, request)
  if (body.progressShared === true && !kindFits('CUSTOMER', party.roles)) {
    throw new DomainError('conflict', PARTNER_WORDS.progressOnlyCustomers, [{ path: 'progressShared', message: PARTNER_WORDS.progressOnlyCustomers }])
  }
  if (body.portalOn === true && party.kinds.length === 0) throw new ConflictError(PARTNER_WORDS.noKind)
  if (body.allowedRoleKeys) {
    const issues = allowedRoleKeysProblems(body.allowedRoleKeys)
    body.allowedRoleKeys.forEach((key, index) => {
      const kind = partnerTemplateOf(key)?.kind
      if (kind && !party.kinds.includes(kind)) issues.push({ path: `allowedRoleKeys/${index}`, message: `${key} is a role of a portal this organisation does not have.` })
    })
    if (issues.length > 0) throw new ValidationError('The roles are not valid.', issues)
  }
  const now = auth.clock.now()
  const { result } = await auth.command(context, { name: 'partners.changeSettings', idempotencyKey, input: { partyId, ...body } }, async ({ tx, audit, emit }) => {
    await lockParty(tx, party.id)
    const before = await settingsOf(tx, party.id)
    if (body.version !== before.version) throw new StaleVersionError('PortalSettings', party.id, before.version, body.version)
    const next = {
      portalOn: body.portalOn ?? before.portalOn,
      progressShared: body.progressShared ?? before.progressShared,
      maxUsers: body.maxUsers === undefined ? before.maxUsers : body.maxUsers,
      allowedRoleKeys: body.allowedRoleKeys ?? [...before.allowedRoleKeys],
    }
    const fields = (Object.keys(next) as (keyof typeof next)[]).filter((field) => JSON.stringify(next[field]) !== JSON.stringify(before[field]))
    if (fields.length === 0) throw new InvalidStateError('Nothing changes: these are the settings already.')
    if (before.exists) {
      await tx.portalSettings.update({ where: { id: party.id }, data: { ...next, version: { increment: 1 } }, select: { id: true } })
    } else {
      // One row per party, its id the party's (B-W2b-152).
      await tx.portalSettings.create({ data: { id: party.id, partyId: party.id, ...next, createdAt: now, createdById: context.actorId }, select: { id: true } })
    }
    audit({
      recordType: 'PortalSettings',
      recordId: party.id,
      companyId: party.companyId,
      before: before.exists ? Object.fromEntries(fields.map((field) => [field, before[field]])) : null,
      after: Object.fromEntries(fields.map((field) => [field, next[field]])),
    })
    emit({ type: 'partner_portal.settings_changed', subject: party.id, companyId: party.companyId, payload: { partyId: party.id, fields, portalOn: next.portalOn, progressShared: next.progressShared } })
    const settings = await settingsOf(tx, party.id)
    const seats = (await peopleOf(tx, party.id, now)).filter((person) => person.seat).length
    return { settings: settingsBody(settings), seats: { taken: seats, max: settings.maxUsers } }
  })
  return result
}

/** The kind of a new person: the one asked, else the only one the party's roles give. */
function kindFor(party: PartnerParty, asked: PartnerKind | undefined): PartnerKind {
  if (party.kinds.length === 0) throw new ConflictError(PARTNER_WORDS.noKind)
  if (asked !== undefined) {
    if (!party.kinds.includes(asked)) throw new DomainError('conflict', PARTNER_WORDS.kindDoesNotFit(asked), [{ path: 'kind', message: PARTNER_WORDS.kindDoesNotFit(asked) }])
    return asked
  }
  if (party.kinds.length > 1) throw new ValidationError(PARTNER_WORDS.kindNeeded(party.kinds), [{ path: 'kind', message: PARTNER_WORDS.kindNeeded(party.kinds) }])
  return party.kinds[0]!
}

/** Sends the invitation mail after its command committed (a failure is logged: the office sends it again). */
export async function mailInvitation(auth: OfficeAuth, request: FastifyRequest, input: { readonly tenantId: string; readonly companyId: string; readonly invitedBy: string; readonly result: InvitedResult; readonly roleKey: string }): Promise<void> {
  const { invitation } = input.result
  try {
    await partnerMailerOf(auth.database, auth.clock).deliver({
      kind: 'invitation',
      tenantId: input.tenantId,
      companyId: input.companyId,
      userId: invitation.userId,
      to: invitation.email,
      organisation: input.result.partyName,
      invitedBy: input.invitedBy,
      roleName: partnerTemplateOf(input.roleKey)?.name ?? input.roleKey,
      expiresAt: new Date(invitation.expiresAt),
      accessUntil: invitation.accessUntil ? new Date(invitation.accessUntil) : null,
    })
  } catch (error) {
    request.log.error({ err: error }, 'a portal invitation could not be mailed')
  }
}

async function invitedByWords(auth: OfficeAuth, tenantId: string, actorId: string, companyName: string): Promise<string> {
  const person = await auth.inTenant(tenantId, actorId, (client) => client.user.findUnique({ where: { id: actorId }, select: { displayName: true } }))
  return person ? `${person.displayName} (${companyName})` : companyName
}

/** POST /partners/:partyId/people — invite a person of the party to its portal. */
export async function invitePerson(auth: OfficeAuth, request: FastifyRequest, partyId: string, body: InviteBody, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.invite')
  requireStepUp(auth, request)
  const email = emailOrThrow(body.email)
  const kind = kindFor(party, body.kind)
  const company = await request.withClient((client) => portalCompanyOf(client, context, party, body.companyId))
  const template = partnerTemplateOf(body.roleKey)
  const choice: AccessChoice = {
    kind,
    roleKey: body.roleKey,
    capabilities: body.capabilities ?? (template?.kind === kind ? [...template.capabilities.byDefault] : []),
    accessUntil: body.accessUntil ? new Date(body.accessUntil) : null,
  }
  const outcome = await auth.command(
    context,
    { name: 'partners.invite', idempotencyKey, input: { partyId, email, displayName: body.displayName, locale: body.locale ?? 'it', companyId: company.id, ...choice, accessUntil: body.accessUntil ?? null } },
    (tools) => inviteInCommand(tools, { partyId: party.id, companyId: company.id, email, displayName: body.displayName, locale: body.locale ?? 'it', choice }, { actorId: context.actorId, byPartner: false }),
  )
  if (outcome.replayed) return { invitation: outcome.result.invitation, delivery: 'already_sent' as const }
  await mailInvitation(auth, request, { tenantId: context.tenantId, companyId: company.id, invitedBy: await invitedByWords(auth, context.tenantId, context.actorId, company.name), result: outcome.result, roleKey: choice.roleKey })
  return { invitation: outcome.result.invitation, delivery: 'sent' as const }
}

/** The party's person, or a 404. */
async function reachPerson(auth: OfficeAuth, request: FastifyRequest, party: PartnerParty, userId: string): Promise<PartnerPerson> {
  const person = await request.withClient((client) => personOf(client, party.id, userId, auth.clock.now()))
  if (!person) throw new NotFoundError('Person not found.')
  return person
}

/** POST /partners/:partyId/people/:userId/invitation — the invitation again (the newest one's role and end of access). */
export async function resendInvitation(auth: OfficeAuth, request: FastifyRequest, partyId: string, userId: string, body: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.invite')
  requireStepUp(auth, request)
  const person = await reachPerson(auth, request, party, userId)
  if (person.status !== 'INVITED' || person.kind === null) throw new InvalidStateError('Only an invited person is sent the invitation again.')
  const latest = await request.withClient((client) =>
    client.invitation.findFirst({ where: { userId, audience: 'PARTNER' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { partnerRoleKeys: true, accessUntil: true } }),
  )
  const split = splitRoleKeys(latest?.partnerRoleKeys ?? [])
  if (!latest || split.roleKey === null) throw new InvalidStateError(PARTNER_WORDS.notInvited)
  const company = await request.withClient((client) => portalCompanyOf(client, context, party, body.companyId))
  const now = auth.clock.now()
  const choice: AccessChoice = { kind: person.kind, roleKey: split.roleKey, capabilities: split.capabilities, accessUntil: latest.accessUntil && latest.accessUntil > now ? latest.accessUntil : null }
  const { result } = await auth.command(
    context,
    { name: 'partners.invite', input: { partyId, userId, resend: true, companyId: company.id } },
    (tools) => inviteInCommand(tools, { partyId: party.id, companyId: company.id, email: person.email, displayName: person.displayName, locale: person.locale === 'en' ? 'en' : 'it', choice }, { actorId: context.actorId, byPartner: false }),
  )
  await mailInvitation(auth, request, { tenantId: context.tenantId, companyId: company.id, invitedBy: await invitedByWords(auth, context.tenantId, context.actorId, company.name), result, roleKey: choice.roleKey })
  return { invitation: result.invitation, delivery: 'sent' as const }
}

/** POST /partners/:partyId/people/:userId/invitation/revoke — the open invitation stops; the person is DEACTIVATED. */
export async function revokeInvitation(auth: OfficeAuth, request: FastifyRequest, partyId: string, userId: string, body: { readonly version: number }) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.invite')
  requireStepUp(auth, request)
  const person = await reachPerson(auth, request, party, userId)
  if (person.status !== 'INVITED' || !person.invitation) throw new InvalidStateError(PARTNER_WORDS.notInvited)
  const invitationId = person.invitation.id
  const { result } = await auth.command(
    context,
    { name: 'partners.revokeInvitation', input: { partyId, userId, invitationId }, record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: 'DEACTIVATED' as const, facts: adminFacts(userId, auth.clock.now()) } } },
    (tools) => revokeInCommand(tools, { partyId, userId, invitationId }, { actorId: context.actorId, byPartner: false }, party.companyId),
  )
  return result
}

/** PATCH /partners/:partyId/people/:userId — the role, the capabilities, the end of access. */
export async function changePerson(auth: OfficeAuth, request: FastifyRequest, partyId: string, userId: string, body: ChangeBody, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.manage')
  requireStepUp(auth, request)
  await reachPerson(auth, request, party, userId)
  const accessUntil = body.accessUntil === undefined ? undefined : body.accessUntil === null ? null : new Date(body.accessUntil)
  const { result } = await auth.command(
    context,
    { name: 'partners.changePerson', idempotencyKey, input: { partyId, userId, ...body }, record: { type: 'User', id: userId, expectedVersion: body.version } },
    (tools) => changeInCommand(tools, { partyId, userId, roleKey: body.roleKey, capabilities: body.capabilities, accessUntil }, { actorId: context.actorId, byPartner: false }, party.companyId),
  )
  return result
}

/** POST /partners/:partyId/people/:userId/{suspend|reactivate|deactivate}. */
export async function changeStatus(auth: OfficeAuth, request: FastifyRequest, partyId: string, userId: string, body: StatusBody, change: StatusChange) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.manage')
  requireStepUp(auth, request)
  await reachPerson(auth, request, party, userId)
  const { result } = await auth.command(
    context,
    {
      name: change === 'suspend' ? 'partners.suspend' : change === 'reactivate' ? 'partners.reactivate' : 'partners.deactivate',
      input: { partyId, userId, ...body },
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: STATUS_TARGET[change], facts: adminFacts(userId, auth.clock.now()) } },
    },
    (tools) => statusInCommand(tools, { partyId, userId, change, reason: body.reason }, { actorId: context.actorId, byPartner: false }, party.companyId),
  )
  return result
}

/**
 * POST /partners/:partyId/preview — opens the party's portal as it is, read-only, in this browser (the portal cookie; the
 * office cookie stays): a PARTNER session of the party marked as a preview by this office person (B-W2b-152), at most an
 * hour; the authenticator gives it only the reads its people could do and no money, and refuses its writes. ONE command:
 * the session row and the audit row (every preview is in the audit log). The token is minted before the command; only its
 * hash goes in.
 */
export async function preview(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, partyId: string, body: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(request)
  const party = await reachParty(request, partyId, 'partners.preview')
  if (party.kinds.length === 0) throw new ConflictError(PARTNER_WORDS.noKind)
  const company = await request.withClient((client) => portalCompanyOf(client, context, party, body.companyId))
  const token = mintPortalToken('session', { tenantId: context.tenantId, scopeId: party.id, userId: context.actorId })
  const csrfToken = csrfCookieOf(request) ?? newCsrfToken()
  const { result } = await auth.command(context, { name: 'partners.preview', input: { partyId, companyId: company.id } }, async ({ tx, now, audit }) => {
    const id = newId()
    const absoluteExpiresAt = new Date(now.getTime() + PARTNER_PEOPLE.previewMs)
    const idleExpiresAt = portalIdleExpiryAt(now, absoluteExpiresAt)
    await tx.session.create({
      data: {
        id,
        userId: context.actorId,
        tokenHash: portalTokenHash(token.value),
        companyId: company.id,
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        ipHash: auth.secrets.ipHash(request.ip),
        userAgent: request.headers['user-agent']?.slice(0, 256) ?? null,
        audience: 'PARTNER',
        partyId: party.id,
        previewOfPartyId: party.id,
        previewById: context.actorId,
      },
      select: { id: true },
    })
    audit({ action: 'partners.preview', recordType: 'Party', recordId: party.id, companyId: company.id, after: { sessionId: id, companyId: company.id, expiresAt: toUtcIso(absoluteExpiresAt) } })
    return { expiresAt: toUtcIso(absoluteExpiresAt) }
  })
  setPortalCookies(reply, token.value, csrfToken, PARTNER_PEOPLE.previewMs)
  return { csrfToken, party: { id: party.id, name: party.name }, company, expiresAt: result.expiresAt }
}

