import { defineManifest } from '../../../core/manifest'

/**
 * The DoC generator (B-W2b-257; PRD-292, PRD-293, PRD-295, PRD-300; design compliance.declarations). Office only. Reading the
 * declarations, their sources, the language coverage and the versions by batch needs the certificate register's view
 * permission in any grant (the handlers keep staff to the companies their grants reach); generating, translating and
 * withdrawing a draft needs compliance.declarations.generate over the document's company (every company for a document of
 * every company), checking a translation compliance.declarations.check, recording a batch W1's compliance.declarations.manage.
 * The shipment compliance pack is the shipment's: shipping.view to read it, compliance.declarations.pack to build it, both
 * checked on the shipment's company, site and party (`record`).
 */
export const manifest = defineManifest({
  'GET /compliance/declarations': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/declarations/coverage': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/declarations/preview': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/declarations': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'GET /compliance/declarations/batches': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/declarations/batches': { audiences: ['office'], permission: 'compliance.declarations.manage', scope: 'tenant' },
  'GET /compliance/declarations/batches/unrecorded': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/declarations/shipments/:shipmentId/versions': { audiences: ['office'], permission: 'compliance.declarations.manage', scope: 'tenant' },
  'GET /compliance/declarations/shipments/:shipmentId/pack': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /compliance/declarations/shipments/:shipmentId/pack': { audiences: ['office'], permission: 'compliance.declarations.pack', scope: 'record' },
  'GET /compliance/declarations/shipments/:shipmentId/pack/:documentId/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /compliance/declarations/shipments/:shipmentId/pack/:documentId/zip': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /compliance/declarations/:documentId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/declarations/:documentId/pdf': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/declarations/:documentId': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'POST /compliance/declarations/:documentId/refresh': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'POST /compliance/declarations/:documentId/withdraw': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'POST /compliance/declarations/:documentId/translations': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'POST /compliance/declarations/:documentId/translation-state': { audiences: ['office'], permission: 'compliance.declarations.generate', scope: 'tenant' },
  'POST /compliance/declarations/:documentId/check': { audiences: ['office'], permission: 'compliance.declarations.check', scope: 'tenant' },
})
