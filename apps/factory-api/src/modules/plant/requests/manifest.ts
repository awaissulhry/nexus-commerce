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
  // B-W2b-96 (QHS-179 … QHS-189): duplicates, locks, merge, progress, the office's lock, photos and voice notes, and a site's
  // plant settings (routing and escalation, the unsafe lock).
  'GET /plant/requests/duplicates': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/requests/locks': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/requests/merge': { audiences: ['office'], permission: 'plant.requests.triage', scope: 'record' },
  'POST /plant/requests/:requestId/on-the-way': { audiences: ['office'], permission: 'plant.jobs.work', scope: 'record' },
  'POST /plant/requests/:requestId/works': { audiences: ['office'], permission: 'plant.report', scope: 'record' },
  'POST /plant/requests/:requestId/lock': { audiences: ['office'], permission: 'plant.report', scope: 'record' },
  'POST /plant/requests/:requestId/files': { audiences: ['office', 'floor'], permission: 'plant.report', scope: 'record' },
  'POST /plant/requests/:requestId/files/:fileId/complete': { audiences: ['office', 'floor'], permission: 'plant.report', scope: 'record' },
  'GET /plant/settings/routing': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/settings/routing/preview': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/settings/routing': { audiences: ['office'], permission: 'plant.settings.manage', scope: 'record' },
  'PATCH /plant/settings/routing/:ruleId': { audiences: ['office'], permission: 'plant.settings.manage', scope: 'record' },
  'POST /plant/settings/routing/:ruleId/remove': { audiences: ['office'], permission: 'plant.settings.manage', scope: 'record' },
  'POST /plant/settings/routing/order': { audiences: ['office'], permission: 'plant.settings.manage', scope: 'record' },
  'GET /plant/settings/lock': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'PUT /plant/settings/lock': { audiences: ['office'], permission: 'plant.settings.manage', scope: 'record' },
})
