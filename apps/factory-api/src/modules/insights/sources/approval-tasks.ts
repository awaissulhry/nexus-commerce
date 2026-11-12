import { APPROVALS_VIEW } from '@nexus/factory-domain/approvals/permissions'
import { events as approvalEvents } from '@nexus/factory-domain/approvals/events'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { approvalTaskWords } from '@nexus/factory-domain/insights/words'
import { kindOf } from '../../../platform/approvals/kinds'
import { approverRolesOf, askersOfTask, decidersOf, waitingFor, type Reader } from '../../../platform/approvals/store'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { capped, CHECK_LIMIT, SOURCE_LIMIT, type Source } from './common'

/**
 * The approval engine's requests that wait for the viewer's yes (B-W2b-307; B-W2b-282's gap "no Today/bell row"; design
 * home.approvals "Today and the bell show the same rows", home.today "Approvals"). A PENDING ApprovalTask addressed to the
 * viewer — by name, or to a role they hold over its company and site, with approvals.decide there — that they did not ask
 * or write (platform/approvals store `waitingFor`: the inbox's WAITING_FOR_ME tile, the same rule). Its record is the
 * request itself (`ApprovalTask`): Today's review link and the bell open Home › Approvals' review (`?open=<id>`), where the
 * change, its re-check and the signature its rule asks are shown. Past its time (dueAt) it is urgent. Oldest first.
 *
 * Who asked is never told about their own request; its deciders are (`APPROVAL_TASK_NOTICES`, one line in
 * platform/notifications/rules): approval.requested → each person who may decide it and reaches Home (APPROVAL), and
 * approval.decided → the person who asked (APPROVAL, with the yes or the no), never the decider.
 */

export const approvalTask: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const roles = await approverRolesOf(db, viewer.personId, viewer.now)
    const found = await db.approvalTask.findMany({
      where: waitingFor(viewer.actor, viewer.personId, roles),
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, kind: true, recordType: true, recordId: true, companyId: true, siteId: true, summary: true, requestedAt: true, dueAt: true, requestedById: true, createdById: true, requestedByWorkerId: true },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = []
    for (const [index, row] of rows.entries()) {
      candidates.push({
        kind: 'APPROVAL_TASK',
        // The engine's kind of request (PURCHASE_ORDER, PRICE_CHANGE …): the inbox groups and bulk-approves by it.
        state: row.kind,
        severity: row.dueAt !== null && row.dueAt < viewer.now ? 'HIGH' : 'MEDIUM',
        record: { type: 'ApprovalTask', id: row.id, label: index < CHECK_LIMIT ? await subjectLabel(db, row) : row.recordType },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
        ...approvalTaskWords({ kind: row.kind, summary: row.summary }),
        due: row.dueAt === null ? null : businessDate(row.dueAt),
        since: row.requestedAt,
        notBy: await askersOfTask(db, row),
      })
    }
    return { kind: 'APPROVAL_TASK', candidates, complete }
  })

/** The request's subject in words ("SEED-PO-0002 · Conceria Seed"), read by its kind; its model name when the kind cannot. */
async function subjectLabel(db: Reader, task: { readonly kind: string; readonly recordType: string; readonly recordId: string }): Promise<string> {
  const kind = kindOf(task.kind)
  const subject = kind ? await kind.read(db, task.recordId).catch(() => null) : null
  return subject?.label ?? task.recordType
}

const payloadOf = (type: string) => approvalEvents.find((event) => event.type === type)!.payload

interface Requested {
  readonly taskId: string
}

async function taskOf(context: RuleContext, taskId: string) {
  return context.tx.approvalTask.findUnique({
    where: { id: taskId },
    select: { id: true, kind: true, recordType: true, recordId: true, companyId: true, siteId: true, summary: true, status: true, approverRoleId: true, approverUserId: true, requestedById: true, createdById: true, requestedByWorkerId: true, decidedById: true },
  })
}

export const APPROVAL_TASK_NOTICES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'insights.approvalTaskAsked',
    events: ['approval.requested'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('approval.requested').parse(raw) as unknown as Requested
      const task = await taskOf(context, payload.taskId)
      if (!task || task.status !== 'PENDING') return []
      const askers = await askersOfTask(context.tx, task)
      const deciders = await decidersOf(context.tx, context.tenantId, task, task, askers, context.now)
      const label = await subjectLabel(context.tx, task)
      const drafts: Draft[] = []
      for (const decider of deciders) {
        const reader = await context.reader(decider.id)
        if (!reader || !holds(reader.actor, HOME_VIEW)) continue
        drafts.push({
          userId: decider.id,
          category: 'APPROVAL',
          record: { type: 'ApprovalTask', id: task.id, label },
          companyId: task.companyId,
          anchor: `approval:${task.id}`,
          messageKey: 'notifications.approval.taskAsked',
          params: { actorId: task.requestedById, title: task.summary, kind: task.kind, taskId: task.id },
          actorId: task.requestedById,
        })
      }
      return drafts
    },
  },
  {
    name: 'insights.approvalTaskDecided',
    events: ['approval.decided'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('approval.decided').parse(raw) as unknown as { taskId: string; status: 'APPROVED' | 'REJECTED'; decidedById: string }
      const task = await taskOf(context, payload.taskId)
      const asker = task?.requestedById ?? null
      if (!task || asker === null || asker === payload.decidedById) return []
      const reader = await context.reader(asker)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, APPROVALS_VIEW, { companyId: task.companyId, ...(task.siteId ? { siteId: task.siteId } : {}) })) return []
      return [
        {
          userId: asker,
          category: 'APPROVAL',
          record: { type: 'ApprovalTask', id: task.id, label: await subjectLabel(context.tx, task) },
          companyId: task.companyId,
          anchor: `approval:${task.id}`,
          messageKey: 'notifications.approval.taskDecided',
          params: { actorId: payload.decidedById, status: payload.status, title: task.summary, kind: task.kind, taskId: task.id },
          actorId: payload.decidedById,
        },
      ]
    },
  },
])
