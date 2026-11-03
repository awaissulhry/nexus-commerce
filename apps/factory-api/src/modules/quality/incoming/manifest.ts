import { defineManifest } from '../../../core/manifest'

/**
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025, QHS-028, QHS-034, MES-054; design floor.incoming
 * SCR-175, quality.inspections "Incoming"): the office and the site's inspection tablets (their own site only: can() pins
 * them, row-level security too). Handlers check each lot and inspection with can() over its company and site (`record`);
 * the list uses scopeWhere(). Releasing or rejecting the lot stays modules/quality/lab's (Owner answer W3).
 */
export const manifest = defineManifest({
  'GET /quality/incoming': { audiences: ['office', 'floor'], permission: 'quality.incoming.view', scope: 'record' },
  'GET /quality/incoming/lots/:lotId': { audiences: ['office', 'floor'], permission: 'quality.incoming.view', scope: 'record' },
  'POST /quality/incoming': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
  'GET /quality/incoming/:inspectionId': { audiences: ['office', 'floor'], permission: 'quality.incoming.view', scope: 'record' },
  'PUT /quality/incoming/:inspectionId/hides/:hideId': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
  'DELETE /quality/incoming/:inspectionId/hides/:hideId': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
  'PUT /quality/incoming/:inspectionId/results': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
  'POST /quality/incoming/:inspectionId/decide': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
  'POST /quality/incoming/:inspectionId/cancel': { audiences: ['office', 'floor'], permission: 'quality.incoming.record', scope: 'record' },
})
