import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AccountantsAnswer, ChangeAccountantBody, EndAccountantBody, InviteAccountantBody } from '@nexus/factory-domain/accounting/guest/contracts'
import { ACCOUNTANT_ROLE_KEY, ACCOUNTING_ACCOUNTANTS_MANAGE } from '@nexus/factory-domain/accounting/guest/permissions'
import { ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { partnerKindsOf } from '@nexus/factory-domain/auth/partners/kinds'
import { accessEndsSoon, type AccessChoice } from '@nexus/factory-domain/auth/partners/rules'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as partnerEvents } from '@nexus/factory-domain/partners/events'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { requireStepUp } from '../../../platform/auth/office/account'
import { mailInvitation } from '../../../platform/auth/partners/office'
import { changeInCommand, inviteInCommand, revokeInCommand, statusInCommand, STATUS_TARGET } from '../../../platform/auth/partners/people'
import { lockParty, partyById, peopleOf, personOf, settingsOf, type PartnerParty } from '../../../platform/auth/partners/store'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { adminFacts, userStatus } from '../../../platform/auth/users/status'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { followInCommand } from '../../../platform/threads/followers'
import { DOWNLOAD_ACTION, ZIP_ACTION } from './portal'

/**
 * Accountant access in the office (B-W2b-201; FIN-158, PLT-022; design finance.accounting connection "Portal › Accountant",
 * moved here from W2b-6): Finance › Close › Accounting export gives the company's accounting firm its guest portal.
 *
 *   GET   /accounting/accountants?companyId                 the company's adviser firms (CONSULTANT parties of the company or
 *                                                           of every company), their guest people (status, end of access,
 *                                                           last sign-in, an open invitation) and the newest downloads
 *   POST  /accounting/accountants                           give access: ONE command switches the firm's portal on (when
 *                                                           off), invites the person with the Accountant role and its end
 *                                                           date (B-W2b-162's invite work: GATE-PRIVACY, the seats, a guest
 *                                                           always ends), and makes the inviter follow the firm's record
 *                                                           (the accountant's "Ask finance" posts reach them); then the mail
 *   PATCH /accounting/accountants/:userId                   a new end of access
 *   POST  /accounting/accountants/:userId/end               end it now: an open invitation revoked, an active person
 *                                                           deactivated (their sessions end at once)
 *
 * Reading is accounting.view over the company; the changes are accounting.accountants.manage with a fresh step-up (they
 * open the company's books to an outside firm). A firm of every company is changed only by a grant over every company (as
 * partners.*). Finance holds no partners.*: these routes reach adviser parties and guest people ONLY.
 */

const officeOf = (request: FastifyRequest): OfficeContext => {
  const context = requireContext(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const ADVISER = 'CONSULTANT'
const WORDS = Object.freeze({
  notAdviser: 'This organisation is not an adviser (the Consultant role): it has no accountant portal. Give it the role first.',
  notGuest: 'This person is not an accountant of this firm.',
  everyCompany: 'This firm works for every company: only a role over every company gives or changes its access.',
  otherCompany: "This firm belongs to another company: its access is given from that company's Finance › Close.",
})

/** The company as the caller may see it with `permission` (else 403). */
function reachCompany(request: FastifyRequest, companyId: string, permission: Permission): OfficeContext {
  const context = officeOf(request)
  if (!can(actorOf(context), permission, { companyId })) throw new ForbiddenError()
  return context
}

/** The adviser party of this company (or of every company), reachable with `permission`; else 404 / 403 / 409. */
async function reachFirm(request: FastifyRequest, companyId: string, partyId: string, permission: Permission): Promise<PartnerParty> {
  const context = reachCompany(request, companyId, permission)
  const party = await request.withClient((client) => partyById(client, partyId))
  if (!party) throw new NotFoundError('Organisation not found.')
  if (party.companyId !== null && party.companyId !== companyId) throw new DomainError('conflict', WORDS.otherCompany, [{ path: 'partyId', message: WORDS.otherCompany }])
  if (!party.roles.includes(ADVISER)) throw new DomainError('conflict', WORDS.notAdviser, [{ path: 'partyId', message: WORDS.notAdviser }])
  const actor = actorOf(context)
  const reaches =
    party.companyId !== null
      ? can(actor, permission, { companyId, partyId: party.id })
      : grantsFor(actor, permission).some((grant) => grant.companies === 'all' && (grant.parties === 'all' || grant.parties.includes(party.id)))
  if (!reaches) throw new ForbiddenError(party.companyId === null ? WORDS.everyCompany : undefined)
  return party
}

/** GET /accounting/accountants?companyId. */
export async function accountants(app: FastifyInstance, request: FastifyRequest, companyId: string): Promise<AccountantsAnswer> {
  const context = reachCompany(request, companyId, ACCOUNTING_VIEW)
  const actor = actorOf(context)
  const now = officeAuthOf(app).clock.now()
  return request.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const parties = await client.party.findMany({
      where: { roles: { has: ADVISER }, status: { not: 'ARCHIVED' }, OR: [{ companyId }, { companyId: null }] },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, code: true, legalName: true, tradeName: true, companyId: true },
    })
    const firms = []
    for (const party of parties) {
      const settings = await settingsOf(client, party.id)
      const people = (await peopleOf(client, party.id, now)).filter((person) => person.kind === 'GUEST')
      firms.push({
        party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, everyCompany: party.companyId === null },
        portalOn: settings.portalOn,
        people: people.map((person) => ({
          id: person.id,
          displayName: person.displayName,
          email: person.email,
          status: person.status,
          accessUntil: person.accessUntil ? toUtcIso(person.accessUntil) : null,
          endsSoon: person.status !== 'DEACTIVATED' && accessEndsSoon(person.accessUntil, now),
          ended: person.accessUntil !== null && person.accessUntil.getTime() <= now.getTime(),
          lastSignInAt: person.lastSignInAt ? toUtcIso(person.lastSignInAt) : null,
          invitationExpiresAt: person.invitation ? toUtcIso(person.invitation.expiresAt) : null,
          version: person.version,
        })),
      })
    }
    // Every download is in the audit log (portal.ts): the newest of this company's, with who and which firm.
    const rows = await client.auditLog.findMany({ where: { companyId, action: { in: [DOWNLOAD_ACTION, ZIP_ACTION] } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 20, select: { at: true, actorId: true, action: true, after: true } })
    const people = await client.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.actorId).filter((value): value is string => value !== null))] } }, select: { id: true, displayName: true, partyId: true } })
    const names = new Map(parties.map((party) => [party.id, party.tradeName ?? party.legalName]))
    const downloads = rows.map((row) => {
      const after = (row.after ?? {}) as Record<string, unknown>
      const person = people.find((entry) => entry.id === row.actorId)
      return {
        at: toUtcIso(row.at),
        person: person?.displayName ?? null,
        firm: person?.partyId ? (names.get(person.partyId) ?? null) : null,
        what: row.action === ZIP_ACTION ? ('ZIP' as const) : ('FILE' as const),
        period: typeof after.period === 'string' ? after.period : null,
        name: typeof after.name === 'string' ? after.name : null,
        files: row.action === ZIP_ACTION && typeof after.files === 'number' ? after.files : 1,
      }
    })
    return {
      company: { id: company.id, code: company.code, name: company.tradeName ?? company.legalName },
      firms,
      downloads,
      may: { manage: can(actor, ACCOUNTING_ACCOUNTANTS_MANAGE, { companyId }) },
      asOf: toUtcIso(now),
    }
  })
}

const settingsChanged = partnerEvents.find((event) => event.type === 'partner_portal.settings_changed')!

/** POST /accounting/accountants — the firm's portal on, the person invited with the Accountant role until a date. */
export async function inviteAccountant(app: FastifyInstance, request: FastifyRequest, body: InviteAccountantBody, idempotencyKey?: string) {
  const auth = officeAuthOf(app)
  const party = await reachFirm(request, body.companyId, body.partyId, ACCOUNTING_ACCOUNTANTS_MANAGE)
  const context = officeOf(request)
  requireStepUp(auth, request)
  const email = emailOrThrow(body.email)
  const template = partnerTemplateOf(ACCOUNTANT_ROLE_KEY)!
  const choice: AccessChoice = { kind: 'GUEST', roleKey: ACCOUNTANT_ROLE_KEY, capabilities: [...template.capabilities.byDefault], accessUntil: new Date(body.accessUntil) }
  const outcome = await auth.command(
    context,
    { name: 'accounting.inviteAccountant', idempotencyKey, input: { ...body, email } },
    async (tools) => {
      // The firm's portal: switched on with the invitation (an adviser's portal is this page and nothing else).
      await lockParty(tools.tx, party.id)
      const before = await settingsOf(tools.tx, party.id)
      let portalSwitchedOn = false
      if (!before.portalOn) {
        if (before.exists) await tools.tx.portalSettings.update({ where: { id: party.id }, data: { portalOn: true, version: { increment: 1 } }, select: { id: true } })
        else await tools.tx.portalSettings.create({ data: { id: party.id, partyId: party.id, portalOn: true, createdAt: tools.now, createdById: context.actorId }, select: { id: true } })
        tools.audit({ recordType: 'PortalSettings', recordId: party.id, companyId: party.companyId, before: before.exists ? { portalOn: false } : null, after: { portalOn: true, for: 'accountant access' } })
        tools.emit(eventFor(settingsChanged, { subject: party.id, companyId: party.companyId, payload: { partyId: party.id, fields: ['portalOn'], portalOn: true, progressShared: before.progressShared } }))
        portalSwitchedOn = true
      }
      const invited = await inviteInCommand(tools, { partyId: party.id, companyId: body.companyId, email, displayName: body.displayName, locale: body.locale, choice }, { actorId: context.actorId, byPartner: false })
      // The accountant's "Ask finance" is the firm's record thread: the person who gave access follows it.
      await followInCommand(tools, { type: 'Party', id: party.id, companyId: party.companyId, siteId: null }, context.actorId, 'CHOSE', context.actorId)
      return { ...invited, portalSwitchedOn }
    },
  )
  const { invitation } = outcome.result
  const answer = { invitation: { id: invitation.id, userId: invitation.userId, email: invitation.email, expiresAt: invitation.expiresAt, accessUntil: invitation.accessUntil }, portalSwitchedOn: outcome.result.portalSwitchedOn }
  if (outcome.replayed) return { ...answer, delivery: 'already_sent' as const }
  const company = await request.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { legalName: true, tradeName: true } }))
  const inviter = await request.withClient((client) => client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } }))
  const companyName = company?.tradeName ?? company?.legalName ?? ''
  await mailInvitation(auth, request, { tenantId: context.tenantId, companyId: body.companyId, invitedBy: inviter ? `${inviter.displayName} (${companyName})` : companyName, result: outcome.result, roleKey: ACCOUNTANT_ROLE_KEY })
  return { ...answer, delivery: 'sent' as const }
}

/** The firm's accountant (a GUEST person of the firm), or 404. */
async function reachAccountant(app: FastifyInstance, request: FastifyRequest, companyId: string, userId: string) {
  const row = await request.withClient((client) => client.user.findUnique({ where: { id: userId }, select: { partyId: true, partnerKind: true, audience: true } }))
  if (!row || row.audience !== 'PARTNER' || row.partnerKind !== 'GUEST' || !row.partyId) throw new NotFoundError(WORDS.notGuest)
  const party = await reachFirm(request, companyId, row.partyId, ACCOUNTING_ACCOUNTANTS_MANAGE)
  if (!partnerKindsOf(party.roles).includes('GUEST')) throw new NotFoundError(WORDS.notGuest)
  const person = await request.withClient((client) => personOf(client, party.id, userId, officeAuthOf(app).clock.now()))
  if (!person) throw new NotFoundError(WORDS.notGuest)
  return { party, person }
}

/** PATCH /accounting/accountants/:userId — a new end of access (a guest's always ends). */
export async function changeAccountant(app: FastifyInstance, request: FastifyRequest, userId: string, body: ChangeAccountantBody, idempotencyKey?: string) {
  const auth = officeAuthOf(app)
  const { party } = await reachAccountant(app, request, body.companyId, userId)
  const context = officeOf(request)
  requireStepUp(auth, request)
  const { result } = await auth.command(
    context,
    { name: 'accounting.changeAccountant', idempotencyKey, input: { userId, ...body }, record: { type: 'User', id: userId, expectedVersion: body.version } },
    (tools) => changeInCommand(tools, { partyId: party.id, userId, accessUntil: new Date(body.accessUntil) }, { actorId: context.actorId, byPartner: false }, party.companyId),
  )
  return { id: result.id, accessUntil: result.accessUntil }
}

/** POST /accounting/accountants/:userId/end — an open invitation revoked, or the person deactivated (sessions end). */
export async function endAccountant(app: FastifyInstance, request: FastifyRequest, userId: string, body: EndAccountantBody, idempotencyKey?: string) {
  const auth = officeAuthOf(app)
  const { party, person } = await reachAccountant(app, request, body.companyId, userId)
  const context = officeOf(request)
  requireStepUp(auth, request)
  if (person.status === 'DEACTIVATED') throw new InvalidStateError('This access has ended already.')
  const by = { actorId: context.actorId, byPartner: false }
  if (person.status === 'INVITED') {
    if (!person.invitation) throw new InvalidStateError('This invitation has expired already: nothing is open.')
    const invitationId = person.invitation.id
    const { result } = await auth.command(
      context,
      { name: 'accounting.endAccountant', idempotencyKey, input: { userId, invitationId, reason: body.reason ?? null }, record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: 'DEACTIVATED' as const, facts: adminFacts(userId, auth.clock.now()) } } },
      (tools) => revokeInCommand(tools, { partyId: party.id, userId, invitationId }, by, party.companyId),
    )
    return { id: result.id, status: result.status, sessionsEnded: 0 }
  }
  const { result } = await auth.command(
    context,
    {
      name: 'accounting.endAccountant',
      idempotencyKey,
      input: { userId, reason: body.reason ?? null },
      record: { type: 'User', id: userId, expectedVersion: body.version, transition: { machine: userStatus, to: STATUS_TARGET.deactivate, facts: adminFacts(userId, auth.clock.now()) } },
    },
    (tools) => statusInCommand(tools, { partyId: party.id, userId, change: 'deactivate', reason: body.reason }, by, party.companyId),
  )
  return { id: result.id, status: result.status, sessionsEnded: result.sessionsEnded }
}
