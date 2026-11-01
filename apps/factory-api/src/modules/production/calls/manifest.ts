import { defineManifest } from '../../../core/manifest'

/**
 * Help calls (B-W2b-35; MES-142 … MES-145, MES-147, MES-137; design floor.help SCR-172, production.calls SCR-142,
 * floor.supervisor "Calls", floor.display "Stations", production.settings "Help-call routing"). The station sends and
 * closes its own calls with floor.work (every floor role); responders answer with production.calls.answer (office, and the
 * floor's team leader, technician and inspector at their own site); the office reads with production.calls.view and keeps
 * the types with production.calls.manage. Handlers check each call, type, line and site with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/calls/station': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/calls/station': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/calls/station/:callId/details': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/calls/station/:callId/solve': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/calls/station/:callId/cancel': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /production/calls/board': { audiences: ['office', 'floor'], permission: 'production.calls.view', scope: 'record' },
  'POST /production/calls/:callId/seen': { audiences: ['office', 'floor'], permission: 'production.calls.answer', scope: 'record' },
  'POST /production/calls/:callId/on-the-way': { audiences: ['office', 'floor'], permission: 'production.calls.answer', scope: 'record' },
  'POST /production/calls/:callId/solve': { audiences: ['office', 'floor'], permission: 'production.calls.answer', scope: 'record' },
  'POST /production/calls/:callId/cancel': { audiences: ['office', 'floor'], permission: 'production.calls.answer', scope: 'record' },
  'POST /production/calls/:callId/outcome': { audiences: ['office'], permission: 'production.calls.answer', scope: 'record' },
  'GET /production/calls': { audiences: ['office'], permission: 'production.calls.view', scope: 'record' },
  'GET /production/calls/counts': { audiences: ['office'], permission: 'production.calls.view', scope: 'record' },
  'GET /production/calls/by-hour': { audiences: ['office'], permission: 'production.calls.view', scope: 'record' },
  'GET /production/calls/types': { audiences: ['office'], permission: 'production.calls.view', scope: 'record' },
  'POST /production/calls/types': { audiences: ['office'], permission: 'production.calls.manage', scope: 'record' },
  'PATCH /production/calls/types/:typeId': { audiences: ['office'], permission: 'production.calls.manage', scope: 'record' },
  'GET /production/calls/:callId': { audiences: ['office'], permission: 'production.calls.view', scope: 'record' },
})
