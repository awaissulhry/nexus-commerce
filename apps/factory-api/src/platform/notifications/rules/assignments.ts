import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as insightsEvents } from '@nexus/factory-domain/insights/events'
import { isAttentionKind, KIND_RULES } from '@nexus/factory-domain/insights/attention'
import { holds } from '@nexus/factory-domain/core/permissions'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * Something given to a person (the assignee notice, W1 leftover "attention.assigned waits for notifications"):
 *   attention.assigned   ASSIGNMENT to the person a row of Today was assigned to (not when they took it themselves)
 *   task.assigned        ASSIGNMENT to the person a task was given to (not when they gave it to themselves)
 * Each re-checks that the person still reaches Home (home.view: the bell).
 */

const payloadOf = (list: readonly { readonly type: string; readonly payload: { parse(value: unknown): unknown } }[], type: string) => list.find((event) => event.type === type)!.payload

export const ASSIGNMENT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'insights.assigned',
    events: ['attention.assigned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(insightsEvents, 'attention.assigned').parse(raw) as unknown as { actionId: string; key: string; kind: string; recordType: string; recordId: string; assigneeId: string | null }
      if (payload.assigneeId === null) return []
      const reader = await context.reader(payload.assigneeId)
      if (!reader || !holds(reader.actor, HOME_VIEW)) return []
      const action = await context.tx.attentionAction.findUnique({ where: { id: payload.actionId }, select: { companyId: true, assignedToId: true, assignedById: true } })
      // Taken back or given to someone else meanwhile: nothing to tell.
      if (!action || action.assignedToId !== payload.assigneeId) return []
      const log = await context.tx.attentionActionLog.findFirst({ where: { actionId: payload.actionId, verb: 'ASSIGNED', assigneeId: payload.assigneeId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { recordLabel: true } })
      const kindLabel = isAttentionKind(payload.kind) ? KIND_RULES[payload.kind].label : payload.kind
      return [
        {
          userId: payload.assigneeId,
          category: 'ASSIGNMENT',
          record: { type: payload.recordType, id: payload.recordId, label: log?.recordLabel ?? payload.recordType },
          companyId: action.companyId,
          anchor: `today:${payload.key}`,
          messageKey: 'notifications.assigned.today',
          params: { actorId: action.assignedById, kind: payload.kind, kindLabel, key: payload.key },
          actorId: action.assignedById,
        },
      ]
    },
  },
  {
    name: 'tasks.assigned',
    events: ['task.assigned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(taskEvents, 'task.assigned').parse(raw) as unknown as { taskId: string; assigneeId: string | null; assignedById: string | null }
      if (payload.assigneeId === null) return []
      const reader = await context.reader(payload.assigneeId)
      if (!reader || !holds(reader.actor, HOME_VIEW)) return []
      const task = await context.tx.task.findUnique({ where: { id: payload.taskId }, select: { id: true, title: true, companyId: true, recordType: true, recordId: true, recordLabel: true, assigneeId: true, status: true } })
      if (!task || task.assigneeId !== payload.assigneeId || task.status !== 'OPEN') return []
      const onRecord = task.recordType !== null && task.recordId !== null
      return [
        {
          userId: payload.assigneeId,
          category: 'ASSIGNMENT',
          record: onRecord ? { type: task.recordType!, id: task.recordId!, label: task.recordLabel ?? task.recordType! } : { type: 'Task', id: task.id, label: task.title },
          companyId: task.companyId,
          anchor: `task:${task.id}`,
          messageKey: 'notifications.assigned.task',
          params: { actorId: payload.assignedById, title: task.title, taskId: task.id },
          actorId: payload.assignedById,
        },
      ]
    },
  },
])
