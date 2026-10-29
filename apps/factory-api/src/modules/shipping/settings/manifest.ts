import { defineManifest } from '../../../core/manifest'

/**
 * Shipping settings per site (LOG-117; A2 SCR-068): office only. A site belongs to a company, so the handlers check
 * each site with can() and filter the list with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/settings': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'GET /shipping/settings/:siteId': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/settings/:siteId': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
})
