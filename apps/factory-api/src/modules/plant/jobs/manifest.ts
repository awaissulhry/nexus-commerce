import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Maintenance jobs (B-W2a-35; QHS-184; design plant.jobs SCR-149, floor.machine "My jobs"). The office reads them with
 * plant.view and plans, assigns, closes and cancels them with plant.jobs.manage; a technician (office or floor,
 * plant.jobs.work) reads its job and starts, pauses, hands back and takes back the work. Handlers check each job with
 * can() (`record`); a floor device only at its own site. The record is read by either (SIGNED_IN; the handler asks
 * plant.view in the office, plant.jobs.work on the floor: 404 otherwise).
 */
export const manifest = defineManifest({
  'GET /plant/jobs': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/jobs/counts': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/jobs/:jobId': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'POST /plant/jobs': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'PATCH /plant/jobs/:jobId': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/jobs/assign': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/jobs/:jobId/plan': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/jobs/:jobId/close': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/jobs/:jobId/cancel': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/jobs/:jobId/start': { audiences: ['office', 'floor'], permission: 'plant.jobs.work', scope: 'record' },
  'POST /plant/jobs/:jobId/wait': { audiences: ['office', 'floor'], permission: 'plant.jobs.work', scope: 'record' },
  'POST /plant/jobs/:jobId/hand-back': { audiences: ['office', 'floor'], permission: 'plant.jobs.work', scope: 'record' },
  'POST /plant/jobs/:jobId/reopen': { audiences: ['office', 'floor'], permission: 'plant.jobs.work', scope: 'record' },
})
