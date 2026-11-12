import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TASK_CHANGES, TASK_KINDS, TASK_STATUSES } from '../inventory/tasks/rules'

/**
 * The events of the warehouse task inbox (B-W2b-292; SCM-274; apps/factory-api modules/inventory/tasks). Context
 * `inventory-tasks`, its own module folder (as inventory-locations, B-W2b-289: the inventory events file is other steps'). It reaches the office's warehouse screens
 * (inventory.stock.view) and the tablets of the task's site (floor.work: "a new quarantine move task → a count on the Move
 * tile"). Never a person: a task for one worker says `forPerson`, never who.
 *
 *   inventory.warehouse_task_changed   once per task made (by its source or by hand), taken, given back, done, cancelled or
 *                                      changed (its place, due time, quantity, note or whom it is for)
 */
export const events = [
  defineEvent({
    type: 'inventory.warehouse_task_changed',
    context: 'inventory-tasks',
    description: 'A warehouse floor task (receive, put away, pick, move, count, a move to quarantine) was made, taken, given back, done, cancelled or changed.',
    payload: z.strictObject({
      taskId: z.uuid(),
      kind: z.enum(TASK_KINDS),
      status: z.enum(TASK_STATUSES),
      change: z.enum(TASK_CHANGES),
      /** The record that made it (its model name and id), or null: asked by hand. */
      sourceType: z.string().nullable(),
      sourceId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      fromLocationId: z.uuid().nullable(),
      toLocationId: z.uuid().nullable(),
      /** For a floor role (its id), for one person (forPerson, never who), or anyone at the site (both null / false). */
      assignedRoleId: z.uuid().nullable(),
      forPerson: z.boolean(),
    }),
    live: { permission: 'inventory.stock.view', floor: 'floor.work', fields: ['taskId', 'kind', 'status', 'change', 'sourceType', 'sourceId', 'toLocationId'] },
  }),
] as const
