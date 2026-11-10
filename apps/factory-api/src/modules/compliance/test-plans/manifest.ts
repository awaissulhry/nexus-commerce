import { defineManifest } from '../../../core/manifest'

/**
 * Test plan rules and the substance tests' results (B-W2b-256; PRD-309; design compliance.tests "Test plan rules (W2b)",
 * Record test result). Office only. The rules: reading needs the certificate register's view permission in any grant
 * (`tenant`), keeping them compliance.substances.manage over the rule's company (the handlers check it, 403 in words). The
 * lots: their due tests read with W1's quality.lots.view and a result recorded with quality.lots.test over the lot's
 * company and site (`record`: the handlers check the lot, as W1's lot routes).
 */
export const manifest = defineManifest({
  'GET /compliance/test-plans': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/test-plans': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'PATCH /compliance/test-plans/:planId': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'PUT /compliance/test-plans/:planId/switch': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'GET /compliance/test-plans/due': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'GET /compliance/test-plans/lots/:lotId': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'POST /compliance/test-plans/lots/:lotId/report': { audiences: ['office'], permission: 'quality.lots.test', scope: 'record' },
  'POST /compliance/test-plans/lots/:lotId/results': { audiences: ['office'], permission: 'quality.lots.test', scope: 'record' },
})
