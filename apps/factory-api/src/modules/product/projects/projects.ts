import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PROJECTS_MANAGE } from '@nexus/factory-domain/projects/permissions'
import { closeProblems, lineOf, moveTarget, namesAlike, PROJECT_LIMITS, PROJECT_LINES, projectProblems, type ProjectMove, type ProjectOutcome, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand, personReads } from '../../../platform/threads/followers'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { linkInCommand, type LinkAsk } from './links'
import { asDay, assertOpen, badBody, databaseRefusal, managedProject, mayRead, officeOf, PROJECT_COLUMNS, projectOr404, readableProject, readableWhere, refuse, scopeOf, type ProjectRow, type Reader } from './store'
import { projectViewsOf, type ProjectView } from './views'

/**
 * The project record (threads plan TH-5, B-TH-066; PROJ-G02, PROJ-G08, PROJ-G13; design PROJ.new, PROJ.record). Office only.
 *
 *   POST  /projects                         projects.manage over the company and the outside company chosen: a new project,
 *                                           numbered from the company's PROJECT series (PRJ-26-012), ACTIVE; its maker follows
 *                                           it (CREATOR), the lead and the colleagues named are ADDED (and told), the records
 *                                           named are linked at once (B-TH-067's rules: same company, same outside company or
 *                                           none). The outside company is chosen here and never changes (PROJ.new-F02).
 *   PATCH /projects/:projectId              {version, name?, goal?, leadId?, targetDate?, seasonCode?}: while it is not CLOSED;
 *                                           a new lead is an active office person who may read it, and follows it
 *   POST  /projects/:projectId/hold         {version}: ACTIVE → ON_HOLD
 *   POST  /projects/:projectId/resume       {version}: ON_HOLD → ACTIVE
 *   POST  /projects/:projectId/close        {version, outcome DONE|STOPPED, outcomeNote, tellCustomer?}: CLOSED with its one line,
 *                                           in ONE command: the line posted in its thread (and to its outside company when
 *                                           ticked) and pinned, the thread closed, every open invitation by link ended
 *   POST  /projects/:projectId/reopen       {version}: CLOSED → ACTIVE, the outcome taken away, the thread open again, a system
 *                                           line; an ended invitation stays ended (a new one is needed: a revoked share never
 *                                           changes again)
 *   GET   /projects/similar                 ?companyId&partyId&name: active projects of that company and outside company with a
 *                                           name alike (the New project dialog's duplicate warning, PROJ.new-F03)
 *
 * Each write is ONE command on the project at the version the caller read (409 when someone changed it). The database's
 * …_projects_th_guards hold every rule again for every login; a refusal they make is a 409 in their words.
 */

const today = (): string => businessDate(serverClock.now())

/** The project's view for this reader (after a write: read again). */
export async function projectView(caller: CommandCaller, projectId: string): Promise<{ project: ProjectView }> {
  const { actor, row } = await readableProject(caller, projectId)
  const [project] = await caller.withClient((db) => projectViewsOf(db, actor, [row], today()))
  return { project: project! }
}

const authorName = async (db: Reader, userId: string): Promise<string> => (await db.user.findUnique({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? ''

/** The outside company a new project is shared with: a customer, brand, supplier or subcontractor of the company, usable. */
async function checkedParty(db: Reader, partyId: string, companyId: string): Promise<void> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true } })
  if (!party || (party.companyId !== null && party.companyId !== companyId)) badBody('partyId', 'No such customer or supplier for this company.')
  if (!(party.roles as string[]).some((role) => ['CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR'].includes(role))) refuse('NOT_OUTSIDE', 'body/partyId')
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') refuse('PARTY_BLOCKED', 'body/partyId')
}

/** A season of the company by its code (null clears it); 409 in words when the company has none of that code. */
async function checkedSeason(db: Reader, companyId: string, code: string | null | undefined): Promise<string | null> {
  if (code === null || code === undefined || code.trim() === '') return null
  const season = await db.season.findFirst({ where: { companyId, code: code.trim() }, select: { code: true } })
  if (!season) refuse('SEASON', 'body/seasonCode')
  return season.code
}

/** A lead: an active office person who may read the project (by their live roles). */
async function checkedLead(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, leadId: string, scope: ReturnType<typeof scopeOf>): Promise<void> {
  const lead = await tools.tx.user.findFirst({ where: { id: leadId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  if (!lead || !(await personReads(tools.tx, tools.context.tenantId, lead.id, scope, tools.now, 'Project'))) refuse('LEAD', 'body/leadId')
}

/** The project's office colleague, added by `byId` (ADDED: told; CHOSE when they add themselves). True when a row was added. */
export async function addColleagueInCommand(tools: CommandTools, row: Pick<ProjectRow, 'id' | 'companyId' | 'partyId' | 'number'>, userId: string, byId: string): Promise<boolean> {
  const user = await tools.tx.user.findFirst({ where: { id: userId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  if (!user || !(await personReads(tools.tx, tools.context.tenantId, user.id, scopeOf(row), tools.now, 'Project'))) refuse('MEMBER_NOT_READER', 'body/userId')
  const reason = userId === byId ? 'CHOSE' : 'ADDED'
  const added = await followInCommand(tools, { type: 'Project', id: row.id, companyId: row.companyId, siteId: null }, userId, reason, byId)
  if (added && reason === 'ADDED') {
    tools.emit({ type: 'thread.follower_added', subject: row.id, companyId: row.companyId, payload: { recordType: 'Project', recordId: row.id, userId, byId } })
    tools.emit({ type: 'project.person_added', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, userId, outside: false, byId } })
  }
  return added
}

export interface CreateProjectBody {
  readonly companyId: string
  readonly name: string
  readonly partyId?: string | null | undefined
  readonly leadId?: string | undefined
  readonly targetDate: string
  readonly seasonCode?: string | null | undefined
  readonly goal?: string | null | undefined
  readonly colleagueIds?: readonly string[] | undefined
  readonly links?: readonly LinkAsk[] | undefined
}

/** The parts of a create other steps reuse ("Start a project" from a request: B-TH-071). */
export interface CreateExtras {
  /** The record it was started from (its event names it). */
  readonly from?: { readonly type: string; readonly id: string }
  /** More work inside the same command, once the project row exists. */
  readonly after?: (tools: CommandTools, row: ProjectRow) => Promise<void>
}

/** POST /projects */
export async function createProject(caller: CommandCaller, body: CreateProjectBody, idempotencyKey?: string, extras: CreateExtras = {}): Promise<{ project: ProjectView }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const partyId = body.partyId ?? null
  const scope = { companyId: body.companyId, siteId: null, partyId }
  if (!can(actor, PROJECTS_MANAGE, scope)) {
    // A person limited to other customers learns nothing of this one: the same words as an unknown company.
    if (partyId && can(actor, PROJECTS_MANAGE, { companyId: body.companyId })) badBody('partyId', 'No such customer or supplier for this company.')
    throw new NotFoundError('Company not found.')
  }
  const issues = projectProblems({ name: body.name, goal: body.goal ?? null })
  if (issues.length > 0) badBody(issues[0]!.path.slice('body/'.length), issues[0]!.message)
  const name = body.name.trim()
  const goal = body.goal && body.goal.trim() !== '' ? body.goal.trim() : null
  const leadId = body.leadId ?? context.actorId
  const colleagues = [...new Set(body.colleagueIds ?? [])].filter((userId) => userId !== context.actorId && userId !== leadId)
  const id = newId()
  await command(caller, { name: 'projects.create', idempotencyKey, input: { ...body, ...(extras.from ? { from: extras.from } : {}) } }, async (tools) => {
    const { tx, now } = tools
    if (!(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    if (partyId) await checkedParty(tx, partyId, body.companyId)
    const seasonCode = await checkedSeason(tx, body.companyId, body.seasonCode)
    await checkedLead(tools, leadId, scope)
    const { formatted: number } = await allocateNumber(tools, { companyId: body.companyId, kind: 'PROJECT' }, { type: 'Project', id })
    const data = { id, companyId: body.companyId, number, name, goal, leadId, partyId, seasonCode, targetDate: asDay(body.targetDate), createdAt: now, updatedAt: now, createdById: context.actorId }
    await tx.project.create({ data, select: { id: true } })
    tools.audit({ action: 'projects.create', recordType: 'Project', recordId: id, companyId: body.companyId, after: { number, name, partyId, leadId, seasonCode, targetDate: body.targetDate, goal: goal === null ? null : 'set' } })
    const row = await projectOr404(tx, id)
    await followInCommand(tools, { type: 'Project', id, companyId: body.companyId, siteId: null }, context.actorId, 'CREATOR', context.actorId)
    if (leadId !== context.actorId) await addColleagueInCommand(tools, row, leadId, context.actorId)
    for (const userId of colleagues) await addColleagueInCommand(tools, row, userId, context.actorId)
    for (const [index, ask] of (body.links ?? []).entries()) await linkInCommand(tools, actor, row, ask, `body/links/${index}`)
    if (extras.after) await extras.after(tools, row)
    tools.emit({ type: 'project.created', subject: id, companyId: body.companyId, payload: { projectId: id, number, partyId, fromRecordType: extras.from?.type ?? null, fromRecordId: extras.from?.id ?? null } })
    return { id }
  }).catch(databaseRefusal)
  return projectView(caller, id)
}

export interface UpdateProjectBody {
  readonly version: number
  readonly name?: string | undefined
  readonly goal?: string | null | undefined
  readonly leadId?: string | undefined
  readonly targetDate?: string | undefined
  readonly seasonCode?: string | null | undefined
}

/** PATCH /projects/:projectId */
export async function updateProject(caller: CommandCaller, projectId: string, body: UpdateProjectBody, idempotencyKey?: string): Promise<{ project: ProjectView }> {
  const { context, row: seen } = await managedProject(caller, projectId)
  const fields = (['name', 'goal', 'leadId', 'targetDate', 'seasonCode'] as const).filter((field) => body[field] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes: name, goal, lead, target date or season.')
  assertOpen(seen.status)
  const issues = projectProblems({ name: body.name, goal: body.goal })
  if (issues.length > 0) badBody(issues[0]!.path.slice('body/'.length), issues[0]!.message)
  await command(caller, { name: 'projects.update', idempotencyKey, input: { projectId, ...body }, record: { type: 'Project', id: projectId, expectedVersion: body.version } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    assertOpen(row.status)
    const data: Record<string, unknown> = { updatedAt: tools.now }
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const set = (field: string, from: unknown, to: unknown, shown: unknown = to) => {
      if (from === to) return
      data[field] = to
      before[field] = field === 'goal' ? (from === null ? null : 'set') : from
      after[field] = field === 'goal' ? (to === null ? null : 'set') : shown
    }
    if (body.name !== undefined) set('name', row.name, body.name.trim())
    if (body.goal !== undefined) set('goal', row.goal, body.goal && body.goal.trim() !== '' ? body.goal.trim() : null)
    if (body.targetDate !== undefined) set('targetDate', row.targetDate.toISOString().slice(0, 10), body.targetDate)
    if (body.seasonCode !== undefined) set('seasonCode', row.seasonCode, await checkedSeason(tools.tx, row.companyId, body.seasonCode))
    const leadChanged = body.leadId !== undefined && body.leadId !== row.leadId
    if (leadChanged) {
      await checkedLead(tools, body.leadId!, scopeOf(row))
      set('leadId', row.leadId, body.leadId)
    }
    if ('targetDate' in data) data.targetDate = asDay(String(data.targetDate))
    const changed = Object.keys(after)
    if (changed.length > 0) await tools.tx.project.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({ action: 'projects.update', recordType: 'Project', recordId: row.id, companyId: row.companyId, before, after })
    if (leadChanged) await addColleagueInCommand(tools, row, body.leadId!, context.actorId)
    if (changed.length > 0) tools.emit({ type: 'project.changed', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, fields: changed, leadChanged } })
    return { projectId }
  }).catch(databaseRefusal)
  return projectView(caller, projectId)
}

export interface MoveProjectBody {
  readonly version: number
  readonly outcome?: ProjectOutcome | undefined
  readonly outcomeNote?: string | undefined
  /** Close only: post the outcome line to the project's outside company too (PROJ.record-F03 "only if ticked"). */
  readonly tellCustomer?: boolean | undefined
}

/** Every live invitation by link to the project ends, with its link, in the command (PROJ-G13; links-depth: never deleted). */
async function endInvitations(tools: CommandTools, row: Pick<ProjectRow, 'id' | 'companyId'>, byId: string): Promise<number> {
  const shares = await tools.tx.recordShare.findMany({ where: { recordType: 'Project', recordId: row.id, revokedAt: null, expiresAt: { gt: tools.now } }, select: { id: true, linkId: true, partyId: true } })
  for (const share of shares) {
    await tools.tx.recordShare.update({ where: { id: share.id }, data: { revokedAt: tools.now, revokedById: byId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'partners.shares.revoke', recordType: 'RecordShare', recordId: share.id, companyId: row.companyId, after: { revokedAt: toUtcIso(tools.now), reason: 'PROJECT_CLOSED' } })
    if (share.linkId) {
      const { count } = await tools.tx.oneOffLink.updateMany({ where: { id: share.linkId, revokedAt: null }, data: { revokedAt: tools.now, revokedById: byId } })
      if (count > 0) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: share.linkId, companyId: row.companyId, after: { revokedAt: toUtcIso(tools.now), shareId: share.id } })
    }
    tools.emit({ type: 'record_share.revoked', subject: share.id, companyId: row.companyId, payload: { shareId: share.id, recordType: 'Project', recordId: row.id, partyId: share.partyId, linkId: share.linkId } })
  }
  return shares.length
}

/** The project's thread opened or closed in the command (its own row's version moves; the audit row is the thread's). */
async function setThread(tools: CommandTools, threadId: string, to: 'OPEN' | 'CLOSED', reason: string): Promise<void> {
  const thread = await tools.tx.thread.findUniqueOrThrow({ where: { id: threadId }, select: { id: true, status: true, version: true, companyId: true, siteId: true } })
  if (thread.status === to) return
  await tools.tx.thread.update({ where: { id: thread.id }, data: { status: to, version: thread.version + 1 }, select: { id: true } })
  tools.audit({ action: 'threads.setStatus', recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, before: { status: thread.status }, after: { status: to }, reason })
}

const MOVE_ACTIONS: Readonly<Record<ProjectMove, `projects.${string}`>> = Object.freeze({ HOLD: 'projects.hold', RESUME: 'projects.resume', CLOSE: 'projects.close', REOPEN: 'projects.reopen' })

/** POST /projects/:projectId/hold | resume | close | reopen */
export async function moveProject(caller: CommandCaller, projectId: string, move: ProjectMove, body: MoveProjectBody, idempotencyKey?: string): Promise<{ project: ProjectView }> {
  const { context, row: seen } = await managedProject(caller, projectId)
  if (moveTarget(seen.status as ProjectStatus, move) === null) refuse(seen.status === 'CLOSED' ? 'CLOSED' : 'MOVE')
  if (move === 'CLOSE') {
    const problems = closeProblems({ outcome: body.outcome ?? '', outcomeNote: body.outcomeNote ?? '' })
    if (problems.length > 0) badBody(problems[0]!.path.slice('body/'.length), problems[0]!.message)
  }
  await command(caller, { name: MOVE_ACTIONS[move], idempotencyKey, input: { projectId, move, ...body }, record: { type: 'Project', id: projectId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await projectOr404(tx, projectId)
    const from = row.status as ProjectStatus
    const to = moveTarget(from, move)
    if (to === null) refuse(from === 'CLOSED' ? 'CLOSED' : 'MOVE')
    const by = await authorName(tx, context.actorId)
    let outcome: ProjectOutcome | null = null
    if (move === 'CLOSE') {
      outcome = body.outcome!
      const note = body.outcomeNote!.trim()
      // The outcome line in the thread, pinned (PROJ.record-F03): an office note always; to the outside company only when ticked.
      const { thread } = await ensureThread(tools, { type: 'Project', id: row.id }, context.actorId)
      const author = { kind: 'USER' as const, id: context.actorId, name: by }
      const officeLine = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author, bodyText: cleanBody(lineOf(PROJECT_LINES.closed(by, outcome, note))) })
      let pinned = officeLine.id
      if (body.tellCustomer === true && row.partyId !== null && thread.partyId !== null) {
        const shared = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author, bodyText: cleanBody(note) })
        pinned = shared.id
      }
      await tx.threadPin.create({ data: { id: newId(), threadId: thread.id, messageId: pinned, key: `pin:${thread.id}:${pinned}`, pinnedById: context.actorId, pinnedAt: now, createdAt: now }, select: { id: true } })
      tools.audit({ action: 'threads.pin', recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, after: { messageId: pinned, why: 'PROJECT_OUTCOME' } })
      await setThread(tools, thread.id, 'CLOSED', 'PROJECT_CLOSED')
      const ended = await endInvitations(tools, row, context.actorId)
      await tx.project.update({ where: { id: row.id }, data: { status: 'CLOSED', outcome, outcomeNote: note, closedAt: now, closedById: context.actorId, updatedAt: now }, select: { id: true } })
      tools.audit({ action: MOVE_ACTIONS[move], recordType: 'Project', recordId: row.id, companyId: row.companyId, before: { status: from }, after: { status: to, outcome, outcomeNote: note, invitationsEnded: ended, toldCustomer: pinned !== officeLine.id } })
    } else if (move === 'REOPEN') {
      await tx.project.update({ where: { id: row.id }, data: { status: 'ACTIVE', outcome: null, outcomeNote: null, closedAt: null, closedById: null, updatedAt: now }, select: { id: true } })
      tools.audit({ action: MOVE_ACTIONS[move], recordType: 'Project', recordId: row.id, companyId: row.companyId, before: { status: from, outcome: row.outcome, outcomeNote: row.outcomeNote }, after: { status: to } })
      const { thread } = await ensureThread(tools, { type: 'Project', id: row.id }, context.actorId)
      await setThread(tools, thread.id, 'OPEN', 'PROJECT_REOPENED')
      await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(lineOf(PROJECT_LINES.reopened(by))) })
    } else {
      await tx.project.update({ where: { id: row.id }, data: { status: to, updatedAt: now }, select: { id: true } })
      tools.audit({ action: MOVE_ACTIONS[move], recordType: 'Project', recordId: row.id, companyId: row.companyId, before: { status: from }, after: { status: to } })
    }
    tools.emit({ type: 'project.status_changed', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, from, to, outcome } })
    return { projectId }
  }).catch(databaseRefusal)
  return projectView(caller, projectId)
}

/** GET /projects/similar: active projects of the company and outside company whose name is alike (none: an empty list). */
export async function similarProjects(caller: CommandCaller, query: { readonly companyId: string; readonly partyId?: string | undefined; readonly name: string }) {
  const context = officeOf(caller)
  const actor: Actor = actorOf(context)
  const name = query.name.trim()
  if (name.length < 3) return { projects: [] }
  const words = name.split(/\s+/).filter((word) => word.length >= 3).slice(0, 5)
  const rows = await caller.withClient((db) =>
    db.project.findMany({
      where: {
        AND: [
          readableWhere(actor),
          { companyId: query.companyId, partyId: query.partyId ?? null, status: { not: 'CLOSED' } },
          { OR: words.map((word) => ({ name: { contains: word, mode: 'insensitive' as const } })) },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
      select: PROJECT_COLUMNS,
    }),
  )
  const alike = rows.filter((row) => mayRead(actor, row) && namesAlike(row.name, name)).slice(0, PROJECT_LIMITS.similar)
  return { projects: alike.map((row) => ({ id: row.id, number: row.number, name: row.name, status: row.status as ProjectStatus })) }
}
