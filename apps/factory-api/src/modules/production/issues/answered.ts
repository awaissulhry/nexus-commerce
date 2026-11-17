import { isUuid } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { eventFor } from '@nexus/factory-domain/events/define'
import { productionIssueAnswered } from '@nexus/factory-domain/production-brand/events'
import { answeredAtOf, answersBrandIssue, issueAfterTask, ISSUE_TASK_MOVES, type AnsweringMessage, type IssueSource, type IssueStatus, type IssueTaskMove } from '@nexus/factory-domain/production-brand/issues'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import type { Reader } from '../supervisor/resolver'
import { issueEscalationTaskId } from './raise'

/**
 * B-PR-43b — when an issue is answered (production plan §3 "Issues: A brand's issue counts as answered only when we reply in the
 * thread (a ticked task alone keeps 'Waiting on us' and tells the office 'No reply sent yet')"; lead pick L24; review fixes R-42,
 * R-43, R-48). The worker's handler `production.issueAnswered`, for both sources:
 *
 *   task.completed          the issues of that task follow the task's status NOW (a late event never undoes a later move): an
 *   task.changed (status)   OFFICE issue is ANSWERED when its task is done, OPEN again when it reopens, CANCELLED when it is
 *                           cancelled (nobody is asked any more; final); a BRAND issue never moves with its task (the customer
 *                           still reads "Waiting on us"; the office "No reply sent yet": factory-domain officeIssueNote); a
 *                           task.changed of words, due day or snooze is skipped on its payload
 *   thread.message_posted   a SHARED message a person of the office wrote (OUTBOUND, audience PARTNER, author USER, not held) in
 *                           a sales order's thread answers every open BRAND issue raised on that order before it — and every
 *                           other open issue of their batches, on any order of the batch (R-43: the others read "Answered in
 *                           SO-xxxx", `answeredInOrderId`); decided on the payload first, then ONE indexed read of the order's
 *                           open BRAND issues, else nothing (this event is the most frequent)
 *   email.status_changed    SENT / FAILED of a mail from a thread's composer that waited in its undo window (B-TH-048): its
 *                           message was held (no customer read it) and is released now — it answers as above (a mail taken
 *                           back, WITHDRAWN, never does). The rule is the customer's own read of "Answered" (brand-portal
 *                           access.ts officeAnswers)
 *
 * Answering closes every task of the issue (R-42): its batch task and B-PR-45's escalation tasks of it (`issueEscalationTaskId`),
 * written as platform/tasks closes one (audit, task.completed / task.changed). Each change is one system command: issues changed
 * by compare-and-set on their status under row locks (two handlers never answer twice), one production_issue.answered per issue
 * answered (each names ONE customer; office live rule, no partner entry: R-48, PW-15) and one audit row per customer
 * (`production.issuesAnswered`). A repeated job finds nothing left to change.
 */

export const ISSUE_ANSWERED_HANDLER = 'production.issueAnswered'
export const ISSUE_ANSWERED_EVENTS = ['task.completed', 'task.changed', 'thread.message_posted', 'email.status_changed'] as const

const [, , taskCompleted, taskChanged] = taskEvents

const ISSUE = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, salesOrderId: true, taskId: true, source: true, batchId: true, status: true, raisedAt: true } as const
interface IssueRow {
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  readonly partyId: string
  readonly recordType: string
  readonly recordId: string
  readonly salesOrderId: string | null
  readonly taskId: string
  readonly source: IssueSource
  readonly batchId: string | null
  readonly status: IssueStatus
  readonly raisedAt: Date
}

const text = (payload: unknown, key: string): string | null => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : null
}
const list = (payload: unknown, key: string): readonly unknown[] => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined
  return Array.isArray(value) ? value : []
}
const isMove = (value: string): value is IssueTaskMove => (ISSUE_TASK_MOVES as readonly string[]).includes(value)

export interface AnsweredOutcome {
  readonly answered: number
  readonly reopened: number
  readonly cancelled: number
  readonly tasksClosed: number
}
const NOTHING: AnsweredOutcome = Object.freeze({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })

/** The open tasks of these issues: their batch tasks and B-PR-45's escalation tasks of them (steps 1, 2, any person). */
export async function openTasksOfIssues(db: Reader, issues: readonly Pick<IssueRow, 'taskId'>[]): Promise<string[]> {
  const main = [...new Set(issues.map((issue) => issue.taskId))]
  if (main.length === 0) return []
  const rows = await db.task.findMany({ where: { id: { in: main } }, select: { id: true, status: true, recordType: true, recordId: true } })
  const open = rows.filter((row) => row.status === 'OPEN').map((row) => row.id)
  const records = rows.filter((row) => row.recordType !== null && row.recordId !== null)
  if (records.length === 0) return open
  // The escalation tasks sit on the batch task's own record, made by the system (no maker), each for one person.
  const near = await db.task.findMany({
    where: { status: 'OPEN', createdById: null, assigneeId: { not: null }, OR: records.map((row) => ({ recordType: row.recordType!, recordId: row.recordId! })) },
    select: { id: true, assigneeId: true },
  })
  const escalations = near.filter((task) => main.some((taskId) => ([1, 2] as const).some((step) => task.id === issueEscalationTaskId(taskId, step, task.assigneeId!)))).map((task) => task.id)
  return [...new Set([...open, ...escalations])]
}

/** Closes an open task as the system (as platform/tasks does); false when it is not there or no longer open. */
async function closeTask(tools: CommandTools, taskId: string, status: 'DONE' | 'CANCELLED'): Promise<boolean> {
  const { tx, now } = tools
  const row = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, status: true, companyId: true, siteId: true, recordType: true, recordId: true } })
  if (!row || row.status !== 'OPEN') return false
  const { count } = await tx.task.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status, closedAt: now, closedById: null, snoozedUntil: null, version: { increment: 1 }, updatedAt: now } })
  if (count === 0) return false
  const scope = { companyId: row.companyId, siteId: row.siteId }
  tools.audit({ action: 'tasks.setStatus', recordType: 'Task', recordId: taskId, ...scope, before: { status: 'OPEN' }, after: { status, by: 'production.issue' } })
  const about = { taskId, recordType: row.recordType, recordId: row.recordId }
  if (status === 'DONE') tools.emit(eventFor(taskCompleted, { subject: taskId, ...scope, payload: about }))
  else tools.emit(eventFor(taskChanged, { subject: taskId, ...scope, payload: { ...about, status, fields: ['status'] } }))
  return true
}

/** The issues, locked and read again inside the command (their status decides). */
async function lockedIssues(tx: CommandTx, ids: readonly string[]): Promise<IssueRow[]> {
  if (ids.length === 0) return []
  const sorted = [...ids].sort()
  await tx.$queryRaw`SELECT id FROM "ProductionIssue" WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`
  return (await tx.productionIssue.findMany({ where: { id: { in: sorted } }, select: ISSUE, orderBy: { id: 'asc' } })) as IssueRow[]
}

/** One audit row per customer of the issues changed (R-48: each names only its own). */
function auditPerCustomer(tools: CommandTools, changed: readonly { readonly issue: IssueRow; readonly to: IssueStatus }[], by: Record<string, unknown>): void {
  const parties = new Map<string, { companyId: string; rows: (typeof changed)[number][] }>()
  for (const entry of changed) parties.set(entry.issue.partyId, { companyId: entry.issue.companyId, rows: [...(parties.get(entry.issue.partyId)?.rows ?? []), entry] })
  for (const [partyId, share] of parties) {
    tools.audit({ action: 'production.issuesAnswered', recordType: 'Party', recordId: partyId, companyId: share.companyId, after: { ...by, issues: share.rows.map((entry) => ({ issueId: entry.issue.id, status: entry.to })) } })
  }
}

/** An issue moved to `to` by compare-and-set on its status (false: it moved meanwhile). */
async function moveIssue(tools: CommandTools, issue: IssueRow, to: IssueStatus, at: Date): Promise<boolean> {
  const { count } = await tools.tx.productionIssue.updateMany({
    where: { id: issue.id, status: issue.status },
    data: { status: to, answeredAt: to === 'ANSWERED' ? answeredAtOf(issue, at) : null, version: { increment: 1 }, updatedAt: tools.now },
  })
  return count > 0
}

/** A task moved: its OFFICE issues follow its status now (R-42; a BRAND issue waits for a real reply). */
async function onTask(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<AnsweredOutcome> {
  const taskId = text(event.payload, 'taskId')
  if (!taskId || !isUuid(taskId)) return NOTHING
  // A task.changed of its words, due day, checklist or snooze moves no issue: decided on the payload, no read.
  if (event.type === 'task.changed' && !list(event.payload, 'fields').includes('status')) return NOTHING
  const found = await caller.withClient(async (db) => {
    const issues = await db.productionIssue.findMany({ where: { taskId, source: 'OFFICE' }, select: { id: true, status: true } })
    if (issues.length === 0) return null
    const task = await db.task.findUnique({ where: { id: taskId }, select: { status: true } })
    if (!task || !isMove(task.status)) return null
    const move = task.status
    return issues.some((issue) => issueAfterTask({ source: 'OFFICE', status: issue.status as IssueStatus }, move) !== null) ? { ids: issues.map((issue) => issue.id) } : null
  })
  if (!found) return NOTHING
  const { result } = await command(caller, { name: ISSUE_ANSWERED_HANDLER, input: { eventId: event.eventId, taskId }, causationId: event.eventId }, async (tools) => {
    const issues = await lockedIssues(tools.tx, found.ids)
    // The task's status inside the command (after the issues' locks): what it is now decides, never the event's word.
    const task = await tools.tx.task.findUnique({ where: { id: taskId }, select: { status: true } })
    const move = task && isMove(task.status) ? task.status : null
    const changed: { issue: IssueRow; to: IssueStatus }[] = []
    if (move !== null) {
      for (const issue of issues) {
        const to = issueAfterTask(issue, move)
        if (to !== null && (await moveIssue(tools, issue, to, tools.now))) changed.push({ issue, to })
      }
    }
    // Answered or cancelled: every other open task of the issues goes with it (B-PR-45's escalation tasks).
    let tasksClosed = 0
    const ended = changed.filter((entry) => entry.to !== 'OPEN')
    if (ended.length > 0) for (const id of await openTasksOfIssues(tools.tx, ended.map((entry) => entry.issue))) if (id !== taskId && (await closeTask(tools, id, move === 'CANCELLED' ? 'CANCELLED' : 'DONE'))) tasksClosed++
    for (const { issue, to } of changed) {
      if (to !== 'ANSWERED') continue
      tools.emit(eventFor(productionIssueAnswered, { subject: issue.id, companyId: issue.companyId, siteId: issue.siteId, payload: { issueId: issue.id, partyId: issue.partyId, source: issue.source, salesOrderId: issue.salesOrderId, batchId: issue.batchId, answeredInOrderId: null } }))
    }
    if (changed.length > 0) auditPerCustomer(tools, changed, { by: 'task', taskId, move })
    else tools.audit({ action: 'production.issuesAnswered', recordType: 'Task', recordId: taskId, after: { by: 'task', move, changed: 0 } })
    return {
      answered: changed.filter((entry) => entry.to === 'ANSWERED').length,
      reopened: changed.filter((entry) => entry.to === 'OPEN').length,
      cancelled: changed.filter((entry) => entry.to === 'CANCELLED').length,
      tasksClosed,
    }
  })
  return result
}

/** The message that may answer, read: a SalesOrder thread's, as the answered rule needs it. */
const MESSAGE = { at: true, direction: true, audience: true, authorKind: true, held: true } as const

/** A shared office message in a sales order's thread: the open BRAND issues of that order before it, and their batches (R-42, R-43). */
async function answerByMessage(caller: CommandCaller, eventId: string, orderId: string, messageId: string): Promise<AnsweredOutcome> {
  const plan = await caller.withClient(async (db) => {
    // One indexed read: the order's open BRAND issues (tenantId, salesOrderId, status).
    const own = (await db.productionIssue.findMany({ where: { salesOrderId: orderId, status: 'OPEN', source: 'BRAND' }, select: ISSUE })) as IssueRow[]
    if (own.length === 0) return null
    const message = (await db.message.findUnique({ where: { id: messageId }, select: MESSAGE })) as AnsweringMessage | null
    if (!message) return null
    const answered = own.filter((issue) => answersBrandIssue(issue, message))
    if (answered.length === 0) return null
    // Their batches, on any order of the batch: one customer always (a batch never spans two).
    const partyId = answered[0]!.partyId
    const batches = [...new Set(answered.flatMap((issue) => (issue.batchId ? [issue.batchId] : [])))]
    const mates = batches.length === 0 ? [] : ((await db.productionIssue.findMany({ where: { batchId: { in: batches }, partyId, status: 'OPEN', source: 'BRAND' }, select: ISSUE })) as IssueRow[])
    return { at: message.at, ids: [...new Set([...answered.map((issue) => issue.id), ...mates.map((issue) => issue.id)])] }
  })
  if (!plan) return NOTHING
  const { result } = await command(caller, { name: ISSUE_ANSWERED_HANDLER, input: { eventId, orderId, messageId }, causationId: eventId }, async (tools) => {
    const changed: { issue: IssueRow; to: IssueStatus }[] = []
    for (const issue of await lockedIssues(tools.tx, plan.ids)) {
      if (issue.status !== 'OPEN' || issue.source !== 'BRAND') continue
      if (await moveIssue(tools, issue, 'ANSWERED', plan.at)) changed.push({ issue, to: 'ANSWERED' })
    }
    let tasksClosed = 0
    for (const id of await openTasksOfIssues(tools.tx, changed.map((entry) => entry.issue))) if (await closeTask(tools, id, 'DONE')) tasksClosed++
    for (const { issue } of changed) {
      tools.emit(eventFor(productionIssueAnswered, { subject: issue.id, companyId: issue.companyId, siteId: issue.siteId, payload: { issueId: issue.id, partyId: issue.partyId, source: 'BRAND', salesOrderId: issue.salesOrderId, batchId: issue.batchId, answeredInOrderId: orderId } }))
    }
    if (changed.length > 0) auditPerCustomer(tools, changed, { by: 'message', messageId, answeredInOrderId: orderId })
    else tools.audit({ action: 'production.issuesAnswered', recordType: 'SalesOrder', recordId: orderId, after: { by: 'message', messageId, changed: 0 } })
    return { answered: changed.length, reopened: 0, cancelled: 0, tasksClosed }
  })
  return result
}

/** thread.message_posted: the most frequent event — decided on its payload first, with no read. */
async function onMessage(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<AnsweredOutcome> {
  if (text(event.payload, 'recordType') !== 'SalesOrder' || text(event.payload, 'audience') !== 'PARTNER' || text(event.payload, 'direction') !== 'OUTBOUND') return NOTHING
  const orderId = text(event.payload, 'recordId')
  const messageId = text(event.payload, 'messageId')
  if (!orderId || !messageId || !isUuid(orderId) || !isUuid(messageId)) return NOTHING
  return answerByMessage(caller, event.eventId, orderId, messageId)
}

/** email.status_changed: a windowed mail of a sales order's thread left its window (sent or failed): its message is released now. */
async function onMailLeft(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<AnsweredOutcome> {
  const status = text(event.payload, 'status')
  if ((status !== 'SENT' && status !== 'FAILED') || text(event.payload, 'recordType') !== 'SalesOrder') return NOTHING
  const orderId = text(event.payload, 'recordId')
  const outboundId = text(event.payload, 'outboundId')
  if (!orderId || !outboundId || !isUuid(orderId) || !isUuid(outboundId)) return NOTHING
  const messageId = await caller.withClient(async (db) => {
    // The order's open BRAND issues first (one indexed read), then the mail: only one that waited in its window (a mail without
    // one answered with its thread.message_posted already).
    if ((await db.productionIssue.count({ where: { salesOrderId: orderId, status: 'OPEN', source: 'BRAND' } })) === 0) return null
    const mail = await db.emailOutbound.findUnique({ where: { id: outboundId }, select: { messageId: true, sendAfter: true } })
    return mail?.messageId && mail.sendAfter !== null ? mail.messageId : null
  })
  return messageId ? answerByMessage(caller, event.eventId, orderId, messageId) : NOTHING
}

/** One event's issue changes (the handler's work; tests call it with the system caller). */
export async function issueAnswered(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<AnsweredOutcome> {
  switch (event.type) {
    case 'task.completed':
    case 'task.changed':
      return onTask(caller, event)
    case 'thread.message_posted':
      return onMessage(caller, event)
    case 'email.status_changed':
      return onMailLeft(caller, event)
    default:
      return NOTHING
  }
}

/** The worker's `production.issueAnswered` (background.ts). */
export function issueAnsweredHandler(): EventHandler {
  return defineHandler({
    name: ISSUE_ANSWERED_HANDLER,
    events: ISSUE_ANSWERED_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      await issueAnswered(caller, event)
    },
  })
}
