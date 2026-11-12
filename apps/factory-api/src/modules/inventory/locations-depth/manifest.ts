import { defineManifest } from '../../../core/manifest'

/**
 * Locations in depth (B-W2b-289; SCM-177, SCM-178, SCM-179, SCM-181): the location types, bin labels, blocks and default
 * locations. A location belongs to a site and its company, so every handler checks the place (or site) with can() and
 * filters lists with scopeWhere() (`record`). A floor device reads its own site's types, places, blocks and defaults (a
 * scanned label names its place); only the office changes them. Printing also needs print.labels at the printer's site
 * (platform/print's queue checks it).
 */
export const manifest = defineManifest({
  'GET /inventory/locations/kinds': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'tenant' },
  'GET /inventory/locations/blocked': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'POST /inventory/locations/:locationId/block': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'POST /inventory/locations/:locationId/unblock': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'PUT /inventory/locations/:locationId/label-code': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'GET /inventory/locations/:locationId/label': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'POST /inventory/locations/labels/print': { audiences: ['office', 'floor'], permission: 'print.labels', scope: 'record' },
  'POST /inventory/locations/labels/pdf': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'GET /inventory/locations/scan': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'GET /inventory/locations/defaults': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
  'PUT /inventory/locations/defaults': { audiences: ['office'], permission: 'inventory.locations.manage', scope: 'record' },
  'GET /inventory/locations/defaults/resolve': { audiences: ['office', 'floor'], permission: 'inventory.locations.view', scope: 'record' },
})
