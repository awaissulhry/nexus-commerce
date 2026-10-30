import { defineManifest } from '../../../core/manifest'

/**
 * The plant screens' pickers in the Office (B-W2a-53; design plant.machines New machine and the station / work centre
 * cells, plant.requests Make a job, plant.jobs New job · Assign jobs · the assignee cell). Reads only. The places need
 * plant.view (each site checked with can()); who may be given a job needs plant.jobs.manage at the site.
 */
export const manifest = defineManifest({
  'GET /plant/places': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/technicians': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
})
