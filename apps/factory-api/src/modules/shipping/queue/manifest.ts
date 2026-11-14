import { defineManifest } from '../../../core/manifest'

/**
 * The shipment queue (B-W2b-386; LOG-018, LOG-110, LOG-120): office only. The queues and the search read the shipments of
 * the companies, sites and parties the reader's grants reach (`record`: can() per row, scopeWhere() for lists); a site's
 * cut-offs are its shipping settings.
 */
export const manifest = defineManifest({
  'GET /shipping/queue/today': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/queue/at-risk': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/queue/search': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/sites/:siteId/cut-offs': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/sites/:siteId/cut-offs': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
})
