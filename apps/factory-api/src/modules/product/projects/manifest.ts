import { defineManifest } from '../../../core/manifest'

/**
 * Projects (threads plan TH-5, B-TH-066 … B-TH-072; Products › Development › Projects). Office routes check each project with
 * can() over its company and outside company (`record`): reading is threads.read (as its thread), keeping it projects.manage,
 * adding a colleague threads.post (adding the outside company's portal people projects.manage, checked in the handler). The
 * portal's routes read only the session's own party (row-level security) and the projects the person was added to.
 */
const read = { audiences: ['office'], permission: 'threads.read', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'projects.manage', scope: 'record' } as const
const post = { audiences: ['office'], permission: 'threads.post', scope: 'record' } as const
const portal = { audiences: ['partner'], permission: 'portal.projects.view', scope: 'party' } as const

export const manifest = defineManifest({
  // B-TH-070: the list, the company bands' counts; B-TH-071: Today's My projects; B-TH-066: the New project dialog's warning.
  'GET /projects': read,
  'GET /projects/mine': read,
  'GET /projects/counts': read,
  'GET /projects/similar': manage,
  // B-TH-067: "In project" for any record (its own view permission is checked over it in the handler).
  'GET /projects/of/:recordType/:recordId': read,
  // B-TH-070: the page.
  'GET /projects/:projectId': read,
  // B-TH-066: the record.
  'POST /projects': manage,
  'PATCH /projects/:projectId': manage,
  'POST /projects/:projectId/hold': manage,
  'POST /projects/:projectId/resume': manage,
  'POST /projects/:projectId/close': manage,
  'POST /projects/:projectId/reopen': manage,
  // B-TH-067: linked records.
  'POST /projects/:projectId/links': manage,
  'POST /projects/:projectId/links/bulk': manage,
  'DELETE /projects/:projectId/links/:linkId': manage,
  // B-TH-068: people (the lead removes too: checked in the handler).
  'GET /projects/:projectId/people': read,
  'GET /projects/:projectId/people/choices': post,
  'POST /projects/:projectId/people': post,
  'DELETE /projects/:projectId/people/:userId': post,
  // B-TH-069 / B-TH-072: the portal (members only).
  'GET /portal/projects': portal,
  'GET /portal/projects/:projectId/news': portal,
})
