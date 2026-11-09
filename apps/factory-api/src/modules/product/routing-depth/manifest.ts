import { defineManifest } from '../../../core/manifest'

/**
 * A routing in depth (B-W2b-225; PRD-118, PRD-119, PRD-124, PRD-128; design products.operations › Machine & settings,
 * products.styles › Operations (routing) "Quality checkpoint", "Only for sizes, colours or options", the operation drawer's
 * variants; the tablet's settings beside the instruction). No new permission: the routing's (product.routing.view |
 * manage), the library's (product.operations.manage), the work orders' (workorders.view) and the floor's scan
 * (production.scan at its own site). A style, an operation and a work order belong to a company (a style or an operation
 * may be every company's), so each handler checks the record with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.routing.manage', scope: 'record' } as const
const library = { audiences: ['office'], permission: 'product.operations.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/routing/depth': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/variants': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/checkpoint': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/settings': manage,
  'GET /product/styles/:styleId/routing/effectivity': view,
  'GET /product/operations/:operationId/settings': view,
  'PUT /product/operations/:operationId/settings': library,
  'GET /production/work-orders/:workOrderId/routing': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/operations/:operationId/settings': { audiences: ['office', 'floor'], permission: 'production.scan', scope: 'record' },
})
