import { defineManifest } from '../../../core/manifest'

/**
 * The AQL engine and profiles (B-W2b-93; QHS-013, QHS-020, QHS-021; design quality.plans "AQL profiles", "AQL calculator",
 * quality.inspections "Sample & AQL"). Profiles and assignments are a company's: the handlers check each with can() over
 * its company (`record`), lists use scopeWhere(). The calculator is any company's (no record). A work order's plan and an
 * inspection's Sample & AQL are the final inspection's own reads and writes (quality.inspections.view | record), office
 * and the site's bench alike (can() pins a floor device to its site, row-level security too).
 */
export const manifest = defineManifest({
  'GET /quality/aql/profiles': { audiences: ['office'], permission: 'quality.aql.view', scope: 'record' },
  'POST /quality/aql/profiles': { audiences: ['office'], permission: 'quality.aql.manage', scope: 'record' },
  'PATCH /quality/aql/profiles/:profileId': { audiences: ['office'], permission: 'quality.aql.manage', scope: 'record' },
  'GET /quality/aql/assignments': { audiences: ['office'], permission: 'quality.aql.view', scope: 'record' },
  'POST /quality/aql/assignments': { audiences: ['office'], permission: 'quality.aql.manage', scope: 'record' },
  'POST /quality/aql/assignments/:assignmentId/end': { audiences: ['office'], permission: 'quality.aql.manage', scope: 'record' },
  'GET /quality/aql/resolve': { audiences: ['office'], permission: 'quality.aql.view', scope: 'record' },
  'GET /quality/aql/calculate': { audiences: ['office'], permission: 'quality.aql.view', scope: 'record' },
  'GET /quality/aql/work-orders/:workOrderId/plan': { audiences: ['office', 'floor'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/aql/inspections/:inspectionId': { audiences: ['office', 'floor'], permission: 'quality.inspections.view', scope: 'record' },
  'POST /quality/aql/inspections/:inspectionId/profile': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
})
