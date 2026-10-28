import { defineManifest } from '../../core/manifest'

/**
 * The link routes (plan A1 §3.2 step 2, §3.10 "Links"). Office: each link belongs to a company and a party, so the
 * handlers check them with can() (writes) or scopeWhere() (the list). Link sessions: the open is scoped to the
 * session's party; a module's answer routes (W1) add their own entries with the link audience.
 */
export const manifest = defineManifest({
  'GET /links': { audiences: ['office'], permission: 'links.view', scope: 'record' },
  'POST /links': { audiences: ['office'], permission: 'links.manage', scope: 'record' },
  'POST /links/:linkId/revoke': { audiences: ['office'], permission: 'links.manage', scope: 'record' },
  'POST /link/open': { audiences: ['link'], permission: 'links.open', scope: 'party' },
})
