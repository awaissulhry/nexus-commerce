import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TASK_STATUSES } from './rules'

/**
 * The tasks' events (B-W2a-20; COL-037; design home.tasks live "task.assigned / task.completed / task.changed → '1 update
 * · Show'", home.today live "task.assigned / task.completed … → Needs me"). apps/factory-api platform/tasks emits them in
 * the command that changes the task. Each names the task and its record only (no title, no person but the assignee's id
 * for the notification centre): every office screen that may see Today in the task's company reads its list again.
 *
 *   task.created     a task was made (on a record or of its own)
 *   task.assigned    a task was given to a person, or taken back (assigneeId null): the notification centre tells them
 *   task.completed   a task was marked done
 *   task.changed     a task's title, description, due day, checklist, status (reopened, cancelled) or snooze changed
 */

const about = {
  taskId: z.uuid(),
  recordType: z.string().nullable(),
  recordId: z.uuid().nullable(),
}
const live = { permission: 'home.view', fields: ['taskId', 'recordType', 'recordId'] } as const

export const events = [
  defineEvent({
    type: 'task.created',
    context: 'tasks',
    description: 'A task was made, on a record or of its own.',
    payload: z.strictObject({ ...about, assigneeId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'task.assigned',
    context: 'tasks',
    description: 'A task was given to a person (who should be told), or taken back.',
    payload: z.strictObject({ ...about, assigneeId: z.uuid().nullable(), assignedById: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'task.completed',
    context: 'tasks',
    description: 'A task was marked done.',
    payload: z.strictObject(about),
    live,
  }),
  defineEvent({
    type: 'task.changed',
    context: 'tasks',
    description: "A task's words, due day, checklist, status or snooze changed.",
    payload: z.strictObject({ ...about, status: z.enum(TASK_STATUSES), fields: z.array(z.string()) }),
    live,
  }),
] as const
