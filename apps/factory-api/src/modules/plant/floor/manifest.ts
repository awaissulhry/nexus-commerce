import { defineManifest } from '../../../core/manifest'

/**
 * The station's machine screens and the technician's My jobs (B-W2a-35; design floor.machine SCR-179): floor only, at
 * the device's site (`site`). Reporting is plant.report (every floor role: Owner answer H1); My jobs plant.jobs.work
 * (the maintenance technician's floor role).
 */
export const manifest = defineManifest({
  'GET /plant/floor/machines': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
  'GET /plant/floor/machines/:machineId': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
  'GET /plant/floor/jobs': { audiences: ['floor'], permission: 'plant.jobs.work', scope: 'site' },
})
