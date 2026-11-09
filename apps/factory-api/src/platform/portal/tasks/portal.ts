import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { KIND_RULES } from '@nexus/factory-domain/portal/tasks/kinds'
import { badgesOf, byDue, DAY_MS, dueStateOf, isTaskFor, undoProblem } from '@nexus/factory-domain/portal/tasks/rules'
import { commandOn } from './clock'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../auth/portal/authenticator'
import { portalOf } from '../../auth/portal/service'
import { partyReaders } from './people'
import { assignInCommand, closeOne, reopenInCommand, taskById, TASK_COLUMNS, type AssignWhy, type TaskRow } from './store'
import { sourceOf } from './sources'
import { assigneeNames, partnerTaskView, taskView } from './views'

/**
 * The partner's one task list (B-W2b-167, COL-043; design portal.frame action-needed "What waits for you", the rail's badges,
 * portal.customer.home "Waiting for you", portal.supplier.home "To do"):
 *
 *   GET  /portal/tasks?state=OPEN|DONE        what waits for THIS person (the kinds their role and capabilities act on) in the
 *                                             portal's company, due first; with the badges per area and the counts; DONE: the
 *                                             last 7 days'
 *   POST /portal/tasks/:taskId/done           "a safe verb runs in place": a request with no answer of its own (asked by hand)
 *                                             is marked done by the person (partner scope: OPEN → DONE, doneById = them)
 *   POST /portal/tasks/:taskId/undo           Undo, by the same person within 10 minutes (reopening is the office's: the
 *                                             office scope as the partner person, after these checks)
 *   GET  /portal/tasks/handover/:userId       the admin deactivating a colleague: their open requests, which stay with others
 *                                             who can act on them, which only they could act on (B-W2b-F14: and how many
 *                                             were handed to them: on deactivation those go back to everyone)
 *   POST /portal/tasks/:taskId/assign         B-W2b-F14 (PartnerTask.assigneeId): take an open request, hand it to an
 *                                             active colleague who can act on it, or give it back to everyone (null);
 *                                             `?mine=true` on the list shows only the ones handed to the person
 * Reads run in the session's party scope (row-level security: never another party's request); the rows are the portal's
 * company's. An office preview reads what the party's people would (no Done, no Undo).
 */

const LIST_MAX = 1000
const DONE_DAYS = 7

/** The party's code (its portal address) in the partner scope. */
async function partyCode(request: FastifyRequest, session: PortalSession): Promise<string> {
  const party = await request.withClient((client) => client.party.findUnique({ where: { id: session.partyId }, select: { code: true } }))
  return party?.code ?? session.partyId
}

export async function myTasks(request: FastifyRequest, state: 'OPEN' | 'DONE', now: Date, onlyMine = false) {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  const since = new Date(now.getTime() - DONE_DAYS * DAY_MS)
  const rows = await request.withClient((client) =>
    client.partnerTask.findMany({
      where: { companyId: session.company.id, status: state, ...(state === 'DONE' ? { closedAt: { gte: since } } : {}) },
      orderBy: state === 'DONE' ? [{ closedAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LIST_MAX,
      select: TASK_COLUMNS,
    }),
  )
  const mine = rows.filter((row) => isTaskFor(actor, row))
  if (state === 'OPEN') mine.sort(byDue)
  const code = await partyCode(request, session)
  // B-W2b-F14: the names of the colleagues tasks are handed to (the partner reads its own party's people).
  const names = await request.withClient((client) => assigneeNames(client, mine))
  const facts = { partyCode: code, personId: session.userId, preview: session.preview, names, partnerKind: session.person.partnerKind }
  const open = state === 'OPEN' ? mine : []
  // "Mine": only the ones handed to this person; the badges and counts stay the whole list's.
  const shown = onlyMine ? mine.filter((row) => row.assigneeId === session.userId) : mine
  return {
    asOf: toUtcIso(now),
    state,
    mine: onlyMine,
    items: shown.map((row) => partnerTaskView(row, now, facts)),
    // B-W2b-F17: per the person's partner kind (a supplier's or a workshop's approvals count on Home).
    badges: badgesOf(open, session.person.partnerKind).map((badge) => ({ ...badge, words: { it: badgeWords(badge, 'it'), en: badgeWords(badge, 'en') } })),
    counts: {
      open: open.length,
      overdue: open.filter((row) => dueStateOf(row.dueAt, now) === 'OVERDUE').length,
      dueSoon: open.filter((row) => ['TODAY', 'SOON'].includes(dueStateOf(row.dueAt, now))).length,
      mine: open.filter((row) => row.assigneeId === session.userId).length,
    },
    live: { events: ['partner_task.opened', 'partner_task.closed', 'partner_task.reopened', 'partner_task.due_moved', 'partner_task.assigned'] },
  }
}

/** "2 to confirm, 1 to accept" in a language. */
function badgeWords(badge: { kinds: Partial<Record<keyof typeof KIND_RULES, number>> }, locale: 'it' | 'en'): string {
  return Object.entries(badge.kinds)
    .map(([kind, count]) => `${count} ${KIND_RULES[kind as keyof typeof KIND_RULES].badge[locale]}`)
    .join(', ')
}

/** A task of the session's party and company that is for this person, or 404 (another party's is as unknown as a wrong id). */
async function myTask(request: FastifyRequest, taskId: string): Promise<TaskRow> {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  const task = await request.withClient((client) => taskById(client, taskId))
  if (!task || task.companyId !== session.company.id || !isTaskFor(actor, task)) throw new NotFoundError('Request not found.')
  return task
}

export async function markDone(app: FastifyInstance, request: FastifyRequest, taskId: string, version: number, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  const before = await myTask(request, taskId)
  if (sourceOf(before.sourceKey)?.partnerDone !== true) throw new InvalidStateError(`Answer it where it is: ${KIND_RULES[before.kind].verb.en.toLowerCase()} on its page.`)
  const { result } = await commandOn(app, request, { name: 'portalTasks.done', idempotencyKey, input: { taskId, version } }, async (tools) => {
    const task = await taskById(tools.tx, taskId)
    if (!task) throw new NotFoundError('Request not found.')
    if (task.version !== version) throw new ConflictError(`This request changed since you read it (now version ${task.version}). Read it again.`)
    await closeOne(tools, task, 'DONE', session.userId, true)
    return null
  })
  void result
  return { task: await viewOf(request, session, taskId, now) }
}

/** One task as the partner reads it now (its record link, its assignee's name). */
async function viewOf(request: FastifyRequest, session: PortalSession, taskId: string, now: Date) {
  const code = await partyCode(request, session)
  const { row, names } = await request.withClient(async (client) => {
    const found = (await taskById(client, taskId))!
    return { row: found, names: await assigneeNames(client, [found]) }
  })
  return partnerTaskView(row, now, { partyCode: code, personId: session.userId, preview: session.preview, names, partnerKind: session.person.partnerKind })
}

export async function undoDone(app: FastifyInstance, request: FastifyRequest, taskId: string, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  const task = await myTask(request, taskId)
  const problem = undoProblem(task, session.userId, now)
  if (problem) throw new InvalidStateError(problem)
  // The partner role only marks done; reopening runs in the tenant's office scope as the partner person, after the checks above.
  const p = portalOf(app)
  await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalTasks.undo', idempotencyKey, input: { taskId, version: task.version } }, async (tools) => {
    const current = await taskById(tools.tx, taskId)
    if (!current || current.partyId !== session.partyId) throw new NotFoundError('Request not found.')
    const again = undoProblem(current, session.userId, tools.now)
    if (again) throw new InvalidStateError(again)
    await reopenInCommand(tools, current, true)
    return null
  })
  return { task: await viewOf(request, session, taskId, now) }
}

export interface AssignBody {
  readonly version: number
  /** The colleague (the person themself: take it); null: back to everyone of the party. */
  readonly assigneeId: string | null
}

/** A refusal of an assignment, its code in the path (`body/assigneeId/<CODE>`): the web has the words. */
const notAssignable = (code: 'INACTIVE' | 'NO_ACCESS' | 'CANNOT_ACT', message: string): DomainError => new DomainError('invalid_state', message, [{ path: `body/assigneeId/${code}`, message }])

/**
 * B-W2b-F14: takes a request, hands it to a colleague or gives it back to everyone. Refused first in words (the database's
 * guard holds the same): a closed request (only an open one moves), a colleague who is not an ACTIVE person of the party
 * (another party's is unknown: 404), one who cannot use the portal now, one whose role does not act on the request's
 * kind. Runs in the tenant's office scope as the person (the partner role only marks a task done), on the app's clock.
 */
export async function assignTask(app: FastifyInstance, request: FastifyRequest, taskId: string, body: AssignBody, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  if (session.preview) throw new ForbiddenError('A preview reads only.')
  const task = await myTask(request, taskId)
  if (task.status !== 'OPEN') throw new DomainError('invalid_state', task.status === 'DONE' ? 'This request is already done: only an open request is handed to a colleague.' : 'This request was withdrawn: only an open request is handed to a colleague.', [{ path: `task/${task.status}`, message: 'Only an open request moves.' }])
  if (task.version !== body.version) throw new ConflictError(`This request changed since you read it (now version ${task.version}). Read it again.`)
  if (task.assigneeId === body.assigneeId) return { task: await viewOf(request, session, taskId, now) }
  if (body.assigneeId !== null && body.assigneeId !== session.userId) {
    const colleagueId = body.assigneeId
    // The partner scope reads its own party's people only: another party's person is as unknown as a wrong id.
    const colleague = await request.withClient((client) => client.user.findUnique({ where: { id: colleagueId }, select: { id: true, partyId: true, audience: true, status: true, displayName: true } }))
    if (!colleague || colleague.partyId !== session.partyId || colleague.audience !== 'PARTNER') throw new NotFoundError('Colleague not found.')
    if (colleague.status !== 'ACTIVE') throw notAssignable('INACTIVE', `${colleague.displayName} is not active in the portal: hand it to an active colleague.`)
    const p = portalOf(app)
    const readers = await p.auth.inTenant(session.tenantId, session.userId, (client) => partyReaders(client, session.tenantId, session.partyId, session.company.id, now))
    const reader = readers.find((entry) => entry.personId === colleague.id)
    if (!reader) throw notAssignable('NO_ACCESS', `${colleague.displayName} cannot use the portal now (their access ended or is paused): hand it to someone else.`)
    if (!isTaskFor(reader.actor, task)) throw notAssignable('CANNOT_ACT', `${colleague.displayName} cannot ${KIND_RULES[task.kind].verb.en.toLowerCase()} this: their role does not allow it.`)
  }
  const why: AssignWhy = body.assigneeId === null ? 'RELEASED' : body.assigneeId === session.userId ? 'TAKEN' : 'GIVEN'
  // The partner role only marks a task done: the move runs in the tenant's office scope as the person, after the checks above.
  const p = portalOf(app)
  await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalTasks.assign', idempotencyKey, input: { taskId, ...body } }, async (tools) => {
    const current = await taskById(tools.tx, taskId)
    if (!current || current.partyId !== session.partyId || current.companyId !== session.company.id) throw new NotFoundError('Request not found.')
    if (current.version !== body.version) throw new ConflictError(`This request changed since you read it (now version ${current.version}). Read it again.`)
    await assignInCommand(tools, current, body.assigneeId, why)
    return null
  })
  return { task: await viewOf(request, session, taskId, now) }
}

export async function handover(app: FastifyInstance, request: FastifyRequest, userId: string, now: Date) {
  const session = portalSessionOf(request)
  if (userId === session.userId) throw new ForbiddenError('You cannot hand over your own requests: ask another admin or the factory.')
  const colleague = await request.withClient((client) => client.user.findUnique({ where: { id: userId }, select: { id: true, partyId: true, audience: true } }))
  if (!colleague || colleague.partyId !== session.partyId || colleague.audience !== 'PARTNER') throw new NotFoundError('Colleague not found.')
  const open = await request.withClient((client) => client.partnerTask.findMany({ where: { companyId: session.company.id, status: 'OPEN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: LIST_MAX, select: TASK_COLUMNS }))
  const p = portalOf(app)
  const readers = await p.auth.inTenant(session.tenantId, session.userId, (client) => partyReaders(client, session.tenantId, session.partyId, session.company.id, now, { includeAll: true }))
  const leaver = readers.find((reader) => reader.personId === userId)
  const others = readers.filter((reader) => reader.personId !== userId)
  const theirs = leaver ? open.filter((task) => isTaskFor(leaver.actor, task)) : []
  const alone = theirs.filter((task) => !others.some((reader) => isTaskFor(reader.actor, task)))
  // B-W2b-F14: the open requests handed to them go back to everyone when they are deactivated.
  const assigned = open.filter((task) => task.assigneeId === userId).length
  const colleagues = others
    .map((reader) => ({ id: reader.personId, displayName: reader.displayName, count: theirs.filter((task) => isTaskFor(reader.actor, task)).length }))
    .filter((entry) => entry.count > 0)
  return {
    open: theirs.length,
    kept: theirs.length - alone.length,
    assigned,
    alone: alone.map((task) => {
      const view = taskView(task, now)
      return { id: view.id, kind: view.kind, words: view.words, record: view.record, dueAt: view.dueAt }
    }),
    colleagues,
  }
}
