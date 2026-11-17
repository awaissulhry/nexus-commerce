import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PROJECT_LIMITS } from '@nexus/factory-domain/projects/rules'
import type { FollowReason } from '@nexus/factory-domain/threads/followers'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { followInCommand, personReads } from '../../../platform/threads/followers'
import { partyReaders } from '../../../platform/portal/tasks/people'
import { addColleagueInCommand } from './projects'
import { assertOpen, badBody, databaseRefusal, mayManage, mayPost, projectOr404, readableProject, refuse, scopeOf, type ProjectRow, type Reader } from './store'

/**
 * Project people (threads plan TH-5, B-TH-068; PROJ-G04, PROJ-G05, PROJ-G06; design PROJ.members). A project's people are its
 * thread's followers (collab.prisma RecordFollower): our colleagues — who made it, who leads it, who was added, mentioned or
 * chose to follow — and, on a project shared with an outside company, that company's portal people the office added ONE BY ONE
 * (their rows name their party). The brand's own admin never adds anyone (PROJ.members-F09): only the office does.
 *
 *   GET    /projects/:projectId/people             threads.read: our team (name, Lead, why they are in, added by whom, muted,
 *                                                  since), the outside company's members, the people invited by link (until
 *                                                  when); exact counts. Never "seen by", never a count of messages per person.
 *   GET    /projects/:projectId/people/choices     threads.post: colleagues who may read it and are not in it; with
 *                                                  projects.manage also the outside company's active portal people not in it
 *   POST   /projects/:projectId/people             {userId}: a colleague (threads.post: who may read it, ADDED, told "Marco
 *                                                  added you"), or a portal person of the project's outside company
 *                                                  (projects.manage: ADDED with their party, told in their portal); added
 *                                                  twice: no change, no second notice
 *   DELETE /projects/:projectId/people/:userId     the lead or someone who manages projects takes a person out (the lead stays:
 *                                                  name a new lead first); the person is told once; their messages stay. Anyone
 *                                                  leaves by themselves through PUT /threads/Project/<id>/followers/me.
 *
 * THE WALL (W38, W06): a portal person joins only a project of their own company (the database refuses any other: …_projects_th_
 * guards RecordFollower_party_check); the partner view and the portal's news of a project reach its members only (the party wall
 * stays the database's: a portal person of another company reads nothing of it at all).
 */

const recordOf = (row: Pick<ProjectRow, 'id' | 'companyId'>) => ({ type: 'Project', id: row.id, companyId: row.companyId, siteId: null })

export interface PeopleView {
  readonly office: { readonly count: number; readonly people: Array<{ userId: string; name: string; lead: boolean; me: boolean; reason: FollowReason; addedBy: { id: string; name: string } | null; muted: boolean; since: string }> }
  readonly outside: { readonly count: number; readonly people: Array<{ userId: string; name: string; reason: FollowReason; addedBy: { id: string; name: string } | null; since: string }> }
  readonly invited: { readonly count: number; readonly people: Array<{ shareId: string; name: string | null; email: string; until: string; permissions: string[] }> }
}

/** The project's people as the office reads them (one read per kind). */
export async function peopleOf(db: Reader, row: Pick<ProjectRow, 'id' | 'leadId'>, meId: string, now: Date): Promise<PeopleView> {
  const where = { recordType: 'Project', recordId: row.id }
  const rows = await db.recordFollower.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PROJECT_LIMITS.people * 2, select: { userId: true, partyId: true, reason: true, muted: true, createdAt: true, createdById: true } })
  const officeCount = await db.recordFollower.count({ where: { ...where, partyId: null } })
  const outsideCount = await db.recordFollower.count({ where: { ...where, partyId: { not: null } } })
  const ids = [...new Set(rows.flatMap((entry) => [entry.userId, entry.createdById]).filter((id): id is string => id !== null))]
  const names = new Map((ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const addedBy = (entry: (typeof rows)[number]) => (entry.createdById && entry.createdById !== entry.userId ? { id: entry.createdById, name: names.get(entry.createdById) ?? '' } : null)
  const shares = await db.recordShare.findMany({
    where: { recordType: 'Project', recordId: row.id, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROJECT_LIMITS.people,
    select: { id: true, email: true, expiresAt: true, permissions: true, contact: { select: { name: true } } },
  })
  return {
    office: {
      count: officeCount,
      people: rows
        .filter((entry) => entry.partyId === null)
        .slice(0, PROJECT_LIMITS.people)
        .map((entry) => ({ userId: entry.userId, name: names.get(entry.userId) ?? '', lead: entry.userId === row.leadId, me: entry.userId === meId, reason: entry.reason as FollowReason, addedBy: addedBy(entry), muted: entry.muted, since: toUtcIso(entry.createdAt) })),
    },
    outside: {
      count: outsideCount,
      people: rows
        .filter((entry) => entry.partyId !== null)
        .slice(0, PROJECT_LIMITS.people)
        .map((entry) => ({ userId: entry.userId, name: names.get(entry.userId) ?? '', reason: entry.reason as FollowReason, addedBy: addedBy(entry), since: toUtcIso(entry.createdAt) })),
    },
    invited: { count: shares.length, people: shares.map((share) => ({ shareId: share.id, name: share.contact?.name ?? null, email: share.email, until: toUtcIso(share.expiresAt), permissions: share.permissions as string[] })) },
  }
}

/** GET /projects/:projectId/people */
export async function projectPeople(caller: CommandCaller, projectId: string) {
  const { context, row } = await readableProject(caller, projectId)
  return { people: await caller.withClient((db) => peopleOf(db, row, context.actorId, new Date())) }
}

/** GET /projects/:projectId/people/choices: who may be added now. */
export async function peopleChoices(caller: CommandCaller, projectId: string, query: { readonly q?: string | undefined }) {
  const { context, actor, row } = await readableProject(caller, projectId)
  if (!mayPost(actor, row)) return { office: [], outside: [], mayAddOutside: false }
  const now = new Date()
  const typed = query.q?.trim() ?? ''
  return caller.withClient(async (db) => {
    const inIt = new Set((await db.recordFollower.findMany({ where: { recordType: 'Project', recordId: row.id }, select: { userId: true } })).map((entry) => entry.userId))
    const colleagues = await db.user.findMany({
      where: { status: 'ACTIVE', audience: 'OFFICE', ...(typed ? { displayName: { contains: typed, mode: 'insensitive' as const } } : {}) },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, displayName: true },
    })
    const office: { userId: string; name: string }[] = []
    for (const user of colleagues) {
      if (inIt.has(user.id)) continue
      if (!(await personReads(db, context.tenantId, user.id, scopeOf(row), now, 'Project'))) continue
      office.push({ userId: user.id, name: user.displayName })
      if (office.length >= PROJECT_LIMITS.people) break
    }
    const mayAddOutside = row.partyId !== null && mayManage(actor, row) && row.status !== 'CLOSED'
    const outside = mayAddOutside
      ? (await partyReaders(db, context.tenantId, row.partyId!, row.companyId, now))
          .filter((reader) => !inIt.has(reader.personId) && (typed === '' || reader.displayName.toLowerCase().includes(typed.toLowerCase())))
          .map((reader) => ({ userId: reader.personId, name: reader.displayName }))
      : []
    return { office, outside, mayAddOutside }
  })
}

/** Inside a command: a portal person of the project's outside company becomes a member (ADDED, their party). True when added. */
async function addOutsideInCommand(tools: CommandTools, row: ProjectRow, userId: string, byId: string): Promise<boolean> {
  if (row.partyId === null) refuse('MEMBER_OFFICE_ONLY', 'body/userId')
  const person = await tools.tx.user.findFirst({ where: { id: userId, audience: 'PARTNER', status: 'ACTIVE' }, select: { id: true, partyId: true } })
  // Neutral: a person of another company is "not one of this company's portal people", never who they are.
  if (!person || person.partyId !== row.partyId) refuse('MEMBER_OTHER_PARTY', 'body/userId')
  const readers = await partyReaders(tools.tx, tools.context.tenantId, row.partyId, row.companyId, tools.now)
  if (!readers.some((reader) => reader.personId === userId)) refuse('MEMBER_OTHER_PARTY', 'body/userId')
  const added = await followInCommand(tools, recordOf(row), userId, 'ADDED', byId, row.partyId)
  if (added) tools.emit({ type: 'project.person_added', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, userId, outside: true, byId } })
  return added
}

/** POST /projects/:projectId/people */
export async function addPerson(caller: CommandCaller, projectId: string, body: { readonly userId: string }, idempotencyKey?: string) {
  const { context, actor, row: seen } = await readableProject(caller, projectId)
  if (!mayPost(actor, seen)) throw new ForbiddenError('Your role does not write in this project.')
  const target = isUuid(body.userId) ? await caller.withClient((db) => db.user.findUnique({ where: { id: body.userId }, select: { id: true, audience: true } })) : null
  if (!target) badBody('userId', 'No such person.')
  const outside = target.audience === 'PARTNER'
  // Adding a person of the outside company is keeping the project (projects.manage), never only writing in it.
  if (outside && !mayManage(actor, seen)) badBody('userId', 'Only someone who manages projects adds people of the outside company.')
  await command(caller, { name: 'projects.addPerson', idempotencyKey, input: { projectId, userId: body.userId } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    assertOpen(row.status)
    const added = outside ? await addOutsideInCommand(tools, row, body.userId, context.actorId) : await addColleagueInCommand(tools, row, body.userId, context.actorId)
    if (!added) tools.audit({ action: 'threads.followUnchanged', recordType: 'RecordFollower', recordId: row.id, companyId: row.companyId, after: { userId: body.userId, following: true } })
    return { added }
  }).catch(databaseRefusal)
  return projectPeople(caller, projectId)
}

/** DELETE /projects/:projectId/people/:userId */
export async function removePerson(caller: CommandCaller, projectId: string, userId: string, idempotencyKey?: string) {
  const { context, actor, row: seen } = await readableProject(caller, projectId)
  if (seen.leadId !== context.actorId && !mayManage(actor, seen)) refuse('MEMBER_REMOVE')
  if (userId === seen.leadId) refuse('MEMBER_LEAD')
  await command(caller, { name: 'projects.removePerson', idempotencyKey, input: { projectId, userId } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    if (userId === row.leadId) refuse('MEMBER_LEAD')
    const entry = isUuid(userId) ? await tools.tx.recordFollower.findFirst({ where: { recordType: 'Project', recordId: row.id, userId }, select: { id: true, reason: true, muted: true, partyId: true } }) : null
    if (!entry) throw new NotFoundError('This person is not in the project.')
    await tools.tx.recordFollower.delete({ where: { id: entry.id } })
    tools.audit({ action: 'threads.unfollow', recordType: 'RecordFollower', recordId: entry.id, companyId: row.companyId, before: { reason: entry.reason, muted: entry.muted }, after: { following: false, recordType: 'Project', recordId: row.id, userId, removedBy: context.actorId } })
    tools.emit({ type: 'thread.followers_changed', subject: row.id, companyId: row.companyId, payload: { recordType: 'Project', recordId: row.id } })
    if (userId !== context.actorId) tools.emit({ type: 'project.person_removed', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, userId, outside: entry.partyId !== null, byId: context.actorId } })
    return { removed: true }
  }).catch(databaseRefusal)
  return projectPeople(caller, projectId)
}
