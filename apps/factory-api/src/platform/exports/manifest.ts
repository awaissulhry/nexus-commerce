import { defineManifest } from '../../core/manifest'

/**
 * The export of a list (B-W2a-23; PLT-179). Office only, views.export; scope record: the handler asks views.export and
 * the list's own permission over the screen's company, and a person only ever sees and downloads their own exports.
 * The request takes an Idempotency-Key.
 */
export const manifest = defineManifest({
  'POST /exports': { audiences: ['office'], permission: 'views.export', scope: 'record' },
  'GET /exports': { audiences: ['office'], permission: 'views.export', scope: 'record' },
  'GET /exports/:exportId': { audiences: ['office'], permission: 'views.export', scope: 'record' },
  'GET /exports/:exportId/download': { audiences: ['office'], permission: 'views.export', scope: 'record' },
})
