import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { KIND_RULES } from '@nexus/factory-domain/portal/tasks/kinds'
import { badgesOf, byDue, DAY_MS, dueStateOf, isTaskFor, undoProblem } from '@nexus/factory-domain/portal/tasks/rules'
import { commandOn } from './clock'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../auth/portal/authenticator'
import { portalOf } from '../../auth/portal/service'
import { partyReaders } from './people'
import { closeOne, reopenInCommand, taskById, TASK_COLUMNS, type TaskRow } from './store'
import { sourceOf } from './sources'
import { partnerTaskView, taskView } from './views'

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
 *                                             who can act on them, which only they could act on
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

export async function myTasks(request: FastifyRequest, state: 'OPEN' | 'DONE', now: Date) {
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
  const facts = { partyCode: code, personId: session.userId, preview: session.preview }
  const open = state === 'OPEN' ? mine : []
  return {
    asOf: toUtcIso(now),
    state,
    items: mine.map((row) => partnerTaskView(row, now, facts)),
    badges: badgesOf(open).map((badge) => ({ ...badge, words: { it: badgeWords(badge, 'it'), en: badgeWords(badge, 'en') } })),
    counts: {
      open: open.length,
      overdue: open.filter((row) => dueStateOf(row.dueAt, now) === 'OVERDUE').length,
      dueSoon: open.filter((row) => ['TODAY', 'SOON'].includes(dueStateOf(row.dueAt, now))).length,
    },
    live: { events: ['partner_task.opened', 'partner_task.closed', 'partner_task.reopened', 'partner_task.due_moved'] },
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
  const code = await partyCode(request, session)
  return { task: partnerTaskView((await request.withClient((client) => taskById(client, taskId)))!, now, { partyCode: code, personId: session.userId, preview: session.preview }) }
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
  const code = await partyCode(request, session)
  return { task: partnerTaskView((await request.withClient((client) => taskById(client, taskId)))!, now, { partyCode: code, personId: session.userId, preview: session.preview }) }
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
  const colleagues = others
    .map((reader) => ({ id: reader.personId, displayName: reader.displayName, count: theirs.filter((task) => isTaskFor(reader.actor, task)).length }))
    .filter((entry) => entry.count > 0)
  return {
    open: theirs.length,
    kept: theirs.length - alone.length,
    alone: alone.map((task) => {
      const view = taskView(task, now)
      return { id: view.id, kind: view.kind, words: view.words, record: view.record, dueAt: view.dueAt }
    }),
    colleagues,
  }
}
