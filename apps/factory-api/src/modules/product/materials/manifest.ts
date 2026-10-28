import { defineManifest } from '../../../core/manifest'

/**
 * The material library's routes (A2 SCR-047, SCR-048). Office only: the floor reads the materials it works with through
 * its work orders' frozen specification (later steps), never this library and never a cost. A material belongs to one
 * company or to every company of the tenant, so each handler checks it with can() and filters the list with
 * scopeWhere() (`record`). The standard cost has its own route and permission (product.materials.cost), and the cost
 * grain to send it or see it.
 */
export const manifest = defineManifest({
  'GET /product/materials': { audiences: ['office'], permission: 'product.materials.view', scope: 'record' },
  'GET /product/materials/:materialId': { audiences: ['office'], permission: 'product.materials.view', scope: 'record' },
  'POST /product/materials': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'PATCH /product/materials/:materialId': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'POST /product/materials/:materialId/archive': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'POST /product/materials/:materialId/reactivate': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'PUT /product/materials/:materialId/standard-cost': { audiences: ['office'], permission: 'product.materials.cost', scope: 'record' },
  'POST /product/materials/:materialId/colours': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'PATCH /product/materials/:materialId/colours/:colourId': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
})
