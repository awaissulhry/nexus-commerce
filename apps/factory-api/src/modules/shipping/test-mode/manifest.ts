import { defineManifest } from '../../../core/manifest'

/**
 * Test carrier mode per site (B-W2b-390; LOG-035): office only. A site belongs to a company, so the handlers filter the
 * list with scopeWhere() and check the site with can() (`record`). Going live also asks a fresh step-up (in the handler).
 * The floor reads its site's test mode in the labels and check reads (shipping.pack).
 */
export const manifest = defineManifest({
  // B-W2b-F49: the settings page's own right (Carriers & shipping asks shipping.settings.view), so the admin who switches a site
  // reads it; the shell's banner reads GET /shell/notices (every office person).
  'GET /shipping/test-mode': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/sites/:siteId/test-mode': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
})
