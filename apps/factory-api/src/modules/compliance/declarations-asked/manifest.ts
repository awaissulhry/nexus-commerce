import { defineManifest } from '../../../core/manifest'

/**
 * Declarations asked of suppliers (B-W2b-256; PRD-304; design compliance.tests › Supplier declarations). Office only.
 * Reading needs the certificate register's view permission in any grant (`tenant`: the handlers keep staff to the requests
 * of their companies; one they may not read is "not found"); every write needs compliance.supplierDeclarations.manage
 * over the request's company, which the handlers check (403 in words). Accepting a portal answer whose upload still waits
 * also needs B-W2b-189's purchasing.supplierDocuments.review (the document is accepted first).
 */
export const manifest = defineManifest({
  'GET /compliance/declarations-asked': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/declarations-asked': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'GET /compliance/declarations-asked/:requestId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/remind': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/answer': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'PUT /compliance/declarations-asked/:requestId/lines': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/accept': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/refuse': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/cancel': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
  'POST /compliance/declarations-asked/:requestId/ask-again': { audiences: ['office'], permission: 'compliance.supplierDeclarations.manage', scope: 'tenant' },
})
