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
  // ---- B-TH-044 (G15): a reply the record's party reads in its portal, with no mail — whoever may write on the record (threads.post).
  'POST /threads/:recordType/:recordId/replies': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'GET /threads/:recordType/:recordId/people': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'PUT /threads/:recordType/:recordId/status': { audiences: ['office'], permission: 'threads.manage', scope: 'record' },
  // B-W2a-20 (COL-011): followers. Reading and my own follow need threads.read over the record; adding a colleague
  // threads.post (as mentioning them does), and they must be able to read it.
  'GET /threads/:recordType/:recordId/followers': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'PUT /threads/:recordType/:recordId/followers/me': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'POST /threads/:recordType/:recordId/followers': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  // ---- B-TH-027 (G10): each person's own read mark. The counts of a page of records for office and portal people (a read in a
  // POST: up to 200 records in the body); marking read or unread the office's here (the portal's: POST /portal/threads/…/read).
  'POST /threads/unread': { audiences: ['office', 'partner'], permission: 'threads.read', scope: 'record' },
  'POST /threads/:recordType/:recordId/read': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'POST /threads/:recordType/:recordId/unread': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  // ---- end B-TH-027
  // ---- B-TH-028: who answers the conversation — whoever may write on it (threads.post over the record).
  'PUT /threads/:recordType/:recordId/owner': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  // ---- B-TH-047: the conversations waiting on us across records (Customer replies, Supplier replies) — office only; each row also
  // asks its record type's own view permission over the record (factory-domain threads/view-gates).
  'GET /threads/waiting': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  // ---- B-TH-076: one summary row for any record (type, label, state, parent) — the office in its scope (threads.read over the
  // record), a portal session through the record type's partner view only.
  'GET /records/:recordType/:recordId/summary': { audiences: ['office', 'partner'], permission: 'threads.read', scope: 'record' },
  // ---- end B-TH-076
  // ---- B-TH-091: pins — read by the office and a portal reader (its own customer's pins only); pinned and unpinned by whoever may
  // write on the record (threads.post); a request's note moved into a pinned office note (threads.post, and the handler asks
  // sales.inquiries.manage over the request).
  'GET /threads/:recordType/:recordId/pins': { audiences: ['office', 'partner'], permission: 'threads.read', scope: 'record' },
  'PUT /threads/:recordType/:recordId/pins/:messageId': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'DELETE /threads/:recordType/:recordId/pins/:messageId': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'POST /threads/Inquiry/:recordId/pins/note': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  // ---- end B-TH-091
  // ---- B-TH-092: the person's own draft of a record they may write on (threads.post over it), and their drafts (the lists' "Draft").
  'GET /threads/drafts': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'GET /threads/:recordType/:recordId/draft': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'PUT /threads/:recordType/:recordId/draft': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'DELETE /threads/:recordType/:recordId/draft': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  // ---- end B-TH-092
  // ---- B-TH-093: Done — whoever may write on the conversation marks it done or opens it again (office only).
  'PUT /threads/:recordType/:recordId/done': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  // ---- end B-TH-093
})
