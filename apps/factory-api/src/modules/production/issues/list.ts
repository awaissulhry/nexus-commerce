import type { Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, NO_ROWS, scopeWhere, type Actor, type ScopeColumns, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  ESCALATION_STEP_WORDS,
  ISSUE_SOURCE_WORDS,
  ISSUE_STATUS_WORDS,
  ISSUE_TASK_MOVES,
  ISSUE_WORDS,
  officeIssueNote,
  type IssueRecordType,
  type IssueSource,
  type IssueStatus,
  type IssueTaskMove,
} from '@nexus/factory-domain/production-brand/issues'
import type { SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOnThread } from '../../../platform/threads/records'
import { officeContextOf } from '../work-orders/access'
import { issueEscalationTaskId } from './raise'
import { wallOf } from './tasks'

/**
 * B-PR-45 — GET /production/issues?partyId&status&mine (production plan §5 Customer card "open problems", Overview "open issues";
 * L24; R-42; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."). Office only.
 *
 *   who reads   workorders.view (every issue) or orders.view (the issues on a sales order), over the issue's company, site and
 *               customer: a person limited to some customers reads only theirs (scopeWhere over the issue's own columns; the
 *               office's database role is walled by tenant only, so the wall is here); neither permission anywhere: 403; a
 *               customer named that the reader does not reach: 404 "Customer not found." (never says it exists)
 *   what        per issue: its source and status with words, "No reply sent yet" beside a customer's issue whose task was
 *               ticked while no reply went out (factory-domain officeIssueNote), its record and sales order, the customer, when
 *               raised, due and answered, its escalation step, its batch task's state and assignee as Me / Someone else / Not
 *               set (lists never name a person), whether the reader holds its open task (`mine`: the batch's or an
 *               escalation's, ./raise issueEscalationTaskId), its batch, and the words it was raised with — only for a reader
 *               of the record's thread (threads' mayOnThread over the record's WALL scope)
 *   counts      open, no reply yet, escalated, mine — over the customer filter (the Overview tile, the Customer card badge)
 *
 * Reads at most READ_CAP issues of the filter (`more` says when there are more); OPEN oldest first, the rest newest first.
 */

const READ_CAP = 1000
const ISSUE_SCOPE: ScopeColumns = { company: 'companyId', site: { field: 'siteId', nullable: true }, party: 'partyId' }
const LIVE = { events: ['production_issue.raised', 'production_issue.answered', 'production_issue.escalated', 'task.completed', 'task.changed'] }

export interface IssueListQuery {
  readonly partyId?: string | undefined
  readonly status: IssueStatus | 'ALL'
  readonly mine?: boolean | undefined
  readonly limit: number
}

const isNone = (where: WhereClause): boolean => where === NO_ROWS

/** The issues the reader reaches: workorders.view over any, orders.view over the ones on a sales order (null: none at all). */
export function issueReadWhere(actor: Actor): Prisma.ProductionIssueWhereInput | null {
  const production = scopeWhere(actor, WORKORDERS_VIEW, ISSUE_SCOPE)
  const sales = scopeWhere(actor, ORDERS_VIEW, ISSUE_SCOPE)
  const parts: WhereClause[] = []
  if (!isNone(production)) parts.push(production)
  if (!isNone(sales)) parts.push({ AND: [{ recordType: 'SalesOrder' }, sales] })
  if (parts.length === 0) return null
  return (parts.length === 1 ? parts[0]! : { OR: parts }) as unknown as Prisma.ProductionIssueWhereInput
}

/** Whether the reader reaches a customer at all through either permission (the Customer card's filter). */
const reachesCustomer = (actor: Actor, partyId: string): boolean => can(actor, WORKORDERS_VIEW, { partyId }) || can(actor, ORDERS_VIEW, { partyId })

const ISSUE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  recordType: true,
  recordId: true,
  salesOrderId: true,
  taskId: true,
  messageId: true,
  source: true,
  batchId: true,
  status: true,
  raisedAt: true,
  dueDate: true,
  answeredAt: true,
  escalationStep: true,
  escalatedAt: true,
} as const satisfies Prisma.ProductionIssueSelect

const isMove = (value: string): value is IssueTaskMove => (ISSUE_TASK_MOVES as readonly string[]).includes(value)

export async function listIssues(caller: CommandCaller, query: IssueListQuery, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const reach = issueReadWhere(actor)
  if (!reach) throw new ForbiddenError()
  if (query.partyId && !reachesCustomer(actor, query.partyId)) throw new NotFoundError('Customer not found.')
  const me = context.actorId
  return caller.withClient(async (db) => {
    const filter: Prisma.ProductionIssueWhereInput = { AND: [reach, ...(query.partyId ? [{ partyId: query.partyId }] : [])] }
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const rows = await db.productionIssue.findMany({ where: filter, select: ISSUE_SELECT, orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }], take: READ_CAP + 1 })
    const capped = rows.length > READ_CAP
    const issues = rows.slice(0, READ_CAP)

    // Their batch tasks, and the reader's own escalation tasks of them (open).
    const taskIds = [...new Set(issues.map((issue) => issue.taskId))]
    const tasks = new Map((taskIds.length ? await db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true, assigneeId: true } }) : []).map((task) => [task.id, task]))
    const mineIds = taskIds.flatMap((taskId) => [issueEscalationTaskId(taskId, 1, me), issueEscalationTaskId(taskId, 2, me)])
    const myEscalations = new Set((mineIds.length ? await db.task.findMany({ where: { id: { in: mineIds }, status: 'OPEN', assigneeId: me }, select: { id: true } }) : []).map((task) => task.id))
    const isMine = (taskId: string): boolean => {
      const task = tasks.get(taskId)
      return (task?.status === 'OPEN' && task.assigneeId === me) || ([1, 2] as const).some((step) => myEscalations.has(issueEscalationTaskId(taskId, step, me)))
    }
    const noteOf = (issue: (typeof issues)[number]) => {
      const task = tasks.get(issue.taskId)
      return officeIssueNote({ source: issue.source as IssueSource, status: issue.status as IssueStatus }, task && isMove(task.status) ? task.status : null)
    }
    const counts = {
      open: issues.filter((issue) => issue.status === 'OPEN').length,
      noReplyYet: issues.filter((issue) => noteOf(issue) === 'NO_REPLY_YET').length,
      escalated: issues.filter((issue) => issue.status === 'OPEN' && issue.escalationStep > 0).length,
      mine: issues.filter((issue) => issue.status === 'OPEN' && isMine(issue.taskId)).length,
    }

    const wanted = issues.filter((issue) => (query.status === 'ALL' || issue.status === query.status) && (!query.mine || isMine(issue.taskId)))
    if (query.status === 'OPEN') wanted.reverse() // the oldest waiting first
    const shown = wanted.slice(0, query.limit)

    // The names of what is shown: records, sales orders, customers, batches, and the words for readers of the thread.
    const orderIds = [...new Set(shown.flatMap((issue) => [...(issue.recordType === 'SalesOrder' ? [issue.recordId] : []), ...(issue.salesOrderId ? [issue.salesOrderId] : [])]))]
    const workIds = [...new Set(shown.filter((issue) => issue.recordType === 'WorkOrder').map((issue) => issue.recordId))]
    const orderNumbers = new Map((orderIds.length ? await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const workNumbers = new Map((workIds.length ? await db.workOrder.findMany({ where: { id: { in: workIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const partyIds = [...new Set(shown.map((issue) => issue.partyId))]
    const names = new Map((partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, legalName: true, tradeName: true } }) : []).map((row) => [row.id, row.tradeName ?? row.legalName]))
    const batchIds = [...new Set(shown.flatMap((issue) => (issue.batchId ? [issue.batchId] : [])))]
    const batchSizes = new Map<string, number>()
    if (batchIds.length) for (const row of await db.productionIssue.groupBy({ by: ['batchId'], where: { batchId: { in: batchIds } }, _count: { _all: true } })) if (row.batchId) batchSizes.set(row.batchId, row._count._all)
    const readable = shown.filter((issue) => mayOnThread(actor, THREADS_READ, issue.recordType, wallOf(issue)))
    const bodies = new Map((readable.length ? await db.message.findMany({ where: { id: { in: readable.map((issue) => issue.messageId) } }, select: { id: true, bodyText: true } }) : []).map((row) => [row.id, row.bodyText]))
    const readableIds = new Set(readable.map((issue) => issue.id))

    return {
      asOf: toUtcIso(now),
      counts,
      issues: shown.map((issue) => {
        const source = issue.source as IssueSource
        const status = issue.status as IssueStatus
        const note = noteOf(issue)
        const task = tasks.get(issue.taskId)
        const assignee: SupervisorMark = !task?.assigneeId ? 'NOT_SET' : task.assigneeId === me ? 'ME' : 'SOMEONE_ELSE'
        const step = issue.escalationStep === 1 || issue.escalationStep === 2 ? issue.escalationStep : null
        return {
          id: issue.id,
          source,
          sourceWords: ISSUE_SOURCE_WORDS[source],
          status,
          statusWords: ISSUE_STATUS_WORDS[status],
          note,
          noteWords: note ? ISSUE_WORDS.NO_REPLY_YET : null,
          record: { type: issue.recordType as IssueRecordType, id: issue.recordId, label: (issue.recordType === 'SalesOrder' ? orderNumbers.get(issue.recordId) : workNumbers.get(issue.recordId)) ?? '' },
          salesOrder: issue.salesOrderId ? { id: issue.salesOrderId, number: orderNumbers.get(issue.salesOrderId) ?? '' } : null,
          customer: { id: issue.partyId, name: names.get(issue.partyId) ?? '' },
          raisedAt: toUtcIso(issue.raisedAt),
          dueOn: issue.dueDate.toISOString().slice(0, 10),
          answeredAt: issue.answeredAt ? toUtcIso(issue.answeredAt) : null,
          escalation: step && issue.escalatedAt ? { step, at: toUtcIso(issue.escalatedAt), words: ESCALATION_STEP_WORDS[step] } : null,
          task: task ? { id: task.id, status: task.status, assignee } : null,
          mine: issue.status === 'OPEN' && isMine(issue.taskId),
          batch: issue.batchId ? { id: issue.batchId, issues: batchSizes.get(issue.batchId) ?? 1 } : null,
          excerpt: readableIds.has(issue.id) ? excerptOf(bodies.get(issue.messageId) ?? '') : null,
        }
      }),
      more: capped || wanted.length > shown.length,
      live: LIVE,
    }
  })
}
