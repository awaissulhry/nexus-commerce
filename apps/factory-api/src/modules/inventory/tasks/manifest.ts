import { defineManifest } from '../../../core/manifest'

/**
 * The warehouse task inbox (B-W2b-292; SCM-274). The tablet's inbox and its steps are the floor's (floor.work at the device's
 * site; doing a task also needs its act's permission, checked by the handler: factory-domain inventory/tasks TASK_ACTS); the
 * office reads a site's tasks with inventory.stock.view and makes, changes and cancels them with inventory.tasks.manage. Every
 * write needs an Idempotency-Key from a tablet.
 */
export const manifest = defineManifest({
  'GET /inventory/tasks/inbox': { audiences: ['floor'], permission: 'floor.work', scope: 'record' },
  'POST /inventory/tasks/:taskId/take': { audiences: ['floor'], permission: 'floor.work', scope: 'record' },
  'POST /inventory/tasks/:taskId/give-back': { audiences: ['floor'], permission: 'floor.work', scope: 'record' },
  'POST /inventory/tasks/:taskId/done': { audiences: ['floor'], permission: 'floor.work', scope: 'record' },
  'GET /inventory/tasks': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/tasks/:taskId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/tasks': { audiences: ['office'], permission: 'inventory.tasks.manage', scope: 'record' },
  'PATCH /inventory/tasks/:taskId': { audiences: ['office'], permission: 'inventory.tasks.manage', scope: 'record' },
  'POST /inventory/tasks/:taskId/cancel': { audiences: ['office'], permission: 'inventory.tasks.manage', scope: 'record' },
})
