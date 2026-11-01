import { defineManifest } from '../../../core/manifest'

/**
 * Floor rules per site (B-W1-37; A2 SCR-074; MES-278): the office reads and changes them; a site belongs to a company,
 * so the handlers check each site with can() and filter the list with scopeWhere() (`record`). Widening the switch
 * (STATION → WORKER) also asks for a step-up inside the handler; the standard bundle size never does. A floor device
 * reads only its own site's scan subject and bundle size (`site`: the device's), never the legal basis.
 */
export const manifest = defineManifest({
  'GET /production/settings': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'GET /production/settings/:siteId': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'POST /production/settings/:siteId/scan-subject': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'POST /production/settings/:siteId/legal-basis': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'POST /production/settings/:siteId/bundle-size': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'GET /production/settings/:siteId/notice-acks': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'GET /production/floor-rules': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  // B-W2b-53 (MES-294): the floor checks per site; (MES-293) the floor's full reason lists, the whole group's (tenant).
  'GET /production/settings/:siteId/floor-rules': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'POST /production/settings/:siteId/floor-rules': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'GET /production/settings/reasons': { audiences: ['office'], permission: 'reasons.view', scope: 'tenant' },
  'POST /production/settings/reasons/full': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
})
