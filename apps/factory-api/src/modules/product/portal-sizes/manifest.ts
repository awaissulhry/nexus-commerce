import { defineManifest } from '../../../core/manifest'

/**
 * owb-pd4s s.3: the customer's product Sizes in its portal catalogue (portal.catalogue.view, the session's party), only for a style
 * its catalogue offers today — exactly the reach of GET /portal/catalogue/:styleId (modules/sales/portal-ordering readCatalogue:
 * any other is the same 404 as a style that does not exist).
 */
export const manifest = defineManifest({
  'GET /portal/catalogue/:styleId/sizes': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
})
