import { defineManifest } from '../../../core/manifest'

/**
 * Machine requests (B-W2a-35; QHS-178; Owner answer H1; design plant.requests SCR-148, floor.machine SCR-179). A report
 * comes from the station (a floor device, plant.report at its own site: every floor role holds it) or the office; the
 * office reads the queue with plant.view and triages with plant.requests.triage; a technician signs an unsafe machine
 * safe with plant.signSafe (office or floor; a signing act). Handlers check each request with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /plant/requests': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/requests/counts': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/requests/:requestId': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/requests': { audiences: ['office', 'floor'], permission: 'plant.report', scope: 'record' },
  'POST /plant/requests/:requestId/acknowledge': { audiences: ['office'], permission: 'plant.requests.triage', scope: 'record' },
  'POST /plant/requests/:requestId/job': { audiences: ['office'], permission: 'plant.requests.triage', scope: 'record' },
  'POST /plant/requests/:requestId/merge': { audiences: ['office'], permission: 'plant.requests.triage', scope: 'record' },
  'POST /plant/requests/:requestId/close': { audiences: ['office'], permission: 'plant.requests.triage', scope: 'record' },
  'POST /plant/requests/:requestId/sign-safe': { audiences: ['office', 'floor'], permission: 'plant.signSafe', scope: 'record' },
})
