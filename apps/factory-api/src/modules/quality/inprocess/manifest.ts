import { defineManifest } from '../../../core/manifest'

/**
 * In-process checks (B-W2b-99; QHS-039 first piece, QHS-040 cutting, QHS-041 roving, QHS-042 end of line and DHU, MES-127 a
 * defect charged to its operation; design floor.inline SCR-176). The office and the site's floor devices (their own site
 * only: can() pins them, row-level security too) read with quality.inprocess.view and record with quality.inprocess.record;
 * handlers check each check, work order or line with can() over its company and site (`record`). The first-piece flag is
 * the operation screen's: any operator's (production.scan). The worker's own charges are theirs (floor.work), per worker only
 * behind the site's PERFORMANCE gate.
 */
export const manifest = defineManifest({
  'GET /quality/inprocess/checks': { audiences: ['office', 'floor'], permission: 'quality.inprocess.view', scope: 'record' },
  'GET /quality/inprocess/checks/:checkId': { audiences: ['office', 'floor'], permission: 'quality.inprocess.view', scope: 'record' },
  'POST /quality/inprocess/checks': { audiences: ['office', 'floor'], permission: 'quality.inprocess.record', scope: 'record' },
  'PUT /quality/inprocess/checks/:checkId/results': { audiences: ['office', 'floor'], permission: 'quality.inprocess.record', scope: 'record' },
  'POST /quality/inprocess/checks/:checkId/decide': { audiences: ['office', 'floor'], permission: 'quality.inprocess.record', scope: 'record' },
  'POST /quality/inprocess/checks/:checkId/cancel': { audiences: ['office', 'floor'], permission: 'quality.inprocess.record', scope: 'record' },
  'GET /quality/inprocess/dhu': { audiences: ['office', 'floor'], permission: 'quality.inprocess.view', scope: 'record' },
  'GET /quality/inprocess/roving': { audiences: ['office', 'floor'], permission: 'quality.inprocess.view', scope: 'record' },
  'GET /quality/inprocess/first-piece': { audiences: ['office', 'floor'], permission: 'production.scan', scope: 'record' },
  'GET /quality/inprocess/charges': { audiences: ['office'], permission: 'quality.inprocess.view', scope: 'record' },
  'GET /quality/inprocess/floor/mine': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
