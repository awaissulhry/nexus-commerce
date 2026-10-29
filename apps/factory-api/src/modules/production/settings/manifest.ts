import { defineManifest } from '../../../core/manifest'

/**
 * Floor rules per site (B-W1-37; A2 SCR-074; MES-278): the office reads and changes them; a site belongs to a company,
 * so the handlers check each site with can() and filter the list with scopeWhere() (`record`). Widening the switch
 * (STATION → WORKER) also asks for a step-up inside the handler. A floor device reads only its own site's scan subject
 * (`site`: the device's), never the legal basis.
 */
export const manifest = defineManifest({
  'GET /production/settings': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'GET /production/settings/:siteId': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'POST /production/settings/:siteId/scan-subject': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'POST /production/settings/:siteId/legal-basis': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  'GET /production/settings/:siteId/notice-acks': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'GET /production/floor-rules': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
