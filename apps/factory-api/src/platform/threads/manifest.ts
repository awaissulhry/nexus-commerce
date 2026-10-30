import { defineManifest } from '../../core/manifest'

/**
 * The record threads' routes (plan A1 §3.2 step 2, §3.7). A thread belongs to its record's company, site and party, so
 * the handlers check each one with can() (`record`). Portal and link sessions read only the messages shared with their
 * party (a link: of its own record); the timeline, notes and the thread's status are office only. The floor has no
 * thread route.
 */
export const manifest = defineManifest({
  'GET /threads/:recordType/:recordId': { audiences: ['office', 'partner', 'link'], permission: 'threads.read', scope: 'record' },
  'GET /threads/:recordType/:recordId/timeline': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'POST /threads/:recordType/:recordId/notes': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'GET /threads/:recordType/:recordId/people': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'PUT /threads/:recordType/:recordId/status': { audiences: ['office'], permission: 'threads.manage', scope: 'record' },
  // B-W2a-20 (COL-011): followers. Reading and my own follow need threads.read over the record; adding a colleague
  // threads.post (as mentioning them does), and they must be able to read it.
  'GET /threads/:recordType/:recordId/followers': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'PUT /threads/:recordType/:recordId/followers/me': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'POST /threads/:recordType/:recordId/followers': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
})
