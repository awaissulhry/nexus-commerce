import { events as portalEvents } from '@nexus/factory-domain/portal/events'
import { isTaskFor } from '@nexus/factory-domain/portal/tasks/rules'
import { taskById } from '../../tasks/store'
import type { PartnerDraft, PartnerRule } from './types'

/**
 * The one task list's news (B-W2b-167; design portal.frame "The same task list feeds Home, the rail badges and the reminder
 * e-mails"):
 *   partner_task.opened     ASSIGNMENT "<Company> asks you: <the request>" to the people the request is for (its kind's
 *                           verb: their role and capabilities), e-mailed by the kind's topic (confirm an order: ORDERS…)
 *   partner_task.reminded   ASSIGNMENT "Reminder: <the request> (by 5 Nov)", e-mailed by the REMINDERS setting
 * Only while the request is still OPEN when the fan-out runs.
 */

const payloadOf = (type: string) => portalEvents.find((event) => event.type === type)!.payload

async function draftsOf(context: Parameters<PartnerRule['drafts']>[0], taskId: string, messageKey: 'portal.task.opened' | 'portal.task.reminded'): Promise<PartnerDraft[]> {
  const task = await taskById(context.tx, taskId)
  if (!task || task.status !== 'OPEN') return []
  return [
    {
      partyId: task.partyId,
      companyId: task.companyId,
      record: { type: task.recordType, id: task.recordId, label: task.recordLabel },
      messageKey,
      params: { kind: task.kind, taskId: task.id, dueAt: task.dueAt ? task.dueAt.toISOString() : null },
      anchor: `task:${task.id}`,
      forReader: (reader) => isTaskFor(reader.actor, task),
    },
  ]
}

export const TASK_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalTasks.opened',
    events: ['partner_task.opened'],
    async drafts(context, raw) {
      const payload = payloadOf('partner_task.opened').parse(raw) as { taskId: string }
      return draftsOf(context, payload.taskId, 'portal.task.opened')
    },
  },
  {
    name: 'portalTasks.reminded',
    events: ['partner_task.reminded'],
    async drafts(context, raw) {
      const payload = payloadOf('partner_task.reminded').parse(raw) as { taskId: string }
      return draftsOf(context, payload.taskId, 'portal.task.reminded')
    },
  },
])
