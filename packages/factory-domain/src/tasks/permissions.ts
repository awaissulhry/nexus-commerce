import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Tasks on any record (apps/factory-api platform/tasks; B-W2a-20; COL-037; design home.tasks, shell.panels popup task-new,
 * home.today "task → Done · Snooze"). Reading needs no permission of its own: a person reads the tasks they made or that
 * are theirs (home.view reaches My tasks), and the tasks of a record whose thread they may read (threads.read over its
 * company, site and party). Changing them is this one permission, and on a record also threads.post there (a task is
 * collaboration on the record, as a note is). A task is assigned only to an active person who holds it too.
 *
 *   manage   make a task (on a record or of one's own), change its title, description, due date and checklist, assign
 *            it, mark it done, reopen, cancel and snooze it
 */
export const TASKS_DEFINITIONS = definePermissions('tasks', {
  manage: {
    risk: 'write',
    description:
      'Make tasks and reminders, on a record you may write notes on or of your own; change them, assign them to a colleague who can see the record, mark them done, reopen, cancel and snooze them.',
  },
})

export const TASKS_MANAGE = 'tasks.manage' satisfies Permission

export const TASKS_PERMISSIONS: readonly Permission[] = Object.freeze([TASKS_MANAGE])
