import type { FastifyInstance, FastifyRequest } from 'fastify'
import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_PROJECTS_VIEW } from '@nexus/factory-domain/projects/permissions'
import { PROJECT_LIMITS, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { partnerCallerOf } from '../../../platform/search/partner/session'
import { dayOf } from './store'
// ---- B-CP-074 (customer page plan D13, K10): the brand admin adds and takes out its own people.
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import { requirePortalStepUp } from '../../../platform/auth/portal/step-up'
import { partyReaders } from '../../../platform/portal/tasks/people'
import { addOutsideInCommand, removeOutsideInCommand } from './members'
import { assertOpen, databaseRefusal, projectOr404 } from './store'
// ---- end B-CP-074

/**
 * The partner's side of projects (threads plan TH-5, B-TH-069; PROJ-G07; design PROJ.portal-F01, F08):
 *
 *   GET /portal/projects    the projects of the portal's company the person is a MEMBER of (the office added them one by one),
 *                           open first, then by target date: number, name, status, target date — the Home's Messages card and
 *                           the supplier portal's own list (a customer also sees them on Samples & tech packs). Each opens on the
 *                           portal record page (its thread through the partner view, platform/search/partner/views/project.ts).
 *
 * Read in the PARTNER scope: the party's own member rows (RecordFollower by party) and projects (Project by party), never the
 * office's columns. Another person of the same company who was not added lists nothing; another company reads no row at all.
 */
export async function portalProjects(request: FastifyRequest) {
  const caller = partnerCallerOf(request)
  const companyId = caller.session.company.id
  return request.withClient(async (client) => {
    const mine = await client.recordFollower.findMany({ where: { recordType: 'Project', userId: caller.context.actorId }, select: { recordId: true }, take: PROJECT_LIMITS.list })
    if (mine.length === 0) return { projects: [] }
    const rows = await client.project.findMany({
      where: { id: { in: mine.map((row) => row.recordId) }, companyId },
      orderBy: [{ targetDate: 'asc' }, { id: 'asc' }],
      select: { id: true, companyId: true, partyId: true, number: true, name: true, status: true, targetDate: true },
    })
    const visible = rows.filter((row) => row.partyId !== null && can(caller.actor, PORTAL_PROJECTS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
    const ordered = [...visible.filter((row) => row.status !== 'CLOSED'), ...visible.filter((row) => row.status === 'CLOSED')]
    return { projects: ordered.map((row) => ({ id: row.id, number: row.number, name: row.name, status: row.status as ProjectStatus, targetDate: dayOf(row.targetDate) })) }
  })
}

// ---- B-CP-074 (customer page plan D13, K10: PROJ.members-F09 reversed for the brand only; review G2; wall W-CP-4) -------------
/**
 * A customer's portal admin (portal.colleagues.manage, the route) adds and takes out its OWN company's people on a project it is a
 * MEMBER of — never on another project (not found, as for anyone not added), never an office person or the lead (they are not its
 * people: not found), never a person of another company (not found, as a wrong id):
 *
 *   GET    /portal/projects/:projectId/people/choices                     its company's members and the ACTIVE colleagues who may join
 *   POST   /portal/projects/:projectId/people {userId, version}           a colleague added (ADDED, their party; told once, in their portal)
 *   DELETE /portal/projects/:projectId/people/:userId?version=            a colleague of its company out (their access ends at once)
 *
 * The writes ask the e-mail step-up and the colleague's own row version (a stale one: 409). They run as the admin in the office
 * scope (the partner role writes no RecordFollower) through the office's own commands (./members.ts): the same row, audit and
 * events (project.person_added / person_removed, outside, byId the admin). A supplier's or workshop's admin reaches none of it.
 */

/** The customer admin's session (a preview, another kind or a non-admin: 403). */
function customerAdminOf(request: FastifyRequest): PortalSession {
  const session = portalSessionOf(request)
  if (session.preview || session.person.partnerKind !== 'CUSTOMER') throw new ForbiddenError()
  return session
}

/** The project of the portal's company the admin is a MEMBER of (partner scope: its party's rows), or 404 as for anyone not added. */
async function memberProject(request: FastifyRequest, projectId: string) {
  const caller = partnerCallerOf(request)
  if (!isUuid(projectId)) throw new NotFoundError('Project not found.')
  return request.withClient(async (client) => {
    const mine = await client.recordFollower.findFirst({ where: { recordType: 'Project', recordId: projectId, userId: caller.context.actorId }, select: { id: true } })
    const row = mine ? await client.project.findFirst({ where: { id: projectId, companyId: caller.session.company.id }, select: { id: true, companyId: true, partyId: true, status: true } }) : null
    if (!row || row.partyId === null || !can(caller.actor, PORTAL_PROJECTS_VIEW, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Project not found.')
    return row
  })
}

/** The project's members of the admin's company, and the colleagues who may be added now (active, may use the portal there). */
async function peopleView(app: FastifyInstance, session: PortalSession, project: { readonly id: string; readonly companyId: string }) {
  const p = portalOf(app)
  return p.auth.inTenant(session.tenantId, session.userId, async (client) => {
    const rows = await client.recordFollower.findMany({ where: { recordType: 'Project', recordId: project.id, partyId: session.partyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { userId: true, createdAt: true } })
    const people = await client.user.findMany({ where: { id: { in: rows.map((row) => row.userId) }, partyId: session.partyId, audience: 'PARTNER' }, select: { id: true, displayName: true, version: true } })
    const members = rows.flatMap((row) => {
      const person = people.find((entry) => entry.id === row.userId)
      return person ? [{ userId: person.id, name: person.displayName, version: person.version, you: person.id === session.userId, since: toUtcIso(row.createdAt) }] : []
    })
    const inIt = new Set(rows.map((row) => row.userId))
    const readers = (await partyReaders(client, session.tenantId, session.partyId, project.companyId, p.auth.clock.now())).filter((reader) => !inIt.has(reader.personId))
    const versions = new Map((await client.user.findMany({ where: { id: { in: readers.map((reader) => reader.personId) } }, select: { id: true, version: true } })).map((row) => [row.id, row.version]))
    return { members, choices: readers.map((reader) => ({ userId: reader.personId, name: reader.displayName, version: versions.get(reader.personId) ?? 1 })) }
  })
}

/** GET /portal/projects/:projectId/people/choices */
export async function portalProjectPeople(app: FastifyInstance, request: FastifyRequest, projectId: string) {
  const session = customerAdminOf(request)
  const project = await memberProject(request, projectId)
  return peopleView(app, session, project)
}

/** The colleague of the admin's own company (any other: not found, as a wrong id) at the version the admin read (else 409). */
async function ownColleague(app: FastifyInstance, session: PortalSession, userId: string, version: number) {
  const person = isUuid(userId) ? await portalOf(app).auth.inTenant(session.tenantId, session.userId, (client) => client.user.findUnique({ where: { id: userId }, select: { id: true, audience: true, partyId: true, status: true, version: true } })) : null
  if (!person || person.audience !== 'PARTNER' || person.partyId !== session.partyId) throw new NotFoundError('Colleague not found.')
  if (person.version !== version) throw new ConflictError(`This colleague changed since you read it (now version ${person.version}). Read it again.`)
  return person
}

/** POST /portal/projects/:projectId/people */
export async function addPortalProjectPerson(app: FastifyInstance, request: FastifyRequest, projectId: string, body: { readonly userId: string; readonly version: number }, idempotencyKey?: string) {
  const session = customerAdminOf(request)
  requirePortalStepUp(app, request)
  const project = await memberProject(request, projectId)
  const person = await ownColleague(app, session, body.userId, body.version)
  if (person.status !== 'ACTIVE') throw new InvalidStateError('Only an active colleague is added to a project: invite them first, or give their access back.')
  const p = portalOf(app)
  await p.auth
    .command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portal.addProjectPerson', idempotencyKey, input: { projectId, ...body, sessionId: session.id } }, async (tools) => {
      const row = await projectOr404(tools.tx, project.id)
      assertOpen(row.status)
      const current = await tools.tx.user.findUnique({ where: { id: body.userId }, select: { version: true } })
      if (current?.version !== body.version) throw new ConflictError('This colleague changed since you read it. Read it again.')
      const added = await addOutsideInCommand(tools, row, body.userId, session.userId)
      if (!added) tools.audit({ action: 'threads.followUnchanged', recordType: 'RecordFollower', recordId: row.id, companyId: row.companyId, after: { userId: body.userId, following: true, byPartner: true } })
      return { added }
    })
    .catch(databaseRefusal)
  return peopleView(app, session, project)
}

/** DELETE /portal/projects/:projectId/people/:userId */
export async function removePortalProjectPerson(app: FastifyInstance, request: FastifyRequest, projectId: string, userId: string, version: number, idempotencyKey?: string) {
  const session = customerAdminOf(request)
  requirePortalStepUp(app, request)
  const project = await memberProject(request, projectId)
  await ownColleague(app, session, userId, version)
  const p = portalOf(app)
  await p.auth
    .command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portal.removeProjectPerson', idempotencyKey, input: { projectId, userId, version, sessionId: session.id } }, async (tools) => {
      const row = await projectOr404(tools.tx, project.id)
      // Only a member of the admin's own company (the lead and our colleagues are not its people: not found).
      if (!(await removeOutsideInCommand(tools, row, userId, session.partyId, session.userId))) throw new NotFoundError('Colleague not found.')
      return { removed: true }
    })
    .catch(databaseRefusal)
  return peopleView(app, session, project)
}
// ---- end B-CP-074
