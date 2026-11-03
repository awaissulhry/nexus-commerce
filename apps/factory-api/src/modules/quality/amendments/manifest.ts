import { defineManifest } from '../../../core/manifest'

/**
 * Locked results with amendments (B-W2b-123; QHS-145; design quality.inspections ins-amend, dec-amend). Office only: a
 * record's corrections are read with the record's own view permission (a final inspection, an incoming inspection, an
 * in-process check); asking is quality.amendments.request, answering quality.amendments.sign (signing with a fresh code).
 * Handlers check each record with can() over its company and site (`record`); the queue lists only records the caller sees.
 */
export const manifest = defineManifest({
  'GET /quality/inspections/:inspectionId/amendments': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'POST /quality/inspections/:inspectionId/amendments': { audiences: ['office'], permission: 'quality.amendments.request', scope: 'record' },
  'GET /quality/incoming/:inspectionId/amendments': { audiences: ['office'], permission: 'quality.incoming.view', scope: 'record' },
  'POST /quality/incoming/:inspectionId/amendments': { audiences: ['office'], permission: 'quality.amendments.request', scope: 'record' },
  'GET /quality/inprocess/checks/:checkId/amendments': { audiences: ['office'], permission: 'quality.inprocess.view', scope: 'record' },
  'POST /quality/inprocess/checks/:checkId/amendments': { audiences: ['office'], permission: 'quality.amendments.request', scope: 'record' },
  'GET /quality/amendments': { audiences: ['office'], permission: 'quality.amendments.sign', scope: 'record' },
  'POST /quality/amendments/:amendmentId/sign': { audiences: ['office'], permission: 'quality.amendments.sign', scope: 'record' },
  'POST /quality/amendments/:amendmentId/refuse': { audiences: ['office'], permission: 'quality.amendments.sign', scope: 'record' },
})
