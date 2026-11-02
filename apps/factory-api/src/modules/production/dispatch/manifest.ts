import { defineManifest } from '../../../core/manifest'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021): read from the site's current published version of the plan.
 * The office reads a line's, work centre's or station's list with workorders.view, checked on the lane's site with can()
 * (`record`); a floor device reads its own station's with floor.work, at its own site (`site`; row-level security shows
 * the floor only PUBLISHED plans, Owner answer P3).
 *
 * B-W2b-49 (dispatch every shift; MES-022, -023, -025 … -028, -031 … -033): the board (office, production.dispatch.view), who
 * can take the work and assigning (dispatch.manage, office and the team leader's tablet), moving work (office only: the
 * floor role deletes no row), My work (floor.work, their own), the line view, handover notes, the printed list. Handlers
 * check each site, line and station with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/dispatch': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/dispatch/station': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /production/dispatch/board': { audiences: ['office'], permission: 'production.dispatch.view', scope: 'record' },
  'GET /production/dispatch/operators': { audiences: ['office', 'floor'], permission: 'production.dispatch.manage', scope: 'record' },
  'POST /production/dispatch/assignments': { audiences: ['office', 'floor'], permission: 'production.dispatch.manage', scope: 'record' },
  'POST /production/dispatch/assignments/:assignmentId/reassign': { audiences: ['office', 'floor'], permission: 'production.dispatch.manage', scope: 'record' },
  'POST /production/dispatch/assignments/:assignmentId/remove': { audiences: ['office'], permission: 'production.dispatch.manage', scope: 'record' },
  'POST /production/dispatch/moves': { audiences: ['office'], permission: 'production.dispatch.manage', scope: 'record' },
  'GET /production/dispatch/mine': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /production/dispatch/floor/line': { audiences: ['floor'], permission: 'production.dispatch.view', scope: 'record' },
  'GET /production/dispatch/handover': { audiences: ['office', 'floor'], permission: 'production.dispatch.view', scope: 'record' },
  'POST /production/dispatch/handover': { audiences: ['office', 'floor'], permission: 'production.dispatch.handover', scope: 'record' },
  'GET /production/dispatch/handover/new': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /production/dispatch/print': { audiences: ['office', 'floor'], permission: 'production.dispatch.view', scope: 'record' },
  'GET /production/dispatch/print/paper': { audiences: ['office', 'floor'], permission: 'production.dispatch.view', scope: 'record' },
})
