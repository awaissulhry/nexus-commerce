import { defineManifest } from '../../../core/manifest'

/**
 * The one task list for partners (B-W2b-167, COL-043). Portal routes: the session's party (row-level security), the person's
 * tasks by their role (portal.home.view; each kind's verb needs its capability, checked in the handler). Office routes: each
 * request is checked with can() against its company and party (scope record).
 */
export const manifest = defineManifest({
  'GET /portal/tasks': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'POST /portal/tasks/:taskId/done': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'POST /portal/tasks/:taskId/undo': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'GET /portal/tasks/handover/:userId': { audiences: ['partner'], permission: 'portal.colleagues.manage', scope: 'party' },
  'GET /partners/:partyId/tasks': { audiences: ['office'], permission: 'partners.view', scope: 'record' },
  'POST /partners/:partyId/tasks': { audiences: ['office'], permission: 'partners.tasks.manage', scope: 'record' },
  'POST /partner-tasks/:taskId/cancel': { audiences: ['office'], permission: 'partners.tasks.manage', scope: 'record' },
  'POST /partner-tasks/:taskId/reopen': { audiences: ['office'], permission: 'partners.tasks.manage', scope: 'record' },
  'PATCH /partner-tasks/:taskId': { audiences: ['office'], permission: 'partners.tasks.manage', scope: 'record' },
})
