import { defineManifest } from '../../../core/manifest'

/**
 * Spec versions (B-W2b-220; PRD-085, PRD-166, PRD-167, PRD-168, PRD-194, PRD-195; design products.styles › Versions &
 * changes "Revisions", "Compare revisions", "Orders on older revisions"; the work order's "Compare with the current master";
 * floor.instructions and floor.operation "Spec changed"). Reads only, no new permission: the BOM's (product.bom.view) for a
 * style's revisions, compare and drift (each drift row also asks quotes.view / orders.view over its record; every cost the
 * cost grain), the work orders' (workorders.view) for a work order's spec, and the floor's scan (production.scan, a device
 * at its own site) for the tablet's banner. A style and a work order belong to a company (a style may be every company's),
 * so each handler checks the record with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/versions': view,
  'GET /product/styles/:styleId/versions/compare': view,
  'GET /product/styles/:styleId/versions/drift': view,
  'GET /production/work-orders/:workOrderId/spec/versions': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/spec/newer': { audiences: ['floor', 'office'], permission: 'production.scan', scope: 'record' },
})
