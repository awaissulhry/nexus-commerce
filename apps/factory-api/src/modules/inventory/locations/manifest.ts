import { defineManifest } from '../../../core/manifest'

/**
 * The locations' routes (SCM-176; A2 SCR-065). A location belongs to a site and its company, so the handlers check each
 * one with can() and filter the trees with scopeWhere() (`record`). A floor device reads its own site's locations
 * (bin codes to scan); only the office changes them.
 */
export const manifest = defineManifest({
  'GET /inventory/locations': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'POST /inventory/locations': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'PATCH /inventory/locations/:locationId': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'POST /inventory/locations/:locationId/move': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'POST /inventory/locations/:locationId/archive': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
})
