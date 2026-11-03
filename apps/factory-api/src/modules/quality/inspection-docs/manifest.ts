import { defineManifest } from '../../../core/manifest'

/**
 * The quality documents for a customer (B-W2b-123; QHS-055 inspection report PDF and share link, QHS-059 certificate of
 * conformity per shipment). Office only: reading is the record's own view (quality.inspections.view for an inspection,
 * shipping.view for a shipment), keeping a version quality.documents.make, putting it on a shipment's documents link
 * quality.documents.share (mailing that link: shipping.manage, checked in the handler). Handlers check each record with
 * can() over its company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /quality/inspections/:inspectionId/report': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/inspections/:inspectionId/reports': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'POST /quality/inspections/:inspectionId/reports': { audiences: ['office'], permission: 'quality.documents.make', scope: 'record' },
  'POST /quality/inspections/:inspectionId/reports/share': { audiences: ['office'], permission: 'quality.documents.share', scope: 'record' },
  'GET /quality/shipments/:shipmentId/certificate': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /quality/shipments/:shipmentId/certificates': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /quality/shipments/:shipmentId/certificates': { audiences: ['office'], permission: 'quality.documents.make', scope: 'record' },
  'POST /quality/shipments/:shipmentId/certificates/share': { audiences: ['office'], permission: 'quality.documents.share', scope: 'record' },
})
