import { defineManifest } from '../../core/manifest'

/**
 * Tasks on any record (B-W2a-20; COL-037; design home.tasks, shell.panels "Tasks on this record"). Office only. Reading
 * is reaching Home (home.view): each task is filtered by the person (made by them, theirs, or on a record whose thread
 * they read: `record`). Changing needs tasks.manage, and on a record they did not make the task on, threads.post there.
 */
export const manifest = defineManifest({
  'GET /tasks': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /tasks/:id': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2a-40: who may be given a task (on a record, or of its own): only someone who makes or changes tasks asks.
  'GET /tasks/assignees': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/bulk': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'PUT /tasks/:id': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/assign': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/status': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  'POST /tasks/:id/snooze': { audiences: ['office'], permission: 'tasks.manage', scope: 'record' },
  // B-W2b-388 (COL-041): my own reminders (home.view; reminders/reminders.ts reads and changes only the person's rows, and
  // setting one needs the record's thread readable).
  'GET /reminders': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /reminders': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /reminders/bulk': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /reminders/:id/put-off': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /reminders/:id/done': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /reminders/:id/undo': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'DELETE /reminders/:id': { audiences: ['office'], permission: 'home.view', scope: 'record' },
})
