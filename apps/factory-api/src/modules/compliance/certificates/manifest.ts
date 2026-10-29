import { defineManifest } from '../../../core/manifest'

/**
 * The certificate register's routes (QHS-103, QHS-051, PRD-288; Reg. (EU) 2016/425). Office only. A certificate belongs
 * to its company (none: brand-held, every company) and its holder party, so the handlers check each one with can() and
 * filter lists with scopeWhere() (`record`); the gate checks compliance.certificates.view over the style's company.
 */
export const manifest = defineManifest({
  'GET /compliance/certificates': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/certificates/:certificateId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/certificates': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'PATCH /compliance/certificates/:certificateId': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/issue': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/suspend': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/reinstate': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/withdraw': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/coverage': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/coverage/:coverageId/archive': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/gate': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/certificates/:certificateId/pdf': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'POST /compliance/certificates/:certificateId/pdf/:fileId/complete': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
})
