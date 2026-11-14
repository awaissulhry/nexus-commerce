import { defineManifest } from '../../../core/manifest'

/**
 * The mass cost update (B-W2b-423; FIN-022; design finance.costing › "Mass cost update"). Office only: the floor, partner and
 * link sessions never see a cost (A1 §2.6). The preview is costing.view (each series, entry and order the caller's companies
 * hold; figures by grain); applying is costing.massUpdate.apply with a fresh code (step-up: the money settings line of Admin ›
 * Security) and, checked in the handler (`record`), product.materials.cost and costing.sheets.manage over every company it
 * touches.
 */
export const manifest = defineManifest({
  'POST /costing/mass-updates/preview': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
  'POST /costing/mass-updates/apply': { audiences: ['office'], permission: 'costing.massUpdate.apply', scope: 'record' },
})
