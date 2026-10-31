import { defineManifest } from '../../../core/manifest'

/**
 * Quality holds (B-W2a-26; QHS-074, MES-008; design quality.holds SCR-078, production.workorders wo-hold): the office
 * only (the floor refuses held work through the scans, issue and packing hooks, ./checks.ts). Handlers check each hold
 * with can() over its company and site (`record`): warehouse and supervisors read, a supervisor or quality places, only
 * quality releases (and with the office's step-up).
 */
export const manifest = defineManifest({
  'GET /quality/holds': { audiences: ['office'], permission: 'quality.holds.view', scope: 'record' },
  'GET /quality/holds/counts': { audiences: ['office'], permission: 'quality.holds.view', scope: 'record' },
  // B-W2a-67: the owner picker (who sees holds at the site), for whoever places or changes holds there.
  'GET /quality/holds/people': { audiences: ['office'], permission: 'quality.holds.place', scope: 'record' },
  // B-W2b-17: who releases a hold, as a setting (read with holds.view; changed with quality.settings.manage, checked in
  // the handler over the company: the route's permission is the read's).
  'GET /quality/holds/settings': { audiences: ['office'], permission: 'quality.holds.view', scope: 'record' },
  'PUT /quality/holds/settings': { audiences: ['office'], permission: 'quality.settings.manage', scope: 'record' },
  'GET /quality/holds/:holdId': { audiences: ['office'], permission: 'quality.holds.view', scope: 'record' },
  'POST /quality/holds/preview': { audiences: ['office'], permission: 'quality.holds.place', scope: 'record' },
  'POST /quality/holds': { audiences: ['office'], permission: 'quality.holds.place', scope: 'record' },
  'PATCH /quality/holds/:holdId': { audiences: ['office'], permission: 'quality.holds.place', scope: 'record' },
  'POST /quality/holds/:holdId/release': { audiences: ['office'], permission: 'quality.holds.release', scope: 'record' },
})
