import { defineManifest } from '../../../core/manifest'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021): read from the site's current published version of the plan.
 * The office reads a line's, work centre's or station's list with workorders.view, checked on the lane's site with can()
 * (`record`); a floor device reads its own station's with floor.work, at its own site (`site`; row-level security shows
 * the floor only PUBLISHED plans, Owner answer P3).
 */
export const manifest = defineManifest({
  'GET /production/dispatch': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/dispatch/station': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
