import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PARTNERS_VIEW } from '@nexus/factory-domain/auth/partners/permissions'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import { PARTNERS_TASKS_MANAGE } from '@nexus/factory-domain/portal/tasks/permissions'
import { askProblems, byDue, dueProblems } from '@nexus/factory-domain/portal/tasks/rules'
import type { CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { appClock, commandOn } from './clock'
import { recordLabelOf } from '../../threads/labels'
import { resolveRecord } from '../../threads/records'
import { closeOne, moveDueInCommand, openTaskInCommand, reopenInCommand, taskById, TASK_COLUMNS, type TaskRow } from './store'
import { taskView } from './views'

/**
 * The office's side of the requests to partners (B-W2b-167, COL-043; design office home.tasks "tasks staff give the customer",
 * sales.customers and purchasing.suppliers › Portal access):
 *
 *   GET   /partners/:partyId/tasks                 the party's requests (partners.view over each request's company)
 *   POST  /partners/:partyId/tasks                 ask the party for a document, an answer, measurements or progress on a
 *                                                  record of theirs, by a date (partners.tasks.manage over the record)
 *   POST  /partner-tasks/:taskId/cancel|reopen     withdraw a request, or open it again (any source's)
 *   PATCH /partner-tasks/:taskId                   move its due date
 * Each write is a command with the request's version (409 when it moved meanwhile).
 */

function officeOf(request: FastifyRequest): OfficeContext {
  const context = request.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const OFFICE_LIST_MAX = 1000

export async function partyTasks(app: FastifyInstance, request: FastifyRequest, partyId: string, status: 'OPEN' | 'DONE' | 'CANCELLED' | 'ALL') {
  const context = officeOf(request)
  const actor = actorOf(context)
  const now = appClock(app).now()
  const { party, rows } = await request.withClient(async (client) => ({
    party: await client.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true } }),
    rows: await client.partnerTask.findMany({ where: { partyId, ...(status === 'ALL' ? {} : { status }) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: OFFICE_LIST_MAX + 1, select: TASK_COLUMNS }),
  }))
  if (!party || !can(actor, PARTNERS_VIEW, { companyId: party.companyId, partyId })) throw new NotFoundError('Partner not found.')
  const visible = rows.slice(0, OFFICE_LIST_MAX).filter((row) => can(actor, PARTNERS_VIEW, { companyId: row.companyId, partyId }))
  if (status === 'OPEN') visible.sort(byDue)
  return { asOf: toUtcIso(now), items: visible.map((row) => taskView(row, now)), complete: rows.length <= OFFICE_LIST_MAX }
}

export interface AskBody {
  readonly kind: string
  readonly recordType: string
  readonly recordId: string
  readonly dueAt: string | null
  readonly companyId?: string | undefined
}

export async function askPartner(app: FastifyInstance, request: FastifyRequest, partyId: string, body: AskBody, idempotencyKey?: string) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const dueAt = body.dueAt === null ? null : new Date(body.dueAt)
  const problems = askProblems({ kind: body.kind, dueAt }, appClock(app).now())
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await commandOn(app, request, { name: 'partnerTasks.ask', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    const { tx } = tools
    const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true } })
    if (!party || !can(actor, PARTNERS_VIEW, { companyId: party.companyId, partyId })) throw new NotFoundError('Partner not found.')
    const scope = await resolveRecord(tx, body.recordType, body.recordId)
    const ofParty = scope !== null && (scope.partyId === partyId || (body.recordType === 'Party' && body.recordId === partyId))
    if (!scope || !ofParty) throw new ValidationError('Ask on a record of this partner: an order, a quote, a document of theirs, or the partner itself.', [{ path: 'body/recordId', message: 'Not a record of this partner.' }])
    const companyId = scope.companyId ?? party.companyId ?? body.companyId ?? null
    if (companyId === null) throw new ValidationError('Name the company whose portal shows the request.', [{ path: 'body/companyId', message: 'A tenant-wide partner: name the company.' }])
    if (scope.companyId !== null && body.companyId !== undefined && body.companyId !== scope.companyId) throw new ValidationError("The record is the other company's.", [{ path: 'body/companyId', message: "The record is the other company's." }])
    if (!can(actor, PARTNERS_TASKS_MANAGE, { companyId, siteId: scope.siteId, partyId })) throw new ForbiddenError('You may not ask this partner for anything on this record.')
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } })
    if (!company) throw new ValidationError('No such company.', [{ path: 'body/companyId', message: 'No such company.' }])
    const me = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
    const label = (await recordLabelOf(tx, body.recordType, body.recordId)) ?? body.recordType
    const { task, made } = await openTaskInCommand(tools, {
      companyId,
      partyId,
      kind: body.kind as PartnerTaskKind,
      record: { type: body.recordType, id: body.recordId, label },
      sourceKey: `Ask:${newId()}`,
      dueAt,
      askedBy: { id: context.actorId, name: me?.displayName ?? 'Office' },
    })
    return { task: taskView(task, tools.now), made }
  })
  return result
}

/** A request the office person may change: they hold partners.tasks.manage over its company and party. */
async function managedTask(request: FastifyRequest, taskId: string, version: number): Promise<TaskRow> {
  const actor = actorOf(officeOf(request))
  const task = await request.withClient((client) => taskById(client, taskId))
  if (!task || !can(actor, PARTNERS_VIEW, { companyId: task.companyId, partyId: task.partyId })) throw new NotFoundError('Request not found.')
  if (!can(actor, PARTNERS_TASKS_MANAGE, { companyId: task.companyId, partyId: task.partyId })) throw new ForbiddenError('You may not change the requests to this partner.')
  if (task.version !== version) throw new ConflictError(`This request changed since you read it (now version ${task.version}). Read it again.`)
  return task
}

async function change(app: FastifyInstance, request: FastifyRequest, name: 'partnerTasks.cancel' | 'partnerTasks.reopen' | 'partnerTasks.moveDue', taskId: string, version: number, input: Record<string, unknown>, work: (tools: CommandTools, task: TaskRow) => Promise<unknown>, idempotencyKey?: string) {
  await managedTask(request, taskId, version)
  const { result } = await commandOn(app, request, { name, idempotencyKey, input: { taskId, version, ...input } }, async (tools) => {
    const task = await taskById(tools.tx, taskId)
    if (!task) throw new NotFoundError('Request not found.')
    if (task.version !== version) throw new ConflictError(`This request changed since you read it (now version ${task.version}). Read it again.`)
    await work(tools, task)
    return { task: taskView((await taskById(tools.tx, taskId))!, tools.now) }
  })
  return result
}

export const cancelTask = (app: FastifyInstance, request: FastifyRequest, taskId: string, version: number, key?: string) => change(app, request, 'partnerTasks.cancel', taskId, version, {}, (tools, task) => closeOne(tools, task, 'CANCELLED', null, false), key)

export const reopenTask = (app: FastifyInstance, request: FastifyRequest, taskId: string, version: number, key?: string) => change(app, request, 'partnerTasks.reopen', taskId, version, {}, (tools, task) => reopenInCommand(tools, task, false), key)

export function moveDue(app: FastifyInstance, request: FastifyRequest, taskId: string, body: { readonly version: number; readonly dueAt: string | null }, key?: string) {
  const dueAt = body.dueAt === null ? null : new Date(body.dueAt)
  const problems = dueProblems(dueAt, appClock(app).now())
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return change(app, request, 'partnerTasks.moveDue', taskId, body.version, { dueAt: body.dueAt }, (tools, task) => moveDueInCommand(tools, task, dueAt), key)
}
