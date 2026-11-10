import { defineManifest } from '../../../core/manifest'

/**
 * Certificates in depth (B-W2b-255; PRD-282, PRD-286, PRD-287, PRD-290, QHS-106). Office only. The notified body directory
 * is tenant-wide: reading needs compliance.certificates.view in any grant, keeping it compliance.certificates.manage over
 * every company (the handlers check it, 403 in words). A certificate's depth follows W1's register: view or manage over
 * the certificate's company and holder party (`record`: checked per certificate with can()).
 */
export const manifest = defineManifest({
  'GET /compliance/notified-bodies': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/notified-bodies/:bodyId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/notified-bodies': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'tenant' },
  'PATCH /compliance/notified-bodies/:bodyId': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'tenant' },
  'GET /compliance/certificates/:certificateId/depth': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'PUT /compliance/certificates/:certificateId/notified-body': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'PUT /compliance/certificates/:certificateId/levels': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'PUT /compliance/certificates/:certificateId/base': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'PUT /compliance/certificates/:certificateId/coverage/:coverageId/supplier': { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' },
  'GET /compliance/bought-in': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
})
