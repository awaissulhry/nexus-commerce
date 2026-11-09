import { defineManifest } from '../../core/manifest'

/**
 * Inviting a partner to one record (B-W2b-200; COL-061, COL-062). Office routes check each record with can()
 * (partners.shares.* AND the record's own permission, ./records.ts); the link routes serve the RECORD_INVITE link's own
 * record, and only while its share lives (checked on every request by platform/links, and again in each handler).
 */
export const manifest = defineManifest({
  'GET /shares': { audiences: ['office'], permission: 'partners.shares.view', scope: 'record' },
  'POST /shares': { audiences: ['office'], permission: 'partners.shares.manage', scope: 'record' },
  'PUT /shares/:shareId/permissions': { audiences: ['office'], permission: 'partners.shares.manage', scope: 'record' },
  'POST /shares/:shareId/revoke': { audiences: ['office'], permission: 'partners.shares.manage', scope: 'record' },
  'GET /link/share': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'GET /link/share/messages': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/share/messages': { audiences: ['link'], permission: 'links.post', scope: 'record' },
  'PUT /link/share/notify': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/share/files': { audiences: ['link'], permission: 'links.upload', scope: 'record' },
  'POST /link/share/files/:fileId/complete': { audiences: ['link'], permission: 'links.upload', scope: 'record' },
})
