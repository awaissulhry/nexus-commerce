import { defineManifest } from '../../../core/manifest'

/**
 * The operation library's routes (A2 SCR-049 "Libraries: operations"). Office only: the floor reads the operations it
 * scans through its work order (B-W1-38, B-W1-42), never this library. An operation belongs to one company or to every
 * company of the tenant, so each handler checks it with can() and filters the list with scopeWhere() (`record`). Reading
 * comes with product.routing.view; writing is product.operations.manage (its minutes feed every new routing).
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.operations.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/operations': view,
  'GET /product/operations/:operationId': view,
  'POST /product/operations': manage,
  'PATCH /product/operations/:operationId': manage,
  'POST /product/operations/:operationId/archive': manage,
  'POST /product/operations/:operationId/reactivate': manage,
})
