import type { Prisma } from '@nexus/factory-db'
import { APPROVALS_REQUEST, APPROVALS_VIEW } from '@nexus/factory-domain/approvals/permissions'
import { APPROVAL_REFUSALS, APPROVAL_TILES, ownRequestWords, staleWords, type ApprovalTaskKind, type ApprovalTile } from '@nexus/factory-domain/approvals/rules'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { activeReasonCodes } from '../reasons/service'
import { askApproval, markApproved, markRejected, markStale, markWithdrawn, recheck, taskInCommand } from './engine'
import { historyOf, historySourceOf } from './history/registry'
import { kindOf } from './kinds'
import {
  approverRolesOf,
  askedBy,
  askersOfTask,
  decideCheck,
  decidersOf,
  fieldsOfKind,
  officeOf,
  peopleNames,
  TASK_COLUMNS,
  visibleTasks,
  waitingFor,
  type HeldApproverRole,
  type Reader,
  type TaskRow,
} from './store'
import { historyLineView, taskDetailOf, taskRows, type TaskDetailView, type ViewContext } from './views'

/**
 * The requests for a yes (B-W2b-282; PLT-042, PLT-091, PLT-093, PLT-104, PLT-105; design home.approvals): the inbox with its
 * tiles (Waiting for me · Overdue · Asked by me · Decided last 7 days) and its notice, one request (its change, re-check
 * line, rules, deciders and history), the yes, the no, taking one's request back, asking from the generic route, and a
 * record's approval history. Each decision is ONE command on the ApprovalTask (its version guards it); the database refuses
 * what the engine refuses, for every login.
 */

const DAY_MS = 86_400_000

/**
 * A refusal of the approvals guards (…_approvals_w2b_guards: check_violation 'approvals: …') when a write reached it without
 * the engine's check (a race): a 409 in the database's words, never a 500.
 */
export function databaseRefusal(error: unknown): never {
  const original = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string' && original.originalMessage.startsWith('approvals: ')) {
    const words = original.originalMessage.slice('approvals: '.length)
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  throw error
}

const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    return databaseRefusal(error)
  }
}

async function viewOf(db: Reader, context: OfficeContext): Promise<ViewContext> {
  const now = serverClock.now()
  return { context, roles: await approverRolesOf(db, context.actorId, now), now }
}

function tileWhere(tile: ApprovalTile, context: OfficeContext, roles: readonly HeldApproverRole[], now: Date): Prisma.ApprovalTaskWhereInput {
  const actor = actorOf(context)
  switch (tile) {
    case 'WAITING_FOR_ME':
      return waitingFor(actor, context.actorId, roles)
    case 'OVERDUE':
      return { AND: [waitingFor(actor, context.actorId, roles), { dueAt: { lt: now } }] }
    case 'ASKED_BY_ME':
      return { AND: [askedBy(context.actorId), { status: 'PENDING' }] }
    case 'DECIDED_7_DAYS':
      return { decidedById: context.actorId, decidedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }
  }
}

const offsetOf = (cursor: string | undefined): number => {
  if (!cursor) return 0
  const match = /^o:(\d{1,6})$/.exec(cursor)
  if (!match) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Not a cursor of this list.' }])
  return Number(match[1])
}

export interface ListQuery {
  readonly tile?: ApprovalTile | undefined
  readonly status?: string | undefined
  readonly kind?: ApprovalTaskKind | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly companyId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /approvals/tasks: the inbox (design home.approvals tiles, notice, queue, asked-by-me). */
export async function listTasks(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const view = await viewOf(db, context)
    const visible = visibleTasks(actor, context.actorId, view.roles)
    const status = query.status === 'ALL' ? undefined : (query.status as TaskRow['status'] | undefined)
    const filters: Prisma.ApprovalTaskWhereInput[] = [
      visible,
      query.tile ? tileWhere(query.tile, context, view.roles, view.now) : {},
      status ? { status } : {},
      query.kind ? { kind: query.kind } : {},
      query.recordType ? { recordType: query.recordType } : {},
      query.recordId ? { recordId: query.recordId } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.q ? { summary: { contains: query.q, mode: 'insensitive' } } : {},
    ]
    const oldestFirst = query.tile === 'WAITING_FOR_ME' || query.tile === 'OVERDUE'
    const offset = offsetOf(query.cursor)
    const tasks = await db.approvalTask.findMany({
      where: { AND: filters },
      orderBy: oldestFirst ? [{ requestedAt: 'asc' }, { id: 'asc' }] : [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
      select: TASK_COLUMNS,
    })
    const page = tasks.slice(0, query.limit)
    const rows = await taskRows(db, page, view)
    const tiles = await Promise.all(APPROVAL_TILES.map(async (tile) => ({ tile, count: await db.approvalTask.count({ where: { AND: [visible, tileWhere(tile, context, view.roles, view.now)] } }) })))
    return {
      asOf: toUtcIso(view.now),
      tiles,
      notice: { changedSinceAsked: rows.filter((row) => row.status === 'PENDING' && row.recheck === 'CHANGED').length },
      rows,
      nextCursor: tasks.length > query.limit ? `o:${offset + query.limit}` : null,
    }
  })
}

async function visibleTask(db: Reader, context: OfficeContext, roles: readonly HeldApproverRole[], taskId: string): Promise<TaskRow> {
  const task = await db.approvalTask.findFirst({ where: { AND: [{ id: taskId }, visibleTasks(actorOf(context), context.actorId, roles)] }, select: TASK_COLUMNS })
  if (!task) throw new NotFoundError()
  return task
}

async function detail(db: Reader, context: OfficeContext, taskId: string): Promise<TaskDetailView> {
  const view = await viewOf(db, context)
  const task = await visibleTask(db, context, view.roles, taskId)
  const history = (await historyOf(db, historySourceOf(task.recordType) ?? { recordType: task.recordType, place: async () => null, may: () => false }, task.recordId)).filter((line) => line.taskId === task.id)
  return taskDetailOf(db, task, view, history)
}

/** GET /approvals/tasks/:id: one request as the review popup reads it. */
export async function getTask(caller: CommandCaller, taskId: string) {
  const context = officeOf(caller)
  return { task: await caller.withClient((db) => detail(db, context, taskId)) }
}

/** The request's refusal in words: NOT_PENDING 409, OWN_REQUEST 403 (naming who may decide), NOT_APPROVER 403. */
async function refuse(db: Reader, context: OfficeContext, task: TaskRow, code: 'NOT_PENDING' | 'OWN_REQUEST' | 'NOT_APPROVER', now: Date): Promise<never> {
  if (code === 'NOT_PENDING') throw new DomainError('conflict', APPROVAL_REFUSALS.NOT_PENDING, [{ path: 'refusal/NOT_PENDING', message: APPROVAL_REFUSALS.NOT_PENDING }])
  if (code === 'OWN_REQUEST') {
    const deciders = await decidersOf(db, context.tenantId, task, task, await askersOfTask(db, task), now)
    const words = ownRequestWords(deciders.map((entry) => entry.name))
    throw new DomainError('forbidden', words, [{ path: 'refusal/OWN_REQUEST', message: words }])
  }
  throw new DomainError('forbidden', APPROVAL_REFUSALS.NOT_APPROVER, [{ path: 'refusal/NOT_APPROVER', message: APPROVAL_REFUSALS.NOT_APPROVER }])
}

/** The checks every decision makes inside its command, in this order: still pending, not one's own, one's to decide. */
async function decidable(tools: CommandTools, context: OfficeContext, taskId: string): Promise<TaskRow> {
  const task = await taskInCommand(tools.tx, taskId)
  const roles = await approverRolesOf(tools.tx, context.actorId, tools.now)
  const check = decideCheck(context, task, await askersOfTask(tools.tx, task), roles)
  if (!check.allowed) await refuse(tools.tx, context, task, check.code, tools.now)
  return task
}

/** Read before the command: a request decided already answers in words (the version bump would meet the guard first). */
async function preflight(caller: CommandCaller, context: OfficeContext, taskId: string): Promise<void> {
  await caller.withClient(async (db) => {
    const view = await viewOf(db, context)
    const task = await visibleTask(db, context, view.roles, taskId)
    if (task.status !== 'PENDING') await refuse(db, context, task, 'NOT_PENDING', view.now)
  })
}

type Outcome = { readonly outcome: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' } | { readonly outcome: 'STALE'; readonly words: string } | { readonly outcome: 'GONE' }

/**
 * POST /approvals/tasks/:id/approve (PLT-093, PLT-105): the yes, by the request's approver who did not ask it. The subject
 * is re-read and its fingerprint compared first: changed → the request is STALE (committed) and the answer is 409 "It
 * changed since you looked"; gone → WITHDRAWN by the system and 409. Then a signed request asks a fresh step-up (`stepUp`
 * returns the session's, or refuses 403 `stepUp`). APPROVED with the comment, its APPROVED (and SIGNED) line, the kind's hook.
 */
export async function approveTask(caller: CommandCaller, taskId: string, body: { version: number; comment: string | null }, stepUp: () => Date, idempotencyKey?: string) {
  const context = officeOf(caller)
  await preflight(caller, context, taskId)
  const { result } = await guarded(() =>
    command(caller, { name: 'approvals.decide', idempotencyKey, input: { ...body, decision: 'APPROVE' }, record: { type: 'ApprovalTask', id: taskId, expectedVersion: body.version } }, async (tools): Promise<Outcome> => {
      const task = await decidable(tools, context, taskId)
      const kind = kindOf(task.kind)
      if (!kind || kind.recordType !== task.recordType) throw new DomainError('conflict', APPROVAL_REFUSALS.NO_KIND, [{ path: 'refusal/NO_KIND', message: APPROVAL_REFUSALS.NO_KIND }])
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.approvals', ${context.tenantId}::text, ${task.recordType}::text, ${task.recordId}::text), 0))`
      await kind.lock?.(tools.tx, task.recordId)
      const state = await recheck(tools.tx, task)
      if (state.state === 'GONE') {
        await markWithdrawn(tools, task, null, 'The record of this request went away.')
        return { outcome: 'GONE' }
      }
      if (state.state === 'CHANGED') {
        await markStale(tools, task)
        const fields = fieldsOfKind(task.kind)
        return { outcome: 'STALE', words: staleWords(state.changed.filter((entry) => entry.grain === null), (field) => fields.find((entry) => entry.id === field)?.label.en ?? field) }
      }
      // The re-check first (a request that changed needs no code: it is asked again); then the signature's fresh code.
      const stepUpAt = task.requireStepUp ? stepUp() : null
      await markApproved(tools, task, { deciderId: context.actorId, comment: body.comment, stepUpAt })
      return { outcome: 'APPROVED' }
    }),
  )
  if (result.outcome === 'STALE') throw new DomainError('conflict', result.words, [{ path: 'refusal/STALE', message: result.words }])
  if (result.outcome === 'GONE') throw new DomainError('conflict', APPROVAL_REFUSALS.SUBJECT_GONE, [{ path: 'refusal/SUBJECT_GONE', message: APPROVAL_REFUSALS.SUBJECT_GONE }])
  return getTask(caller, taskId)
}

/** POST /approvals/tasks/:id/reject (PLT-091): the no, with a reason of the APPROVAL_REJECT list and words. */
export async function rejectTask(caller: CommandCaller, taskId: string, body: { version: number; reasonCode: string; reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await preflight(caller, context, taskId)
  await guarded(() =>
    command(caller, { name: 'approvals.decide', idempotencyKey, input: { ...body, decision: 'REJECT' }, record: { type: 'ApprovalTask', id: taskId, expectedVersion: body.version } }, async (tools): Promise<Outcome> => {
      const task = await decidable(tools, context, taskId)
      const codes = await activeReasonCodes(tools.tx, 'APPROVAL_REJECT')
      if (!codes.has(body.reasonCode)) throw new ValidationError(APPROVAL_REFUSALS.REASON_CODE, [{ path: 'body/reasonCode', message: APPROVAL_REFUSALS.REASON_CODE }])
      await markRejected(tools, task, { deciderId: context.actorId, reasonCode: body.reasonCode, reason: body.reason })
      return { outcome: 'REJECTED' }
    }),
  )
  return getTask(caller, taskId)
}

/** POST /approvals/tasks/:id/withdraw: the person who asked (or wrote) it takes it back before a decision. */
export async function withdrawTask(caller: CommandCaller, taskId: string, body: { version: number; note: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await preflight(caller, context, taskId)
  await guarded(() =>
    command(caller, { name: 'approvals.request', idempotencyKey, input: { ...body, decision: 'WITHDRAW' }, record: { type: 'ApprovalTask', id: taskId, expectedVersion: body.version } }, async (tools): Promise<Outcome> => {
      const task = await taskInCommand(tools.tx, taskId)
      if (task.status !== 'PENDING') throw new DomainError('conflict', APPROVAL_REFUSALS.NOT_PENDING, [{ path: 'refusal/NOT_PENDING', message: APPROVAL_REFUSALS.NOT_PENDING }])
      if (!(await askersOfTask(tools.tx, task)).includes(context.actorId)) throw new DomainError('forbidden', APPROVAL_REFUSALS.NOT_REQUESTER, [{ path: 'refusal/NOT_REQUESTER', message: APPROVAL_REFUSALS.NOT_REQUESTER }])
      await markWithdrawn(tools, task, context.actorId, body.note)
      return { outcome: 'WITHDRAWN' }
    }),
  )
  return getTask(caller, taskId)
}

/**
 * POST /approvals/requests: "one command asks for a yes" from the generic route, for a kind a person asks directly (its
 * `ask` permission over the subject's company and site). No rule holds → 200 { asked: false } and nothing is written.
 */
export async function askForApproval(caller: CommandCaller, body: { kind: ApprovalTaskKind; recordId: string; note: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const kind = kindOf(body.kind)
  if (!kind) throw new DomainError('conflict', APPROVAL_REFUSALS.NO_KIND, [{ path: 'body/kind', message: APPROVAL_REFUSALS.NO_KIND }])
  if (!kind.ask) throw new DomainError('conflict', APPROVAL_REFUSALS.NOT_ASKABLE, [{ path: 'body/kind', message: APPROVAL_REFUSALS.NOT_ASKABLE }])
  const subject = await caller.withClient((db) => kind.read(db, body.recordId))
  if (!subject || !can(actor, kind.view, { companyId: subject.companyId, siteId: subject.siteId })) throw new NotFoundError()
  if (!can(actor, kind.ask, { companyId: subject.companyId, siteId: subject.siteId }) || !can(actor, APPROVALS_REQUEST, { companyId: subject.companyId, siteId: subject.siteId })) throw new ForbiddenError()
  const { result } = await guarded(() =>
    command(caller, { name: 'approvals.request', idempotencyKey, input: body }, async (tools) => {
      const outcome = await askApproval(tools, { kind: kind.kind, recordId: body.recordId, requester: { userId: context.actorId }, note: body.note })
      if (!outcome.asked) tools.audit({ action: 'approvals.request', recordType: kind.recordType, recordId: body.recordId, companyId: subject.companyId, siteId: subject.siteId, after: { kind: kind.kind, asked: false } })
      return outcome
    }),
  )
  if (!result.asked) return { status: 200 as const, body: { asked: false as const, why: 'No approval rule asks for a yes on it: it goes on as it is.' } }
  return { status: 201 as const, body: { asked: true as const, task: (await getTask(caller, result.taskId)).task } }
}

/** GET /approvals/history/:recordType/:recordId (PLT-104): every approval line of a record, newest first. */
export async function recordHistory(caller: CommandCaller, recordType: string, recordId: string, query: { cursor?: string | undefined; limit: number }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!holds(actor, APPROVALS_VIEW)) throw new ForbiddenError()
  const source = historySourceOf(recordType)
  if (!source) throw new NotFoundError('This kind of record has no approval history.')
  return caller.withClient(async (db) => {
    const place = await source.place(db, recordId)
    if (!place || !source.may(actor, place)) throw new NotFoundError()
    const lines = await historyOf(db, source, recordId)
    const offset = offsetOf(query.cursor)
    const page = lines.slice(offset, offset + query.limit)
    const people = await peopleNames(db, page.map((entry) => entry.byId))
    const workerIds = [...new Set(page.map((entry) => entry.byWorkerId).filter((id): id is string => id !== null))]
    const workers = new Map((workerIds.length ? await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } }) : []).map((worker) => [worker.id, worker.displayName]))
    return {
      record: { type: recordType, id: recordId },
      lines: page.map((entry) => historyLineView(entry, context.actorId, people, workers)),
      nextCursor: lines.length > offset + query.limit ? `o:${offset + query.limit}` : null,
    }
  })
}
