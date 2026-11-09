import { defineManifest } from '../../../core/manifest'

/**
 * SMV governance and the routing's times (B-W2b-215; design products.operations › Minutes, "Propose SMV change", the "SMV
 * changes waiting for approval" tile; products.styles › Operations (routing) set-up / run / wait / move and extra minutes
 * per size). Office only: the floor reads its work order's operations, never the library's governance. An operation or a
 * style belongs to one company or to every company, so each handler checks it with can() and filters lists with
 * scopeWhere() (`record`). Reading is product.routing.view; proposing product.smv.propose; deciding product.smv.approve
 * (never one's own proposal); a draft step's minutes product.routing.manage.
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const propose = { audiences: ['office'], permission: 'product.smv.propose', scope: 'record' } as const
const approve = { audiences: ['office'], permission: 'product.smv.approve', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.routing.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/operations/:operationId/minutes': view,
  'POST /product/operations/:operationId/minutes/proposals': propose,
  'POST /product/operations/:operationId/minutes/versions/:versionId/approve': approve,
  'POST /product/operations/:operationId/minutes/versions/:versionId/reject': approve,
  'GET /product/minutes/waiting': view,
  'GET /product/styles/:styleId/revisions/:revisionId/routing/times': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/minutes': manage,
})
