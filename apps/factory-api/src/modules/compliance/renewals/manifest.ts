import { defineManifest } from '../../../core/manifest'

/**
 * The Renewals tab's routes (B-W2a-66; QHS-105, PRD-283). Office only; a certificate belongs to its company (none: a
 * brand's, every company) and its holder party, so the handlers check each one with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /compliance/certificates/:certificateId/renewals': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/certificates/:certificateId/renewals/start': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/renewals/applied': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/renewals/successor': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
})
