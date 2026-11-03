import { defineManifest } from '../../../core/manifest'

/**
 * Incidents, near misses and hazards (B-W2b-125; QHS-265, QHS-268, QHS-270; design plant.incidents, floor.incident). Office:
 * safety.incidents.view reads anonymised, .report reports, .manage keeps, .people sees and keeps the protected people and INAIL
 * filings (each view recorded); handlers check each incident with can() against its company and site (`record`). Floor: any
 * signed-in worker at the station (floor.work, at the tablet's own site), as a help call.
 */
export const manifest = defineManifest({
  'GET /safety/incidents': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'GET /safety/incidents/counts': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'GET /safety/incidents/rules': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'GET /safety/incidents/:incidentId': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'POST /safety/incidents': { audiences: ['office'], permission: 'safety.incidents.report', scope: 'record' },
  'PATCH /safety/incidents/:incidentId': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/seen': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/close': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/reopen': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/cancel': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/photos': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'POST /safety/incidents/:incidentId/photos/:fileId/complete': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'GET /safety/incidents/:incidentId/photos/:fileId/download': { audiences: ['office'], permission: 'safety.incidents.view', scope: 'record' },
  'POST /safety/incidents/:incidentId/actions': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/actions/:actionId/make': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'PATCH /safety/incidents/:incidentId/actions/:actionId': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/actions/:actionId/done': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/actions/:actionId/cancel': { audiences: ['office'], permission: 'safety.incidents.manage', scope: 'record' },
  'POST /safety/incidents/:incidentId/people/open': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/people': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/people': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'PATCH /safety/incidents/:incidentId/people/:personId': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/people/:personId/remove': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/open': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'PATCH /safety/incidents/:incidentId/filings/:filingId': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/file': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/not-needed': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/needed': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/receipt': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/receipt/:fileId/complete': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'POST /safety/incidents/:incidentId/filings/:filingId/receipt/:fileId/open': { audiences: ['office'], permission: 'safety.incidents.people', scope: 'record' },
  'GET /safety/floor/incidents/start': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /safety/floor/incidents': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /safety/floor/incidents/:incidentId': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /safety/floor/incidents/:incidentId/photos': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /safety/floor/incidents/:incidentId/photos/:fileId/complete': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
