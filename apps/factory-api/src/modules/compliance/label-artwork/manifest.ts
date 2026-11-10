import { defineManifest } from '../../../core/manifest'

/**
 * Label artwork, label lines in the BOM and the label reconciliation (B-W2b-259; PRD-347, PRD-088, MES-140). Handlers check
 * each record with can() (`record`):
 *   - a label revision's artwork versions: read with the label's view (the certificate register's) over the label's company;
 *     add a draft proof, retire one, remove a draft with compliance.labels.manage; approve with compliance.artwork.approve
 *     (a person other than the author; the database refuses the author too);
 *   - a draft style revision's label and packaging lines made by the rules: read with product.bom.view, refresh with
 *     product.bom.manage over the style's company (W1's BOM rule);
 *   - a work order's label reconciliation and Log spoiled labels: the floor device of its site and the office with
 *     production.serials (the garment label step's permission, as W1's label routes; the floor: its own site only, a write
 *     with an Idempotency-Key).
 */
export const manifest = defineManifest({
  'GET /compliance/label-artwork/templates/:templateId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/label-artwork/templates/:templateId/versions': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'POST /compliance/label-artwork/versions/:artworkId/approve': { audiences: ['office'], permission: 'compliance.artwork.approve', scope: 'record' },
  'POST /compliance/label-artwork/versions/:artworkId/retire': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'DELETE /compliance/label-artwork/versions/:artworkId': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'GET /product/styles/:styleId/revisions/:revisionId/bom/label-lines': { audiences: ['office'], permission: 'product.bom.view', scope: 'record' },
  'POST /product/styles/:styleId/revisions/:revisionId/bom/label-lines/refresh': { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' },
  'GET /production/serials/work-orders/:workOrderId/reconciliation': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'POST /production/serials/work-orders/:workOrderId/spoiled': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
})
