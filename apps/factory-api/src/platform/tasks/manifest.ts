import { defineManifest } from '../../core/manifest'

/**
 * Tasks on any record (B-W2a-20; COL-037; design home.tasks, shell.panels "Tasks on this record"). Office only. Reading
 * is reaching Home (home.view): each task is filtered by the person (made by them, theirs, or on a record whose thread
 * they read: `record`). Changing needs tasks.manage, and on a record they did not make the task on, threads.post there.
 */
export const manifest = defineManifest({
  'GET /tasks': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /tasks/:id': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /tasks': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/bulk': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'PUT /tasks/:id': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/assign': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/status': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/snooze': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
})
