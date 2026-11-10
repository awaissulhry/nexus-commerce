import { defineManifest } from '../../../core/manifest'

/**
 * Economic operators per style and market (B-W2b-249; PRD-298; design compliance.settings › rm-operators). Office only.
 * Reading needs the certificate register's view permission in any grant (the rows of the companies it reaches and every
 * company's); keeping a row needs compliance.rules.manage over its company (every company for a row of every company;
 * the handlers check it, 403 in words).
 */
export const manifest = defineManifest({
  'GET /compliance/rules/operators': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/rules/operators/resolve': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/rules/operators': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'GET /compliance/rules/operators/:operatorId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/rules/operators/:operatorId': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
})
