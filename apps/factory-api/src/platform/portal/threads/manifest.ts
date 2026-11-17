import { defineManifest } from '../../../core/manifest'

/**
 * A record's thread in the portal (B-W2b-168; COL-059, COL-060). A portal session only (a link session reads its own
 * record's shared messages on GET /threads/<type>/<id>); scope party: the session's. Reading needs threads.read (every
 * main partner role), writing the person's "can comment" (portal.comment, COL-062); the handlers check each record with
 * its partner view and can() over its company and the party (platform/threads/partner/service.ts).
 */
export const manifest = defineManifest({
  'GET /portal/threads': { audiences: ['partner'], permission: 'threads.read', scope: 'party' },
  'GET /portal/threads/:recordType/:recordId': { audiences: ['partner'], permission: 'threads.read', scope: 'party' },
  'POST /portal/threads/:recordType/:recordId/messages': { audiences: ['partner'], permission: 'portal.comment', scope: 'party' },
  // B-TH-027: the person's own read mark (whoever reads the conversation).
  'POST /portal/threads/:recordType/:recordId/read': { audiences: ['partner'], permission: 'threads.read', scope: 'party' },
  // ---- B-TH-085: the composer's files — whoever may write here (portal.comment); the handler also asks the upload capability
  // (portal.upload) over the record, the outside-upload gate and the record's partner view.
  'POST /portal/threads/:recordType/:recordId/files': { audiences: ['partner'], permission: 'portal.comment', scope: 'party' },
  'POST /portal/threads/:recordType/:recordId/files/:fileId/complete': { audiences: ['partner'], permission: 'portal.comment', scope: 'party' },
})
