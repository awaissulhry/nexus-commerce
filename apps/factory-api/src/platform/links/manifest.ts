import { defineManifest, PUBLIC } from '../../core/manifest'

/**
 * The link routes (plan A1 §3.2 step 2, §3.10 "Links"). Office: each link belongs to a company and a party, so the
 * handlers check them with can() (writes) or scopeWhere() (the list). Link sessions: the open is scoped to the
 * session's party; a module's answer routes (W1) add their own entries with the link audience. W2b-3 (B-W2b-163): the
 * office's set of files; the link session's files, password, download, preview, receipt and draft; the public "Ask for
 * a new link" (the token in the header; one answer; the abuse guard).
 */
export const manifest = defineManifest({
  'GET /links': { audiences: ['office'], permission: 'links.view', scope: 'record' },
  'POST /links': { audiences: ['office'], permission: 'links.manage', scope: 'record' },
  'POST /links/:linkId/revoke': { audiences: ['office'], permission: 'links.manage', scope: 'record' },
  'POST /link/open': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  // B-W2b-163.
  'POST /links/files': { audiences: ['office'], permission: 'links.manage', scope: 'record' },
  'GET /link/files': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  'POST /link/password': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  'POST /link/files/:fileId/download': { audiences: ['link'], permission: 'links.download', scope: 'party' },
  'GET /link/files/:fileId/preview': { audiences: ['link'], permission: 'links.download', scope: 'party' },
  'POST /link/files/received': { audiences: ['link'], permission: 'links.receive', scope: 'party' },
  'GET /link/draft': { audiences: ['link'], permission: 'links.submit', scope: 'party' },
  'PUT /link/draft': { audiences: ['link'], permission: 'links.submit', scope: 'party' },
  'POST /link/renew': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
