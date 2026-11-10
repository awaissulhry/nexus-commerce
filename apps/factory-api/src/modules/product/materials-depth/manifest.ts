import { defineManifest } from '../../../core/manifest'

/**
 * Materials in depth (B-W2b-238; PRD-029, PRD-033, PRD-035, PRD-036; design products.materials): office only. A material
 * belongs to one company or to every company, so each handler checks it with can() over its company (`record`), as W1's
 * material routes. Reading is the library's product.materials.view; the typed properties are W1's product.materials.manage;
 * a decision on the approval is product.materials.approve. The style's material approvals read the BOM
 * (product.bom.view over the style's company).
 */
const view = { audiences: ['office'], permission: 'product.materials.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/materials/:materialId/depth': view,
  'GET /product/materials/:materialId/where-used': view,
  'PUT /product/materials/:materialId/properties': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'PUT /product/materials/:materialId/approval': { audiences: ['office'], permission: 'product.materials.approve', scope: 'record' },
  'GET /product/styles/:styleId/revisions/:revisionId/material-approvals': { audiences: ['office'], permission: 'product.bom.view', scope: 'record' },
})
