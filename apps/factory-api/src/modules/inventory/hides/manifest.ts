import { defineManifest } from '../../../core/manifest'

/**
 * Hides as stock (B-W2b-94; PRD-031, SCM-249, SCM-250, SCM-258; design warehouse.hides record "Measurements & grade",
 * products.materials "Grades and usable area"). Office only. A hide's scope is its lot's company and site (the handlers
 * check it with can()); an article's grades are the material's (its company; a material for every company needs a grant
 * over every company to change). Correcting a hide's stock with a measure also needs inventory.adjust (the handler).
 */
export const manifest = defineManifest({
  'GET /product/materials/:materialId/grades': { audiences: ['office'], permission: 'product.materials.view', scope: 'record' },
  'POST /product/materials/:materialId/grades': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'PATCH /product/materials/:materialId/grades/:ruleId': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
  'GET /inventory/hides/:hideId/grading': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'PATCH /inventory/hides/:hideId/grading': { audiences: ['office'], permission: 'inventory.hides.manage', scope: 'record' },
  'GET /inventory/hides/:hideId/measures': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/hides/:hideId/measures': { audiences: ['office'], permission: 'inventory.hides.manage', scope: 'record' },
  'GET /inventory/lots/:lotId/area-check': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/leather/grade-mix': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  // B-W2b-131 (SCM-285): the leather dashboard's own reads (./dashboard.ts); photos also need files.read (the handler).
  'GET /inventory/leather/dashboard': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/leather/photos': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
