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
  // B-W2b-96 (QHS-179, QHS-180, QHS-189): the station's requests under way and one of them, the technician's queue, the
  // progress steps, the line lead's confirmation (floor.lead), the floor's look at a photo or voice note.
  'GET /plant/floor/requests': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
  'GET /plant/floor/requests/:requestId': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
  'GET /plant/floor/queue': { audiences: ['floor'], permission: 'plant.jobs.work', scope: 'site' },
  'POST /plant/floor/requests/:requestId/acknowledge': { audiences: ['floor'], permission: 'plant.jobs.work', scope: 'site' },
  'POST /plant/floor/requests/:requestId/on-the-way': { audiences: ['floor'], permission: 'plant.jobs.work', scope: 'site' },
  'POST /plant/floor/requests/:requestId/works': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
  'POST /plant/floor/jobs/:jobId/confirm': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'GET /plant/floor/files/:fileId/download': { audiences: ['floor'], permission: 'plant.report', scope: 'site' },
})
