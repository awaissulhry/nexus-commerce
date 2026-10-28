import { defineManifest, PUBLIC } from '../../core/manifest'

/**
 * The files routes (plan A1 §3.2 step 2, §3.6). Every file belongs to a company (or the whole tenant), so the handlers
 * check each file with can() and filter lists with scopeWhere() (`record`); the audience check (COL-050) and
 * row-level security keep floor, portal and link sessions to what is shared with them. The two `/local-files` routes
 * are the local store's "presigned URLs" (FAKE accounts, local and test only): public, authorised by the signed token
 * in the query string (too long for a path parameter), and 404 everywhere else.
 */
export const manifest = defineManifest({
  'POST /files': { audiences: ['office'], permission: 'files.upload', scope: 'record' },
  'POST /files/:fileId/complete': { audiences: ['office'], permission: 'files.upload', scope: 'record' },
  'GET /files': { audiences: ['office', 'floor', 'partner', 'link'], permission: 'files.read', scope: 'record' },
  'GET /files/:fileId': { audiences: ['office', 'floor', 'partner', 'link'], permission: 'files.read', scope: 'record' },
  'GET /files/:fileId/download': { audiences: ['office', 'floor', 'partner', 'link'], permission: 'files.read', scope: 'record' },
  'PUT /files/:fileId/visibility': { audiences: ['office'], permission: 'files.manage', scope: 'record' },
  'PUT /files/:fileId/retention': { audiences: ['office'], permission: 'files.manage', scope: 'record' },
  'DELETE /files/:fileId': { audiences: ['office'], permission: 'files.delete', scope: 'record' },
  'PUT /local-files': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /local-files': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
